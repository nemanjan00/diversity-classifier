const compute = require("../metrics/compute");
const compileWhere = require("../utils/filter").compileWhere;
const combineQuery = require("../utils/query").combine;
const parseTime = require("../utils/units").parseTime;
const parseDuration = require("../utils/units").parseDuration;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/*
 * Query layer (SPEC.md §7.3): resolves classifier selectors, time ranges and
 * q/where filters, then hands event arrays to metrics/compute.
 */

/**
 * @param {{ classifiers: object, metrics: object, clusterer: object }} parts
 */
const createQueries = (parts) => {
	const classifiers = parts.classifiers;
	const metrics = parts.metrics;
	const clusterer = parts.clusterer;

	const fieldTypesFor = (names) => {
		return names.reduce((acc, name) => {
			return Object.assign(acc, classifiers.fieldTypes(name));
		}, {});
	};

	const timeBounds = (args) => {
		const since = parseTime(args.since);
		const until = parseTime(args.until);

		if (args.since !== undefined && args.since !== null && args.since !== "" && since === undefined) {
			throw new Error("Cannot parse since: " + args.since);
		}

		if (args.until !== undefined && args.until !== null && args.until !== "" && until === undefined) {
			throw new Error("Cannot parse until: " + args.until);
		}

		return { since, until };
	};

	/**
	 * Select events by classifier selector, time range and q/where.
	 * @param {{ classifier?: string|string[], q?: string, where?: object, since?: *, until?: * }} args
	 */
	const select = (args) => {
		const a = args || {};
		const names = classifiers.resolve(a.classifier);

		if (a.classifier && names.length === 0) {
			throw new Error("No classifier matches '" + a.classifier + "'. Use list_classifiers.");
		}

		const bounds = timeBounds(a);
		const where = combineQuery(a.q, a.where);
		const test = compileWhere(where, { get: compute.getField, types: fieldTypesFor(names) });
		const events = metrics.events(names).filter((event) => {
			if (bounds.since !== undefined && event.t < bounds.since) {
				return false;
			}

			if (bounds.until !== undefined && event.t > bounds.until) {
				return false;
			}

			return test(event);
		});

		return { names, events, since: bounds.since, until: bounds.until, filtered: Object.keys(where).length > 0 };
	};

	const retainedInfo = (names) => {
		const retained = metrics.retained(names);
		return isFinite(retained) ? new Date(retained).toISOString() : null;
	};

	const queries = {
		select,

		search: (args) => {
			const a = args || {};
			const sel = select(a);
			const limit = Math.min(MAX_LIMIT, a.limit || DEFAULT_LIMIT);
			const offset = a.cursor ? parseInt(a.cursor, 10) || 0 : 0;
			const ordered = a.order === "asc" ? sel.events : sel.events.slice().reverse();
			const page = ordered.slice(offset, offset + limit);

			return {
				total: sel.events.length,
				retained_since: retainedInfo(sel.names),
				events: page.map((event) => {
					return compute.project(event, a.fields);
				}),
				next_cursor: offset + limit < ordered.length ? String(offset + limit) : null
			};
		},

		count: (args) => {
			return { total: select(args).events.length };
		},

		histogram: (args) => {
			const a = args || {};

			if (!a.field) {
				throw new Error("histogram needs a field");
			}

			const useAggregates = !a.q && !a.where && !a.since && !a.until && !a.group_by && !a.buckets && !a.bounds && a.exact !== true;

			if (useAggregates && a.classifier && classifiers.get(a.classifier)) {
				const agg = metrics.fieldAggregate(a.classifier, a.field, a.top);

				if (agg) {
					return Object.assign({ field: a.field, classifier: a.classifier, source: "all-time aggregates" }, agg);
				}
			}

			const sel = select(a);
			return Object.assign({ source: "retained events", retained_since: retainedInfo(sel.names) }, compute.histogram(sel.events, a.field, {
				buckets: a.buckets,
				bounds: a.bounds,
				top: a.top,
				group_by: a.group_by,
				group_top: a.group_top
			}));
		},

		timeseries: (args) => {
			const a = args || {};
			const sel = select(a);
			const interval = a.interval ? parseDuration(a.interval) : undefined;

			if (a.interval && !interval) {
				throw new Error("Cannot parse interval: " + a.interval);
			}

			return Object.assign({ retained_since: retainedInfo(sel.names) }, compute.timeseries(sel.events, {
				since: sel.since,
				until: sel.until,
				interval,
				agg: a.agg,
				field: a.field,
				split_by: a.split_by,
				top: a.top
			}));
		},

		heatmap: (args) => {
			const a = args || {};

			if (!a.field) {
				throw new Error("heatmap needs a numeric field");
			}

			const sel = select(a);
			const interval = a.interval ? parseDuration(a.interval) : undefined;
			return compute.heatmap(sel.events, a.field, {
				since: sel.since,
				until: sel.until,
				interval,
				buckets: a.buckets,
				scale: a.scale
			});
		},

		fieldSummary: (args) => {
			const a = args || {};
			const sel = select(a);
			return Object.assign({ matched: sel.events.length }, compute.fieldSummary(sel.events, { sample: a.sample, top: a.top }));
		},

		/** Field catalogue (for autocomplete): declared fields + seen fields. */
		fields: (args) => {
			const a = args || {};
			const names = classifiers.resolve(a.classifier);

			return {
				classifiers: names.map((name) => {
					const declared = classifiers.fieldTypes(name);
					const seen = metrics.fieldNames(name);
					const node = classifiers.get(name);
					const all = Array.from(new Set(Object.keys(declared).concat(seen)));

					return {
						classifier: name,
						parent: node ? node.def.parent : null,
						fields: all.map((field) => {
							return { field, type: declared[field] || "dynamic" };
						})
					};
				}),
				builtin: ["$source", "$labels.<name>", "$raw", "classifier", "@timestamp"]
			};
		},

		/** Search the unclassified queue's buffered records with q/where. */
		unclassifiedRecords: (args) => {
			const a = args || {};
			const bounds = timeBounds(a);
			const where = combineQuery(a.q, a.where);
			const get = (record, key) => {
				if (key === "$source") {
					return record.source;
				}

				if (key === "$raw") {
					return record.raw;
				}

				if (key === "$cluster") {
					return record.clusterId;
				}

				if (key.indexOf("$labels.") === 0) {
					return record.labels ? record.labels[key.slice(8)] : undefined;
				}

				return record.envelope ? record.envelope.fields[key] : undefined;
			};
			const test = compileWhere(where, { get });
			const matches = clusterer.records().filter((record) => {
				if (bounds.since !== undefined && record.t < bounds.since) {
					return false;
				}

				if (bounds.until !== undefined && record.t > bounds.until) {
					return false;
				}

				return test(record);
			});
			const limit = Math.min(MAX_LIMIT, a.limit || DEFAULT_LIMIT);

			return {
				total: matches.length,
				records: matches.slice(-limit).reverse().map((record) => {
					return {
						t: new Date(record.t).toISOString(),
						source: record.source,
						labels: record.labels && Object.keys(record.labels).length ? record.labels : undefined,
						cluster: record.clusterId,
						envelope: record.envelope ? record.envelope.name : undefined,
						fields: record.envelope ? record.envelope.fields : undefined,
						raw: record.raw
					};
				})
			};
		},

		fieldTypesFor
	};

	return queries;
};

module.exports = {
	createQueries
};
