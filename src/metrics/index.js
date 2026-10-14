const createRingBuffer = require("../utils/ring-buffer").createRingBuffer;
const createTopK = require("../utils/top-k").createTopK;
const createSketch = require("../utils/sketch").createSketch;

const RATE_WINDOW_S = 3600;
const LOW_CARDINALITY = 30;

/*
 * Event store + incremental all-time aggregates (SPEC.md §7).
 *
 * Events live in a ring buffer per leaf classifier, bounded globally by a
 * shared FIFO: when the total is exceeded the globally-oldest event is
 * evicted from its classifier's buffer. Aggregates are kept for every node in
 * an event's path and survive eviction.
 */

const createNodeStats = () => {
	return {
		count: 0,
		backlog: 0,
		first: null,
		last: null,
		perSecond: new Map(),
		fields: new Map()
	};
};

const createFieldAgg = (topKSize) => {
	return {
		present: 0,
		numeric: 0,
		sketch: createSketch(),
		terms: createTopK(topKSize)
	};
};

/**
 * @param {{ perClassifier: number, total: number, topK: number }} options
 */
const createMetrics = (options) => {
	const stores = new Map();
	const stats = new Map();
	const counters = { events: 0, evicted: 0, nextId: 1 };

	const global = createRingBuffer(options.total, {
		onEvict: (event) => {
			if (event.dead) {
				return;
			}

			event.dead = true;
			counters.evicted++;
			const store = stores.get(event.classifier);

			if (store) {
				store.remove(event);
			}
		}
	});

	const storeFor = (name) => {
		if (!stores.has(name)) {
			stores.set(name, createRingBuffer(options.perClassifier, {
				onEvict: (event) => {
					event.dead = true;
					counters.evicted++;
				}
			}));
		}

		return stores.get(name);
	};

	const statsFor = (name) => {
		if (!stats.has(name)) {
			stats.set(name, createNodeStats());
		}

		return stats.get(name);
	};

	const updateStats = (node, event) => {
		node.count++;
		node.first = node.first === null ? event.t : Math.min(node.first, event.t);
		node.last = node.last === null ? event.t : Math.max(node.last, event.t);

		const second = Math.floor(event.t / 1000);
		node.perSecond.set(second, (node.perSecond.get(second) || 0) + 1);

		if (node.perSecond.size > RATE_WINDOW_S) {
			const cutoff = Math.floor(Date.now() / 1000) - RATE_WINDOW_S;
			node.perSecond.forEach((_count, key) => {
				if (key < cutoff) {
					node.perSecond.delete(key);
				}
			});
		}

		Object.keys(event.fields).forEach((name) => {
			const value = event.fields[name];

			if (value === undefined || value === null) {
				return;
			}

			if (!node.fields.has(name)) {
				node.fields.set(name, createFieldAgg(options.topK));
			}

			const agg = node.fields.get(name);
			agg.present++;

			if (typeof value === "number") {
				agg.numeric++;
				agg.sketch.add(value);
			}

			if (Array.isArray(value)) {
				value.forEach((item) => {
					agg.terms.add(item);
				});
			} else {
				agg.terms.add(value);
			}
		});
	};

	const metrics = {
		/**
		 * Record a classified event. `store` is the leaf's store level.
		 * event: { t, source, labels, classifier, path, fields, raw? }
		 * @returns {object} the stored event (with id)
		 */
		record: (input, store, options) => {
			const event = Object.assign({ id: counters.nextId++ }, input);
			const alreadyCounted = options && options.alreadyCounted ? options.alreadyCounted : [];

			if (!alreadyCounted.length) {
				counters.events++;
			}

			event.path.forEach((name) => {
				if (alreadyCounted.indexOf(name) === -1) {
					updateStats(statsFor(name), event);
				}
			});

			if (store === "count") {
				return event;
			}

			if (store === "fields") {
				delete event.raw;
			}

			storeFor(event.classifier).push(event);
			global.push(event);
			return event;
		},

		/** Remove specific events (e.g. on reclassify / classifier removal). */
		removeEvents: (events) => {
			events.forEach((event) => {
				if (event.dead) {
					return;
				}

				event.dead = true;
				const store = stores.get(event.classifier);

				if (store) {
					store.remove(event);
				}
			});
		},

		/** Drop everything stored for these classifier names (events + aggregates). */
		dropClassifiers: (names) => {
			names.forEach((name) => {
				const store = stores.get(name);

				if (store) {
					store.forEach((event) => {
						event.dead = true;
					});
					stores.delete(name);
				}

				stats.delete(name);
			});
		},

		addBacklog: (name, n) => {
			statsFor(name).backlog += n;
		},

		/** Events of the given leaf/node names, oldest first per store, merged by time. */
		events: (names) => {
			const out = [];
			names.forEach((name) => {
				const store = stores.get(name);

				if (store) {
					store.forEach((event) => {
						out.push(event);
					});
				}
			});

			if (names.length > 1) {
				out.sort((a, b) => {
					return a.t - b.t;
				});
			}

			return out;
		},

		stats: (name) => {
			return stats.get(name) || null;
		},

		/** Rate over the last `seconds` (events/s). */
		rate: (name, seconds) => {
			const node = stats.get(name);

			if (!node) {
				return 0;
			}

			const cutoff = Math.floor(Date.now() / 1000) - seconds;
			let total = 0;
			node.perSecond.forEach((count, second) => {
				if (second > cutoff) {
					total += count;
				}
			});

			return total / seconds;
		},

		/** Per-minute counts for the last `minutes` minutes (sparkline). */
		spark: (name, minutes) => {
			const node = stats.get(name);
			const now = Math.floor(Date.now() / 60000);
			const buckets = new Array(minutes).fill(0);

			if (!node) {
				return buckets;
			}

			node.perSecond.forEach((count, second) => {
				const index = minutes - 1 - (now - Math.floor(second / 60));

				if (index >= 0 && index < minutes) {
					buckets[index] += count;
				}
			});

			return buckets;
		},

		/** Per-second aggregate counts (last hour) of one node, bucketed: works for store=count classifiers. */
		countSeries: (name, from, to, interval) => {
			const node = stats.get(name);
			const start = Math.floor(from / interval) * interval;
			const n = Math.max(1, Math.ceil((to - start + 1) / interval));
			const values = new Array(n).fill(0);

			if (node) {
				node.perSecond.forEach((count, second) => {
					const i = Math.floor((second * 1000 - start) / interval);

					if (i >= 0 && i < n) {
						values[i] += count;
					}
				});
			}

			return { times: values.map((_v, i) => {
				return start + i * interval;
			}), values };
		},

		/** Retained window of a node: oldest event still stored (across its store). */
		retained: (names) => {
			return names.reduce((acc, name) => {
				const store = stores.get(name);

				if (!store) {
					return acc;
				}

				const first = store.peek();
				return first ? Math.min(acc, first.t) : acc;
			}, Infinity);
		},

		storedCount: (names) => {
			return names.reduce((acc, name) => {
				const store = stores.get(name);
				return acc + (store ? store.length() : 0);
			}, 0);
		},

		/** All-time field aggregate (no filters) for one node. */
		fieldAggregate: (name, field, top) => {
			const node = stats.get(name);

			if (!node || !node.fields.has(field)) {
				return null;
			}

			const agg = node.fields.get(field);

			if (agg.numeric === agg.present && agg.numeric > 0) {
				const lowCardinality = agg.terms.distinct() <= LOW_CARDINALITY;
				return {
					kind: "numeric",
					approximate: true,
					stats: agg.sketch.summary(),
					values: lowCardinality ? agg.terms.top(top || 20).map((entry) => {
						return { value: Number(entry.value), count: entry.count };
					}) : undefined,
					buckets: lowCardinality ? undefined : agg.sketch.buckets()
				};
			}

			return {
				kind: "terms",
				approximate: true,
				total: agg.terms.total(),
				distinct_estimate: agg.terms.distinct(),
				values: agg.terms.top(top || 20).map((entry) => {
					return { value: entry.value, count: entry.count, max_overcount: entry.error || undefined };
				})
			};
		},

		fieldNames: (name) => {
			const node = stats.get(name);
			return node ? Array.from(node.fields.keys()) : [];
		},

		/** Seed for new_value alarms: all-time top values of a field. */
		knownValues: (name, field) => {
			const node = stats.get(name);

			if (!node || !node.fields.has(field)) {
				return [];
			}

			return node.fields.get(field).terms.top().map((entry) => {
				return entry.value;
			});
		},

		totals: () => {
			return {
				events: counters.events,
				stored: global.length(),
				evicted: counters.evicted
			};
		},

		clear: () => {
			stores.clear();
			stats.clear();
			global.clear();
		}
	};

	return metrics;
};

module.exports = {
	createMetrics
};
