const createRingBuffer = require("../utils/ring-buffer").createRingBuffer;
const shortHash = require("../utils/hash").shortHash;
const mask = require("./mask").mask;
const suggestTemplate = require("./mask").suggestTemplate;

const FIRST_EXAMPLES = 2;
const LABEL_VALUES_CAP = 20;
const SPARK_MINUTES = 60;

/*
 * The unclassified queue (SPEC.md §6). Invariant: it only ever contains
 * records that no current classifier matches. The engine removes records the
 * moment a definition absorbs them.
 */

/**
 * @param {{ bufferSize: number, maxClusters: number, examples: number }} options
 */
const createClusterer = (options) => {
	const clusters = new Map();
	const counters = {
		total: 0,
		evictedRecords: 0,
		evictedClusters: 0
	};

	const buffer = createRingBuffer(options.bufferSize, {
		onEvict: (record) => {
			counters.evictedRecords++;
			const cluster = clusters.get(record.clusterId);

			if (cluster) {
				cluster.buffered--;
			}
		}
	});

	const touch = (cluster) => {
		clusters.delete(cluster.id);
		clusters.set(cluster.id, cluster);
	};

	const evictClusters = () => {
		while (clusters.size > options.maxClusters) {
			const oldest = clusters.keys().next().value;
			const cluster = clusters.get(oldest);
			clusters.delete(oldest);
			counters.evictedClusters++;

			buffer.toArray().forEach((record) => {
				if (record.clusterId === cluster.id) {
					buffer.remove(record);
				}
			});
		}
	};

	const bump = (map, key, n) => {
		map[key] = (map[key] || 0) + n;
	};

	const exampleOf = (record) => {
		const out = { t: record.t, source: record.source, raw: record.raw };

		if (record.envelope) {
			out.body = record.body;
		}

		return out;
	};

	const clusterer = {
		/**
		 * Add an unclassified record.
		 * record: { raw, t, source, labels, envelope?: { name, path, fields }, body?: string }
		 * @returns {{ cluster: object, isNew: boolean }}
		 */
		add: (record) => {
			const text = record.envelope ? (record.body || "") : record.raw;
			const masked = mask(text);
			const envelopeName = record.envelope ? record.envelope.name : "";
			const key = envelopeName + "\u0001" + masked.shape;
			const id = shortHash(key);
			let cluster = clusters.get(id);
			const isNew = !cluster;

			if (!cluster) {
				cluster = {
					id,
					key,
					shape: masked.shape,
					envelope: envelopeName || null,
					count: 0,
					buffered: 0,
					first_seen: record.t,
					last_seen: record.t,
					sources: {},
					labels: {},
					firstExamples: [],
					recentExamples: [],
					spark: new Map(),
					notifiedCount: 0
				};
			}

			cluster.count++;
			cluster.buffered++;
			cluster.last_seen = Math.max(cluster.last_seen, record.t);
			cluster.first_seen = Math.min(cluster.first_seen, record.t);
			bump(cluster.sources, record.source, 1);

			Object.keys(record.labels || {}).forEach((label) => {
				const values = cluster.labels[label] || (cluster.labels[label] = {});
				const value = String(record.labels[label]);

				if (values[value] !== undefined || Object.keys(values).length < LABEL_VALUES_CAP) {
					bump(values, value, 1);
				}
			});

			const minute = Math.floor(record.t / 60000);
			cluster.spark.set(minute, (cluster.spark.get(minute) || 0) + 1);

			if (cluster.spark.size > SPARK_MINUTES) {
				cluster.spark.delete(cluster.spark.keys().next().value);
			}

			if (cluster.firstExamples.length < FIRST_EXAMPLES) {
				cluster.firstExamples.push(exampleOf(record));
			} else {
				cluster.recentExamples.push(exampleOf(record));

				if (cluster.recentExamples.length > Math.max(1, options.examples - FIRST_EXAMPLES)) {
					cluster.recentExamples.shift();
				}
			}

			const stored = Object.assign({}, record, { clusterId: id });
			buffer.push(stored);
			counters.total++;
			touch(cluster);
			evictClusters();

			return { cluster, isNew };
		},

		/**
		 * Remove records that a definition absorbed.
		 * @returns {Array<{ id: string, matched: number, remaining: number, backlog: number, deleted: boolean }>}
		 */
		absorb: (records) => {
			const perCluster = new Map();

			records.forEach((record) => {
				buffer.remove(record);
				const cluster = clusters.get(record.clusterId);

				if (!cluster) {
					return;
				}

				cluster.count--;
				cluster.buffered--;
				perCluster.set(cluster.id, (perCluster.get(cluster.id) || 0) + 1);
			});

			return Array.from(perCluster.entries()).map((pair) => {
				const cluster = clusters.get(pair[0]);
				const deleted = cluster.buffered <= 0;
				const backlog = deleted ? Math.max(0, cluster.count) : 0;

				if (deleted) {
					clusters.delete(cluster.id);
				}

				return { id: cluster.id, shape: cluster.shape, matched: pair[1], remaining: deleted ? 0 : cluster.count, backlog, deleted };
			});
		},

		/** All buffered records, oldest first. */
		records: () => {
			return buffer.toArray();
		},

		recordsOf: (clusterId) => {
			return buffer.toArray().filter((record) => {
				return record.clusterId === clusterId;
			});
		},

		get: (id) => {
			return clusters.get(id) || null;
		},

		all: () => {
			return Array.from(clusters.values());
		},

		/** Public view of a cluster. */
		describe: (cluster, extraExamples) => {
			const examples = cluster.firstExamples.concat(cluster.recentExamples);
			const extra = extraExamples ? clusterer.recordsOf(cluster.id).slice(-extraExamples).map(exampleOf) : [];
			const exampleTexts = examples.map((example) => {
				return example.body !== undefined ? example.body : example.raw;
			});
			const now = Math.floor(Date.now() / 60000);
			const spark = [];

			for (let minute = now - 29; minute <= now; minute++) {
				spark.push(cluster.spark.get(minute) || 0);
			}

			return {
				id: cluster.id,
				count: cluster.count,
				shape: cluster.shape,
				envelope: cluster.envelope,
				first_seen: new Date(cluster.first_seen).toISOString(),
				last_seen: new Date(cluster.last_seen).toISOString(),
				sources: cluster.sources,
				labels: cluster.labels,
				buffered: cluster.buffered,
				spark_30m: spark,
				suggested_template: suggestTemplate(cluster.shape, exampleTexts),
				examples: extraExamples ? extra : examples
			};
		},

		/**
		 * @param {{ sort?: "count"|"recent"|"new", limit?: number, since?: number, source?: string,
		 *   min_count?: number, envelope?: string, test?: function(object): boolean }} query
		 */
		list: (query) => {
			const q = query || {};
			const sorters = {
				count: (a, b) => {
					return b.count - a.count;
				},
				recent: (a, b) => {
					return b.last_seen - a.last_seen;
				},
				"new": (a, b) => {
					return b.first_seen - a.first_seen;
				}
			};

			return clusterer.all()
				.filter((cluster) => {
					if (q.since && cluster.last_seen < q.since) {
						return false;
					}

					if (q.source && !cluster.sources[q.source]) {
						return false;
					}

					if (q.min_count && cluster.count < q.min_count) {
						return false;
					}

					if (q.envelope && cluster.envelope !== q.envelope) {
						return false;
					}

					return !q.test || q.test(cluster);
				})
				.sort(sorters[q.sort || "count"] || sorters.count);
		},

		stats: () => {
			return {
				clusters: clusters.size,
				buffered: buffer.length(),
				pending: clusterer.all().reduce((acc, cluster) => {
					return acc + cluster.count;
				}, 0),
				total_seen: counters.total,
				evicted_records: counters.evictedRecords,
				evicted_clusters: counters.evictedClusters
			};
		},

		clear: () => {
			clusters.clear();
			buffer.clear();
		}
	};

	return clusterer;
};

module.exports = {
	createClusterer
};
