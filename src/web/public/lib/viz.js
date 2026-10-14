import { el, Skeleton, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@nemanjan00/qrp-shadcdn";
import { api } from "./api.js";
import { resource } from "./resource.js";
import { view, queryArgs, timeBounds, setAbsoluteRange, addFilter, formatNumber, formatValue } from "./view.js";
import { timeChart, termsBars, numericBars, heatmapChart } from "./charts.js";

/*
 * Render a saved/ad-hoc visualization definition against the global query,
 * filters and time range. Clicking values adds global filters (cross-filter).
 */

export const VIZ_TYPES = ["bar", "histogram", "line", "area", "heatmap", "metric", "table"];
export const AGGS = ["count", "sum", "avg", "min", "max", "p50", "p90", "p99", "distinct"];
const TABLE_SAMPLE = 1000;

/** Global args merged with the visualization's own q/where/classifier. */
const argsFor = (def, extra) => {
	const base = queryArgs(extra);
	const qs = [def.q, base.q].filter(Boolean);
	const wheres = [def.where, base.where].filter(Boolean);

	return Object.assign(base, {
		classifier: def.classifier || undefined,
		q: qs.length ? qs.map((q) => {
			return "(" + q + ")";
		}).join(" and ") : undefined,
		where: wheres.length ? { and: wheres } : undefined
	});
};

const previousPeriod = () => {
	if (view.from) {
		return null;
	}

	const bounds = timeBounds();
	const span = bounds.to - bounds.from;
	return { since: new Date(bounds.from - span).toISOString(), until: new Date(bounds.from).toISOString() };
};

const fetchMetric = (def) => {
	const agg = def.agg || "count";

	const one = (overrides) => {
		if (agg === "count") {
			return api("search_events", Object.assign(argsFor(def, { limit: 1 }), overrides || {})).then((r) => {
				return r.total;
			});
		}

		if (agg === "distinct") {
			return api("histogram", Object.assign(argsFor(def, { field: def.field, exact: true, top: 1 }), overrides || {})).then((r) => {
				return r.distinct !== undefined ? r.distinct : (r.values ? r.values.length : null);
			});
		}

		return api("histogram", Object.assign(argsFor(def, { field: def.field, exact: true }), overrides || {})).then((r) => {
			return r.stats ? r.stats[agg] : null;
		});
	};

	const prev = previousPeriod();
	return Promise.all([one(), prev ? one(prev) : Promise.resolve(null)]).then((values) => {
		return Object.freeze({ value: values[0], previous: values[1] });
	});
};

const fetchTable = (def) => {
	const groupBy = [].concat(def.group_by || (def.split_by ? [def.split_by] : []));
	const fields = groupBy.concat(def.field ? [def.field] : []);

	return api("search_events", argsFor(def, { limit: TABLE_SAMPLE, fields })).then((r) => {
		const groups = new Map();
		r.events.forEach((event) => {
			const keyParts = groupBy.map((g) => {
				return formatValue(event.fields[g]);
			});
			const key = keyParts.join("\u0001");

			if (!groups.has(key)) {
				groups.set(key, { parts: keyParts, count: 0, values: [] });
			}

			const group = groups.get(key);
			group.count++;

			if (def.field && typeof event.fields[def.field] === "number") {
				group.values.push(event.fields[def.field]);
			}
		});

		const agg = def.agg || "count";
		const aggOf = (values) => {
			if (!values.length) {
				return null;
			}

			const sorted = values.slice().sort((a, b) => {
				return a - b;
			});
			const sum = sorted.reduce((acc, v) => {
				return acc + v;
			}, 0);
			const q = (p) => {
				return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
			};
			const table = { sum, avg: sum / sorted.length, min: sorted[0], max: sorted[sorted.length - 1], p50: q(0.5), p90: q(0.9), p99: q(0.99), distinct: new Set(sorted).size };
			return table[agg];
		};

		const rows = Array.from(groups.values()).map((group) => {
			return { parts: group.parts, count: group.count, agg: agg === "count" ? null : aggOf(group.values) };
		}).sort((a, b) => {
			return b.count - a.count;
		}).slice(0, def.top || 50);

		return Object.freeze({ groupBy, rows, agg, sampled: r.events.length, total: r.total });
	});
};

const fetchFor = (def) => {
	switch (def.type) {
		case "bar":
			return api("histogram", argsFor(def, { field: def.field, top: def.top || 15, group_by: def.split_by || undefined, exact: true }));
		case "histogram":
			return api("histogram", argsFor(def, { field: def.field, buckets: def.buckets || 20, exact: true }));
		case "line":
		case "area":
			return api("timeseries", argsFor(def, { agg: def.agg || "count", field: def.field || undefined, split_by: def.split_by || undefined, interval: def.interval || undefined, top: def.top || 8 })).then((data) => {
				return Object.freeze({ data, bounds: timeBounds() });
			});
		case "heatmap":
			return api("heatmap", argsFor(def, { field: def.field, interval: def.interval || undefined, buckets: def.buckets || 20 }));
		case "metric":
			return fetchMetric(def);
		case "table":
			return fetchTable(def);
		default:
			return Promise.reject(new Error("Unknown visualization type " + def.type));
	}
};

const needsField = (def) => {
	return ["bar", "histogram", "heatmap"].indexOf(def.type) !== -1 || (def.type === "metric" && def.agg && def.agg !== "count") ||
		((def.type === "line" || def.type === "area") && def.agg && def.agg !== "count");
};

const filterValue = (field) => {
	return (value, negate) => {
		const asNumber = typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
		addFilter({ field, value: asNumber, negate });
	};
};

const renderHistogramResult = (def, r) => {
	if (r.groups) {
		return el("div", { class: "dc-groups" }, ...r.groups.map((group, i) => {
			return el("div", { class: "dc-group" },
				el("button", { type: "button", class: "dc-group-title", onclick: () => {
					addFilter({ field: def.split_by, value: group.group });
				} }, group.group + " · " + formatNumber(group.events)),
				group.values ? termsBars({ values: group.values, onFilter: filterValue(def.field), colorIndex: i }) : numericBars({ buckets: group.buckets }));
		}));
	}

	if (r.kind === "terms") {
		return termsBars({ values: r.values, onFilter: filterValue(def.field) });
	}

	if (def.type === "bar" && r.values) {
		return termsBars({ values: r.values, onFilter: filterValue(def.field) });
	}

	return el("div", {},
		numericBars({ buckets: r.buckets, onRange: (from, to) => {
			addFilter({ field: def.field, op: "range", from, to });
		} }),
		r.stats ? el("div", { class: "dc-stats" }, ...["min", "p50", "avg", "p90", "p99", "max"].map((k) => {
			return el("span", {}, el("small", {}, k), formatNumber(r.stats[k]));
		})) : null);
};

const renderMetric = (def, r) => {
	const delta = r.previous !== null && r.previous !== undefined && r.value !== null && r.previous !== 0 ?
		(r.value - r.previous) / Math.abs(r.previous) * 100 : null;
	let deltaText = "";

	if (delta !== null) {
		deltaText = (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta).toFixed(1) + "% vs previous period";
	}

	return el("div", { class: "dc-metric" },
		el("div", { class: "dc-metric-value" }, formatNumber(r.value)),
		el("div", { class: "dc-muted" }, (def.agg || "count") + (def.field ? "(" + def.field + ")" : "")),
		deltaText ? el("div", { class: delta >= 0 ? "dc-up" : "dc-down" }, deltaText) : null);
};

const renderTable = (def, r) => {
	return el("div", {},
		Table({},
			TableHeader({}, TableRow({}, ...r.groupBy.map((g) => {
				return TableHead({}, g);
			}), TableHead({}, "count"), r.agg !== "count" ? TableHead({}, r.agg + "(" + def.field + ")") : null)),
			TableBody({}, ...r.rows.map((row) => {
				return TableRow({},
					...row.parts.map((part, i) => {
						return TableCell({}, el("button", { type: "button", class: "dc-linkish", onclick: () => {
							filterValue(r.groupBy[i])(part, false);
						} }, part));
					}),
					TableCell({}, formatNumber(row.count)),
					r.agg !== "count" ? TableCell({}, formatNumber(row.agg)) : null);
			}))),
		el("p", { class: "dc-muted" }, "Grouped client-side from " + formatNumber(r.sampled) + " of " + formatNumber(r.total) + " events."));
};

const renderResult = (def, r) => {
	switch (def.type) {
		case "bar":
		case "histogram":
			return renderHistogramResult(def, r);
		case "line":
		case "area":
			return timeChart({
				type: def.type,
				times: r.data.times,
				interval: r.data.interval,
				series: r.data.series,
				from: r.bounds.from,
				to: r.bounds.to,
				retainedSince: r.data.retained_since,
				onBrush: setAbsoluteRange,
				onSeries: (key) => {
					if (def.split_by && key !== "other") {
						filterValue(def.split_by)(key, false);
					}
				}
			});
		case "heatmap":
			return heatmapChart(r);
		case "metric":
			return renderMetric(def, r);
		case "table":
			return renderTable(def, r);
		default:
			return null;
	}
};

/**
 * Live visualization panel.
 * @param {function(): object} getDef thunk returning the definition (reactive)
 */
export const VizView = (getDef) => {
	const data = resource(() => {
		const def = getDef();

		if (!def || !def.type) {
			return null;
		}

		if (needsField(def) && !def.field) {
			return Promise.reject(new Error("Pick a field"));
		}

		return fetchFor(def).then((result) => {
			return Object.freeze({ type: def.type, result });
		});
	});

	return el("div", { class: "dc-viz" }, () => {
		if (data.error) {
			return el("div", { class: "dc-error" }, data.error);
		}

		const def = getDef();

		if (!data.data || !def || data.data.type !== def.type) {
			return Skeleton({ class: "dc-skel-chart" });
		}

		return renderResult(def, data.data.result);
	});
};
