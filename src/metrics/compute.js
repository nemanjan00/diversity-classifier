const autoInterval = require("../utils/units").autoInterval;

const LOW_CARDINALITY = 30;

/** min/max without spreading (Math.min.apply overflows the stack beyond ~100k values). */
const minOf = (values) => {
	return values.reduce((acc, v) => {
		return v < acc ? v : acc;
	}, Infinity);
};

const maxOf = (values) => {
	return values.reduce((acc, v) => {
		return v > acc ? v : acc;
	}, -Infinity);
};

/*
 * Pure computations over arrays of events (exact queries, SPEC.md §7.3).
 * An event is { id, t, source, labels, classifier, path, fields, raw? }.
 */

const getField = (event, key) => {
	switch (key) {
		case "$source":
			return event.source;
		case "$raw":
			return event.raw;
		case "classifier":
		case "$classifier":
			return event.path;
		case "$time":
		case "@timestamp":
			return event.t;
		case "$labels":
			return event.labels;
		default:
			if (key.indexOf("$labels.") === 0) {
				return event.labels ? event.labels[key.slice(8)] : undefined;
			}

			return event.fields[key];
	}
};

/** For grouping: arrays (classifier path) group by their last element. */
const groupKey = (event, key) => {
	if (key === "classifier" || key === "$classifier") {
		return event.classifier;
	}

	const value = getField(event, key);

	if (value === undefined || value === null) {
		return null;
	}

	return Array.isArray(value) ? value.join(",") : String(value);
};

const exactQuantile = (sorted, q) => {
	if (!sorted.length) {
		return null;
	}

	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const numericStats = (values) => {
	if (!values.length) {
		return { count: 0 };
	}

	const sorted = values.slice().sort((a, b) => {
		return a - b;
	});
	const sum = sorted.reduce((acc, v) => {
		return acc + v;
	}, 0);

	return {
		count: sorted.length,
		min: sorted[0],
		max: sorted[sorted.length - 1],
		sum,
		avg: sum / sorted.length,
		p50: exactQuantile(sorted, 0.5),
		p90: exactQuantile(sorted, 0.9),
		p99: exactQuantile(sorted, 0.99)
	};
};

const termCounts = (values, top) => {
	const counts = new Map();
	values.forEach((value) => {
		const key = String(value);
		counts.set(key, (counts.get(key) || 0) + 1);
	});

	const total = values.length;
	const sorted = Array.from(counts.entries()).sort((a, b) => {
		return b[1] - a[1];
	});
	const shown = sorted.slice(0, top || 20);
	const shownTotal = shown.reduce((acc, pair) => {
		return acc + pair[1];
	}, 0);

	return {
		total,
		distinct: counts.size,
		values: shown.map((pair) => {
			return { value: pair[0], count: pair[1], pct: total ? Math.round(pair[1] / total * 1000) / 10 : 0 };
		}),
		other: total - shownTotal
	};
};

const valuesOf = (events, field) => {
	return events.map((event) => {
		return getField(event, field);
	}).filter((value) => {
		return value !== undefined && value !== null;
	}).flat();
};

const isNumericValues = (values) => {
	return values.length > 0 && values.every((value) => {
		return typeof value === "number";
	});
};

const linearBuckets = (values, options) => {
	const min = minOf(values);
	const max = maxOf(values);
	let bounds = options.bounds;

	if (!bounds) {
		const n = options.buckets || 20;

		if (min === max) {
			bounds = [min, max + 1];
		} else {
			const width = (max - min) / n;
			bounds = [];

			for (let i = 0; i <= n; i++) {
				bounds.push(min + width * i);
			}
		}
	}

	const buckets = bounds.slice(0, -1).map((from, i) => {
		return { from, to: bounds[i + 1], count: 0 };
	});
	let below = 0;
	let above = 0;

	values.forEach((value) => {
		if (value < bounds[0]) {
			below++;
			return;
		}

		if (value > bounds[bounds.length - 1]) {
			above++;
			return;
		}

		let index = buckets.findIndex((bucket) => {
			return value < bucket.to;
		});

		if (index === -1) {
			index = buckets.length - 1;
		}

		buckets[index].count++;
	});

	return { buckets, below, above };
};

/**
 * Histogram of one field. Strings → top terms; numbers → stats + buckets.
 * @param {{ buckets?: number, bounds?: number[], top?: number, group_by?: string, group_top?: number }} options
 */
const histogram = (events, field, options) => {
	const opts = options || {};

	const one = (subset) => {
		const values = valuesOf(subset, field);

		if (isNumericValues(values)) {
			const out = linearBuckets(values, opts);
			const terms = termCounts(values, opts.top);
			return {
				kind: "numeric",
				stats: numericStats(values),
				values: terms.distinct <= LOW_CARDINALITY ? terms.values.map((entry) => {
					return { value: Number(entry.value), count: entry.count, pct: entry.pct };
				}) : undefined,
				buckets: out.buckets,
				below: out.below || undefined,
				above: out.above || undefined
			};
		}

		return Object.assign({ kind: "terms" }, termCounts(values, opts.top));
	};

	if (!opts.group_by) {
		return Object.assign({ field, events: events.length }, one(events));
	}

	const groups = new Map();
	events.forEach((event) => {
		const key = groupKey(event, opts.group_by);

		if (key === null) {
			return;
		}

		if (!groups.has(key)) {
			groups.set(key, []);
		}

		groups.get(key).push(event);
	});

	const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
		return b[1].length - a[1].length;
	}).slice(0, opts.group_top || 10);

	return {
		field,
		group_by: opts.group_by,
		events: events.length,
		groups: sortedGroups.map((pair) => {
			return Object.assign({ group: pair[0], events: pair[1].length }, one(pair[1]));
		})
	};
};

const AGGREGATES = {
	count: (subset) => {
		return subset.length;
	},
	sum: (_subset, values) => {
		return values.reduce((acc, v) => {
			return acc + v;
		}, 0);
	},
	avg: (_subset, values) => {
		return values.length ? values.reduce((acc, v) => {
			return acc + v;
		}, 0) / values.length : null;
	},
	min: (_subset, values) => {
		return values.length ? minOf(values) : null;
	},
	max: (_subset, values) => {
		return values.length ? maxOf(values) : null;
	},
	p50: (_subset, values) => {
		return exactQuantile(values.slice().sort((a, b) => {
			return a - b;
		}), 0.5);
	},
	p90: (_subset, values) => {
		return exactQuantile(values.slice().sort((a, b) => {
			return a - b;
		}), 0.9);
	},
	p99: (_subset, values) => {
		return exactQuantile(values.slice().sort((a, b) => {
			return a - b;
		}), 0.99);
	},
	distinct: (_subset, _values, raw) => {
		return new Set(raw.map(String)).size;
	}
};

const aggregate = (agg, subset, field) => {
	const fn = AGGREGATES[agg || "count"];

	if (!fn) {
		throw new Error("Unknown aggregate '" + agg + "'. Use one of " + Object.keys(AGGREGATES).join(", "));
	}

	if (!agg || agg === "count") {
		return fn(subset);
	}

	if (!field) {
		throw new Error("Aggregate '" + agg + "' needs a field");
	}

	const raw = valuesOf(subset, field);
	const numeric = raw.filter((value) => {
		return typeof value === "number";
	});

	return fn(subset, numeric, raw);
};

const timeRange = (events, since, until) => {
	const from = since !== undefined ? since : events.reduce((acc, event) => {
		return Math.min(acc, event.t);
	}, Infinity);
	const to = until !== undefined ? until : Date.now();

	return { from: isFinite(from) ? from : to - 3600000, to };
};

/**
 * Date histogram: count or aggregate per interval, optionally split by a field.
 * @param {{ since?: number, until?: number, interval?: number, agg?: string, field?: string,
 *   split_by?: string, top?: number }} options
 */
const timeseries = (events, options) => {
	const opts = options || {};
	const range = timeRange(events, opts.since, opts.until);
	const interval = opts.interval || autoInterval(range.to - range.from, 60);
	const start = Math.floor(range.from / interval) * interval;
	const bucketCount = Math.max(1, Math.ceil((range.to - start + 1) / interval));

	if (bucketCount > 5000) {
		throw new Error("Too many buckets (" + bucketCount + "); use a larger interval");
	}

	const bucketOf = (t) => {
		return Math.floor((t - start) / interval);
	};

	const series = (subset) => {
		const buckets = [];

		for (let i = 0; i < bucketCount; i++) {
			buckets.push([]);
		}

		subset.forEach((event) => {
			const i = bucketOf(event.t);

			if (i >= 0 && i < bucketCount) {
				buckets[i].push(event);
			}
		});

		return buckets.map((bucket) => {
			return aggregate(opts.agg, bucket, opts.field);
		});
	};

	const times = [];

	for (let i = 0; i < bucketCount; i++) {
		times.push(start + i * interval);
	}

	if (!opts.split_by) {
		return { interval, agg: opts.agg || "count", field: opts.field || null, times, series: [{ key: "all", values: series(events) }] };
	}

	const groups = new Map();
	events.forEach((event) => {
		const key = groupKey(event, opts.split_by);
		const name = key === null ? "(missing)" : key;

		if (!groups.has(name)) {
			groups.set(name, []);
		}

		groups.get(name).push(event);
	});

	const ranked = Array.from(groups.entries()).sort((a, b) => {
		return b[1].length - a[1].length;
	});
	const topN = opts.top || 8;
	const shown = ranked.slice(0, topN);
	const rest = ranked.slice(topN).flatMap((pair) => {
		return pair[1];
	});
	const out = shown.map((pair) => {
		return { key: pair[0], total: pair[1].length, values: series(pair[1]) };
	});

	if (rest.length) {
		out.push({ key: "other", total: rest.length, values: series(rest) });
	}

	return { interval, agg: opts.agg || "count", field: opts.field || null, split_by: opts.split_by, times, series: out };
};

/**
 * Distribution of a numeric field over time: time buckets × value buckets.
 * @param {{ since?: number, until?: number, interval?: number, buckets?: number, scale?: "log"|"linear" }} options
 */
const heatmap = (events, field, options) => {
	const opts = options || {};
	const points = events.map((event) => {
		return { t: event.t, v: getField(event, field) };
	}).filter((point) => {
		return typeof point.v === "number" && isFinite(point.v);
	});

	const range = timeRange(events, opts.since, opts.until);
	const interval = opts.interval || autoInterval(range.to - range.from, 60);
	const start = Math.floor(range.from / interval) * interval;
	const columns = Math.max(1, Math.ceil((range.to - start + 1) / interval));
	const rows = opts.buckets || 20;

	if (!points.length) {
		return { field, interval, times: [], bounds: [], cells: [] };
	}

	const min = minOf(points.map((p) => {
		return p.v;
	}));
	const max = maxOf(points.map((p) => {
		return p.v;
	}));
	const useLog = (opts.scale || "log") === "log" && min > 0 && max / min > 20;
	const bounds = [];

	for (let i = 0; i <= rows; i++) {
		if (useLog) {
			bounds.push(min * Math.pow(max / min, i / rows));
		} else {
			bounds.push(min + (max - min || 1) * i / rows);
		}
	}

	const cells = [];
	const index = new Map();

	points.forEach((point) => {
		const col = Math.floor((point.t - start) / interval);

		if (col < 0 || col >= columns) {
			return;
		}

		let row = bounds.findIndex((bound, i) => {
			return i > 0 && point.v <= bound;
		}) - 1;

		if (row < 0) {
			row = 0;
		}

		const key = col * 10000 + row;

		if (!index.has(key)) {
			const cell = [col, row, 0];
			index.set(key, cell);
			cells.push(cell);
		}

		index.get(key)[2]++;
	});

	const times = [];

	for (let i = 0; i < columns; i++) {
		times.push(start + i * interval);
	}

	return { field, interval, scale: useLog ? "log" : "linear", times, bounds, cells };
};

/** Kibana-style field sidebar: every field, its type, presence and top values / stats. */
const fieldSummary = (events, options) => {
	const opts = options || {};
	const sample = events.slice(-(opts.sample || 5000));
	const fields = new Map();

	const visit = (name, value) => {
		if (value === undefined || value === null) {
			return;
		}

		if (!fields.has(name)) {
			fields.set(name, []);
		}

		fields.get(name).push(value);
	};

	sample.forEach((event) => {
		Object.keys(event.fields).forEach((name) => {
			visit(name, event.fields[name]);
		});
		visit("$source", event.source);
		Object.keys(event.labels || {}).forEach((label) => {
			visit("$labels." + label, event.labels[label]);
		});
		visit("classifier", event.classifier);
	});

	return {
		sampled: sample.length,
		fields: Array.from(fields.entries()).map((pair) => {
			const values = pair[1].flat();
			const numeric = isNumericValues(values);
			const out = {
				field: pair[0],
				type: numeric ? "number" : (typeof values[0] === "boolean" ? "bool" : "string"),
				present_pct: sample.length ? Math.round(pair[1].length / sample.length * 1000) / 10 : 0
			};

			if (numeric) {
				out.stats = numericStats(values);
			} else {
				const terms = termCounts(values, opts.top || 5);
				out.distinct = terms.distinct;
				out.top = terms.values;
			}

			return out;
		}).sort((a, b) => {
			return a.field < b.field ? -1 : 1;
		})
	};
};

const project = (event, fields) => {
	const out = {
		id: event.id,
		t: new Date(event.t).toISOString(),
		classifier: event.classifier,
		source: event.source
	};

	if (event.labels && Object.keys(event.labels).length) {
		out.labels = event.labels;
	}

	if (fields && fields.length) {
		out.fields = {};
		fields.forEach((field) => {
			const value = getField(event, field);

			if (value !== undefined) {
				out.fields[field] = value;
			}
		});
	} else {
		out.fields = event.fields;
	}

	if (event.raw !== undefined && (!fields || fields.indexOf("$raw") !== -1 || !fields.length)) {
		out.raw = event.raw;
	}

	return out;
};

module.exports = {
	getField,
	groupKey,
	histogram,
	timeseries,
	heatmap,
	fieldSummary,
	numericStats,
	termCounts,
	aggregate,
	project,
	AGGREGATES
};
