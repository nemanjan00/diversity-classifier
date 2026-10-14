import {
	el, toast,
	Button, Badge, Card, Skeleton, Empty, EmptyHeader, EmptyTitle, EmptyDescription
} from "@nemanjan00/qrp-shadcdn";
import { api } from "../lib/api.js";
import { resource } from "../lib/resource.js";
import { live } from "../lib/live.js";
import { view, go, hrefFor, queryArgs, timeBounds, addFilter, setAbsoluteRange, refresh, formatNumber, formatTime } from "../lib/view.js";
import { timeChart, termsBars, numericBars, heatmapChart, sparkline } from "../lib/charts.js";
import { openEditor, templateView } from "../lib/editor.js";

/*
 * Classifier explorer: tree of envelopes → classifiers → sub-classifiers, and
 * a detail page with one panel per field (distribution + over time). Clicking
 * a value filters the whole page (cross-filter).
 */

const SKIP_PANEL_TYPES = ["rest", "text", "json", "kv", "timestamp", "iso8601"];
const NUMERIC_TYPES = ["int", "float", "number", "duration", "bytes", "port"];
const PANEL_INTERVAL_BUCKETS = 40;

const badges = (c) => {
	return [
		c.envelope ? Badge({ variant: "outline" }, "envelope") : null,
		c.store && c.store !== "full" ? Badge({ variant: "outline" }, "store: " + c.store) : null,
		c.scope === "global" ? Badge({ variant: "outline" }, "global") : null,
		c.enabled === false ? Badge({ variant: "secondary" }, "disabled") : null,
		c.error ? Badge({ variant: "destructive", title: c.error }, "error") : null
	];
};

const TreeNode = (c, byName, depth) => {
	return el("div", { class: "dc-tree-node" },
		el("a", { href: hrefFor("classifiers", c.name), class: "dc-tree-row", style: "padding-left:" + (8 + depth * 18) + "px" },
			el("span", { class: "dc-tree-name" }, c.name),
			...badges(c),
			el("span", { class: "dc-spacer" }),
			c.spark_60m ? sparkline(c.spark_60m, { width: 90, height: 18 }) : null,
			el("span", { class: "dc-num" }, formatNumber(c.count)),
			el("span", { class: "dc-num dc-muted" }, c.rate_1m + "/s")),
		c.error ? el("div", { class: "dc-error dc-tree-error", style: "margin-left:" + (8 + depth * 18) + "px" }, c.error) : null,
		...(c.children || []).map((child) => {
			return byName[child] ? TreeNode(byName[child], byName, depth + 1) : null;
		}));
};

const Parsers = () => {
	const parsers = resource(() => {
		live.defRev;
		return api("list_parsers", {});
	});

	return Card({ class: "dc-card" },
		el("div", { class: "dc-card-head" }, el("strong", {}, "Parsers"), el("span", { class: "dc-muted" }, "Reusable types; spread template parsers with {...name}")),
		() => {
			const data = parsers.data;

			if (!data) {
				return Skeleton({ class: "dc-skel" });
			}

			if (!data.parsers.length) {
				return el("p", { class: "dc-muted" }, "No custom parsers. Built-in types: " + data.builtin_types.map((t) => {
					return t.name;
				}).join(", "));
			}

			return el("div", { class: "dc-parsers" }, ...data.parsers.map((p) => {
				return el("div", { class: "dc-parser" },
					el("strong", {}, p.name),
					p.scope === "global" ? Badge({ variant: "outline" }, "global") : null,
					p.template ? templateView(p.template) : el("code", { class: "dc-template" }, "/" + p.regex + "/" + (p.convert ? " | " + p.convert : "")),
					p.used_by && p.used_by.length ? el("span", { class: "dc-muted" }, "used by " + p.used_by.join(", ")) : null);
			}));
		});
};

const TreeView = () => {
	const data = resource(() => {
		live.defRev;
		queryArgs();
		return api("list_classifiers", { spark: true });
	});

	return el("div", { class: "dc-page" },
		el("div", { class: "dc-page-head" },
			el("h1", {}, "Classifiers"),
			el("span", { class: "dc-spacer" }),
			live.readOnly ? null : Button({ size: "sm", onclick: () => {
				openEditor();
			} }, "New classifier")),
		() => {
			if (data.error) {
				return el("div", { class: "dc-error" }, data.error);
			}

			if (!data.data) {
				return Skeleton({ class: "dc-skel-table" });
			}

			const list = data.data.classifiers;

			if (!list.length) {
				return Empty(EmptyHeader(EmptyTitle("No classifiers yet"), EmptyDescription("Open the Unclassified queue and classify the biggest cluster, or ask the agent to.")));
			}

			const byName = {};
			list.forEach((c) => {
				byName[c.name] = c;
			});
			const roots = list.filter((c) => {
				return !c.parent || !byName[c.parent];
			});

			return Card({ class: "dc-card dc-tree" },
				el("div", { class: "dc-tree-row dc-tree-head" }, el("span", {}, "name"), el("span", { class: "dc-spacer" }), el("span", {}, "last 60m"), el("span", { class: "dc-num" }, "count"), el("span", { class: "dc-num" }, "rate")),
				...roots.map((c) => {
					return TreeNode(c, byName, 0);
				}));
		},
		Parsers());
};

const FieldPanel = (classifier, field, type) => {
	const numeric = NUMERIC_TYPES.indexOf(type) !== -1;
	const dist = resource(() => {
		return api("histogram", queryArgs({ classifier, field, top: 10, buckets: 24, exact: true }));
	});
	const overTime = resource(() => {
		const bounds = timeBounds();
		const interval = Math.max(1000, Math.round((bounds.to - bounds.from) / PANEL_INTERVAL_BUCKETS / 1000) * 1000) + "ms";

		if (numeric) {
			return api("heatmap", queryArgs({ classifier, field, interval, buckets: 12 }));
		}

		return api("timeseries", queryArgs({ classifier, split_by: field, top: 5, interval })).then((data) => {
			return Object.freeze({ data, bounds });
		});
	});

	const onValue = (value, negate) => {
		const asNumber = numeric && typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
		addFilter({ field, value: asNumber, negate });
	};

	return Card({ class: "dc-card dc-field-panel" },
		el("div", { class: "dc-card-head" }, el("strong", {}, field), Badge({ variant: "outline" }, type)),
		() => {
			if (dist.error) {
				return el("div", { class: "dc-error" }, dist.error);
			}

			const r = dist.data;

			if (!r) {
				return Skeleton({ class: "dc-skel" });
			}

			if (r.kind === "terms") {
				return termsBars({ values: r.values, onFilter: onValue });
			}

			if (r.values) {
				return termsBars({ values: r.values, onFilter: onValue });
			}

			return el("div", {},
				numericBars({ buckets: r.buckets, height: 80, onRange: (from, to) => {
					addFilter({ field, op: "range", from, to });
				} }),
				r.stats ? el("div", { class: "dc-stats" }, ...["min", "p50", "avg", "p90", "p99", "max"].map((k) => {
					return el("span", {}, el("small", {}, k), formatNumber(r.stats[k]));
				})) : null);
		},
		el("div", { class: "dc-sub" }, "over time"),
		() => {
			const r = overTime.data;

			if (overTime.error) {
				return el("div", { class: "dc-error" }, overTime.error);
			}

			if (!r) {
				return Skeleton({ class: "dc-skel" });
			}

			if (numeric) {
				return heatmapChart(Object.assign({ height: 70 }, r, {
					onCell: (tFrom, tTo, vFrom, vTo) => {
						addFilter({ field, op: "range", from: vFrom, to: vTo });
						setAbsoluteRange(tFrom, tTo);
					}
				}));
			}

			return timeChart({
				times: r.data.times,
				interval: r.data.interval,
				series: r.data.series,
				from: r.bounds.from,
				to: r.bounds.to,
				height: 70,
				onBrush: setAbsoluteRange,
				onSeries: (key) => {
					if (key !== "other" && key !== "(missing)") {
						onValue(key, false);
					}
				}
			});
		});
};

const DetailView = () => {
	const name = view.param;
	const data = resource(() => {
		live.defRev;
		return api("list_classifiers", { classifier: name, with_fields: true, verbose: true, spark: true });
	});
	const rate = resource(() => {
		const bounds = timeBounds();
		return api("timeseries", queryArgs({ classifier: name, top: 6, split_by: "classifier" })).then((d) => {
			return Object.freeze({ d, bounds });
		});
	});
	const samples = resource(() => {
		return api("search_events", queryArgs({ classifier: name, limit: 5 }));
	});

	const remove = () => {
		if (!window.confirm("Remove classifier " + name + " and its sub-classifiers? Their stored lines go back to the queue.")) {
			return;
		}

		api("remove_classifier", { name }).then((r) => {
			toast.success("Removed " + r.removed.join(", "), { description: r.returned_to_queue + " record(s) returned to the queue" });
			refresh();
			go("classifiers");
		}).catch((error) => {
			toast.error(error.message);
		});
	};

	return el("div", { class: "dc-page" }, () => {
		if (data.error) {
			return el("div", { class: "dc-error" }, data.error);
		}

		if (!data.data) {
			return Skeleton({ class: "dc-skel-table" });
		}

		const c = data.data.classifiers.find((x) => {
			return x.name === name;
		});

		if (!c) {
			return el("div", { class: "dc-error" }, "No classifier named " + name);
		}

		const fields = c.fields || {};
		const panelFields = Object.keys(fields).filter((f) => {
			return SKIP_PANEL_TYPES.indexOf(fields[f]) === -1 && !(c.envelope && f === c.body);
		});

		return el("div", { class: "dc-stack" },
			el("div", { class: "dc-page-head" },
				el("a", { href: hrefFor("classifiers"), class: "dc-back" }, "← Classifiers"),
				el("h1", {}, c.name),
				...badges(c),
				el("span", { class: "dc-spacer" }),
				el("a", { href: hrefFor("discover", "", { c: c.name }), class: "dc-linkish" }, "Open in Discover"),
				live.readOnly ? null : Button({ size: "sm", variant: "outline", onclick: () => {
					openEditor(Object.assign({}, c, { priority: c.priority || 0, store: c.store || "full", scope: c.scope || "project" }), { editing: true });
				} }, "Edit"),
				live.readOnly ? null : Button({ size: "sm", variant: "outline", onclick: () => {
					openEditor({ parent: c.name, name: c.name + "." });
				} }, "Add sub-classifier"),
				live.readOnly ? null : Button({ size: "sm", variant: "ghost", onclick: remove }, "Delete")),
			c.description ? el("p", { class: "dc-muted" }, c.description) : null,
			Card({ class: "dc-card" },
				c.template ? templateView(c.template) : el("code", { class: "dc-template" }, "/" + c.regex + "/"),
				el("div", { class: "dc-facts" },
					el("span", {}, el("small", {}, "count"), formatNumber(c.count)),
					el("span", {}, el("small", {}, "stored"), formatNumber(c.stored)),
					c.backlog ? el("span", {}, el("small", {}, "backlog"), formatNumber(c.backlog)) : null,
					el("span", {}, el("small", {}, "rate 1m"), c.rate_1m + "/s"),
					el("span", {}, el("small", {}, "rate 5m"), c.rate_5m + "/s"),
					el("span", {}, el("small", {}, "last seen"), c.last_seen ? formatTime(Date.parse(c.last_seen), true) : "never"),
					c.parent ? el("span", {}, el("small", {}, "parent"), el("a", { href: hrefFor("classifiers", c.parent) }, c.parent)) : null,
					c.on ? el("span", {}, el("small", {}, "on"), c.on) : null,
					c.priority ? el("span", {}, el("small", {}, "priority"), String(c.priority)) : null),
				c.children && c.children.length ? el("div", { class: "dc-badges" }, el("small", { class: "dc-muted" }, "children: "), ...c.children.map((child) => {
					return el("a", { href: hrefFor("classifiers", child) }, Badge({ variant: "secondary" }, child));
				})) : null),
			Card({ class: "dc-card" },
				el("div", { class: "dc-card-head" }, el("strong", {}, "Events over time"), el("span", { class: "dc-muted" }, "drag to zoom")),
				() => {
					const r = rate.data;

					if (!r) {
						return Skeleton({ class: "dc-skel-chart" });
					}

					return timeChart({ times: r.d.times, interval: r.d.interval, series: r.d.series, from: r.bounds.from, to: r.bounds.to, retainedSince: r.d.retained_since, onBrush: setAbsoluteRange });
				}),
			panelFields.length ? el("div", { class: "dc-panels" }, ...panelFields.map((f) => {
				return FieldPanel(c.name, f, fields[f]);
			})) : el("p", { class: "dc-muted" }, "No chartable fields."),
			Card({ class: "dc-card" },
				el("div", { class: "dc-card-head" }, el("strong", {}, "Latest events")),
				() => {
					const s = samples.data;

					if (!s) {
						return Skeleton({ class: "dc-skel" });
					}

					if (!s.events.length) {
						return el("p", { class: "dc-muted" }, "No events in this range.");
					}

					return el("div", {}, ...s.events.map((event) => {
						return el("pre", { class: "dc-raw" }, el("span", { class: "dc-muted" }, formatTime(Date.parse(event.t)) + "  "), event.raw !== undefined ? event.raw : JSON.stringify(event.fields));
					}));
				}));
	});
};

export const ClassifiersPage = () => {
	return el("div", {}, () => {
		return view.param ? DetailView() : TreeView();
	});
};
