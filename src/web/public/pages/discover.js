import {
	state, el, when, list,
	Button, Badge, Card, NativeSelect, NativeSelectOption, Skeleton, Empty, EmptyHeader, EmptyTitle, EmptyDescription
} from "@nemanjan00/qrp-shadcdn";
import { api } from "../lib/api.js";
import { resource } from "../lib/resource.js";
import { live } from "../lib/live.js";
import {
	view, queryArgs, timeBounds, setAbsoluteRange, addFilter, go, formatNumber, formatTime, formatValue, pauseLive
} from "../lib/view.js";
import { timeChart, termsBars } from "../lib/charts.js";
import { vizPreset } from "./visualize.js";

/*
 * Discover: hits over time (drag to zoom), field sidebar with top values and
 * +/− filters, event table with expandable rows. Toggle to search the
 * unclassified queue instead.
 */

const PAGE_SIZE = 50;
const CHART_BUCKETS = 60;

const classifierArg = () => {
	return view.c || undefined;
};

/** Click a value: filter for it; Alt/Shift-click: exclude it. Pauses live updates. */
const filterFromValue = (field, value) => {
	return (event) => {
		event.stopPropagation();
		event.preventDefault();
		pauseLive("filtering from an event");
		addFilter({ field, value, negate: event.altKey || event.shiftKey });
	};
};

/**
 * Wrap raw-line occurrences of field values in clickable <mark>s.
 * @param {string} raw
 * @param {object} fields
 * @param {{ inline?: boolean }} [options] inline: <span> for the collapsed row instead of <pre>
 */
const highlightRaw = (raw, fields, options) => {
	const text = raw || "";
	const candidates = Object.keys(fields || {}).map((name) => {
		const value = fields[name];
		return { name, text: typeof value === "string" || typeof value === "number" ? String(value) : "" };
	}).filter((c) => {
		return c.text.length >= 2 && c.text.length < text.length;
	}).sort((a, b) => {
		return b.text.length - a.text.length;
	});
	const taken = [];

	candidates.forEach((c) => {
		let from = 0;
		let idx = text.indexOf(c.text, from);

		while (idx !== -1) {
			const end = idx + c.text.length;
			const overlaps = taken.some((t) => {
				return idx < t.end && end > t.start;
			});

			if (!overlaps) {
				taken.push({ start: idx, end, name: c.name, value: fields[c.name] });
				return;
			}

			from = idx + 1;
			idx = text.indexOf(c.text, from);
		}
	});

	taken.sort((a, b) => {
		return a.start - b.start;
	});

	const parts = [];
	let last = 0;
	taken.forEach((t) => {
		parts.push(text.slice(last, t.start));
		parts.push(el("mark", {
			class: "dc-mark dc-mark-filter",
			title: t.name + " = " + formatValue(t.value) + "\nclick: filter · alt/shift-click: exclude",
			onclick: filterFromValue(t.name, t.value)
		}, text.slice(t.start, t.end)));
		last = t.end;
	});
	parts.push(text.slice(last));

	if (options && options.inline) {
		return el("span", { class: "dc-line-raw" }, ...parts);
	}

	return el("pre", { class: "dc-raw" }, ...parts);
};

const toggleColumn = (field) => {
	if (view.cols.indexOf(field) === -1) {
		view.cols = view.cols.concat([field]);
	} else {
		view.cols = view.cols.filter((c) => {
			return c !== field;
		});
	}
};

const filterButtons = (field, value) => {
	return el("span", { class: "dc-row-actions" },
		el("button", { type: "button", class: "dc-mini", title: "Filter for value", onclick: () => {
			addFilter({ field, value });
		} }, "+"),
		el("button", { type: "button", class: "dc-mini", title: "Filter out value", onclick: () => {
			addFilter({ field, value, negate: true });
		} }, "−"),
		el("button", { type: "button", class: "dc-mini", title: "Toggle column", onclick: () => {
			toggleColumn(field);
		} }, "⊞"));
};

const fieldValueTable = (event) => {
	const entries = Object.keys(event.fields || {}).map((name) => {
		return [name, event.fields[name]];
	}).concat([["$source", event.source]]).concat(Object.keys(event.labels || {}).map((label) => {
		return ["$labels." + label, event.labels[label]];
	}));

	return el("table", { class: "dc-kv" }, el("tbody", {}, ...entries.map((entry) => {
		return el("tr", {},
			el("th", {}, entry[0]),
			el("td", {}, formatValue(entry[1])),
			el("td", { class: "dc-kv-actions" }, filterButtons(entry[0], entry[1])));
	})));
};

const FieldSidebar = (summary) => {
	const open = state({});

	return el("aside", { class: "dc-sidebar" },
		el("div", { class: "dc-side-title" }, "Fields"),
		() => {
			if (summary.loading && !summary.data) {
				return Skeleton({ class: "dc-skel" });
			}

			if (summary.error) {
				return el("div", { class: "dc-error" }, summary.error);
			}

			const data = summary.data;

			if (!data || !data.fields.length) {
				return el("p", { class: "dc-muted" }, "No fields in this result set.");
			}

			return el("div", { class: "dc-field-list" }, el("p", { class: "dc-muted" }, "sampled " + formatNumber(data.sampled) + " of " + formatNumber(data.matched)),
				...data.fields.map((f) => {
					return el("div", { class: "dc-field-item" },
						el("div", { class: "dc-field-head" },
							el("button", { type: "button", class: "dc-field-name", onclick: () => {
								open[f.field] = !open[f.field];
							} },
							el("span", { class: "dc-type" }, f.type === "number" ? "#" : (f.type === "bool" ? "◑" : "t")),
							f.field),
							el("span", { class: "dc-muted" }, f.present_pct + "%"),
							el("button", { type: "button", class: () => {
								return "dc-mini" + (view.cols.indexOf(f.field) !== -1 ? " dc-mini-on" : "");
							}, title: "Toggle column", onclick: () => {
								toggleColumn(f.field);
							} }, "⊞")),
						when(() => {
							return open[f.field];
						}, () => {
							return el("div", { class: "dc-field-body" },
								f.top ? termsBars({ values: f.top, onFilter: (value, negate) => {
									addFilter({ field: f.field, value, negate });
								} }) : null,
								f.stats ? el("div", { class: "dc-stats" },
									...["min", "p50", "avg", "p90", "max"].map((k) => {
										return el("span", {}, el("small", {}, k), formatNumber(f.stats[k]));
									})) : null,
								f.distinct !== undefined ? el("p", { class: "dc-muted" }, formatNumber(f.distinct) + " distinct in sample") : null,
								Button({ size: "xs", variant: "outline", onclick: () => {
									vizPreset.value = { type: f.type === "number" ? "histogram" : "bar", field: f.field, classifier: view.c };
									go("visualize");
								} }, "Visualize"));
						}));
				}));
		});
};

const EventRow = (event, expanded) => {
	const cols = () => {
		return view.cols;
	};

	return el("div", { class: "dc-event" },
		el("div", { class: "dc-event-line", onclick: () => {
			expanded[event.id] = !expanded[event.id];

			if (expanded[event.id]) {
				pauseLive("inspecting an event");
			}
		} },
		el("span", { class: "dc-caret" }, () => {
			return expanded[event.id] ? "▾" : "▸";
		}),
		el("span", { class: "dc-time" }, formatTime(Date.parse(event.t), true)),
		Badge({ variant: "secondary", class: "dc-badge-c" }, event.classifier),
		() => {
			if (cols().length) {
				return el("span", { class: "dc-cols" }, ...cols().map((c) => {
					let value = event.fields[c];

					if (c === "$source") {
						value = event.source;
					} else if (c.indexOf("$labels.") === 0) {
						value = event.labels ? event.labels[c.slice(8)] : undefined;
					}

					return el("span", {
						class: "dc-col dc-mark-filter",
						title: c + " = " + formatValue(value) + "\nclick: filter · alt/shift-click: exclude",
						onclick: value === undefined ? null : filterFromValue(c, value)
					}, el("small", {}, c), formatValue(value));
				}));
			}

			if (event.raw !== undefined) {
				return highlightRaw(event.raw, event.fields, { inline: true });
			}

			return el("span", { class: "dc-line-raw" }, Object.keys(event.fields).map((k) => {
				return k + "=" + formatValue(event.fields[k]);
			}).join(" "));
		}),
		when(() => {
			return expanded[event.id];
		}, () => {
			return el("div", { class: "dc-event-detail" },
				event.raw !== undefined ? highlightRaw(event.raw, event.fields) : el("p", { class: "dc-muted" }, "(raw line not stored: store=fields)"),
				fieldValueTable(event));
		}));
};

const EventsView = () => {
	const limit = state({ n: PAGE_SIZE });
	const expanded = state({});

	const chart = resource(() => {
		const args = queryArgs({ classifier: classifierArg(), split_by: view.stack || undefined, top: 8 });
		const bounds = timeBounds();
		const span = bounds.to - bounds.from;
		args.interval = Math.max(1000, Math.round(span / CHART_BUCKETS / 1000) * 1000) + "ms";
		return api("timeseries", args).then((data) => {
			return Object.freeze({ data, bounds });
		});
	});
	const summary = resource(() => {
		return api("field_summary", queryArgs({ classifier: classifierArg(), top: 5, sample: 2000 }));
	});
	const events = resource(() => {
		return api("search_events", queryArgs({ classifier: classifierArg(), limit: limit.n }));
	});
	/** When the range is empty: are there matching events outside it, and is this a count-only classifier? */
	const outside = resource(() => {
		if (!events.data || events.data.total > 0) {
			return Promise.resolve(null);
		}

		const args = queryArgs({ classifier: classifierArg(), limit: 1 });
		delete args.since;
		delete args.until;
		return Promise.all([
			api("search_events", args),
			api("search_events", Object.assign({}, args, { order: "asc" })),
			view.c ? api("list_classifiers", { classifier: view.c }) : Promise.resolve(null)
		]).then((results) => {
			const node = results[2] ? results[2].classifiers.find((c) => {
				return c.name === view.c;
			}) : null;
			return Object.freeze({
				total: results[0].total,
				newest: results[0].events[0] ? Date.parse(results[0].events[0].t) : null,
				oldest: results[1].events[0] ? Date.parse(results[1].events[0].t) : null,
				countOnly: !!(node && node.store === "count"),
				count: node ? node.count : 0
			});
		});
	});

	const emptyState = () => {
		const info = outside.data;

		if (info && info.countOnly) {
			return Empty(EmptyHeader(EmptyTitle("Counts only"), EmptyDescription(
				view.c + " uses store: \"count\", so it keeps counters and field aggregates (" + formatNumber(info.count) +
				" so far) but no individual events. Change its store to \"full\" in the classifier editor to keep events.")));
		}

		if (info && info.total > 0) {
			return Empty(EmptyHeader(EmptyTitle("No events in this time range"), EmptyDescription(
				formatNumber(info.total) + " matching events are retained outside it (" + formatTime(info.oldest, true) + " … " + formatTime(info.newest, true) +
				"). Event time comes from the classifier's time_field when set; zone-less timestamps are read as local time unless the type says otherwise, e.g. {ts:timestamp(utc)}.")),
			Button({ size: "sm", onclick: () => {
				setAbsoluteRange(info.oldest - 1000, info.newest + 1000);
			} }, "Show all retained events"));
		}

		return Empty(EmptyHeader(EmptyTitle("No events"), EmptyDescription("Nothing matches this query and time range. Widen the range, clear filters, or check the Unclassified queue.")));
	};

	return el("div", { class: "dc-discover" },
		FieldSidebar(summary),
		el("section", { class: "dc-content" },
			Card({ class: "dc-card" },
				el("div", { class: "dc-card-head" },
					el("strong", {}, () => {
						return events.data ? formatNumber(events.data.total) + " hits" : "…";
					}),
					el("span", { class: "dc-muted" }, () => {
						return events.data && events.data.retained_since ? "retained since " + formatTime(Date.parse(events.data.retained_since), true) : "";
					}),
					el("span", { class: "dc-spacer" }),
					NativeSelect({ size: "sm", "aria-label": "Stack by", onchange: (event) => {
						view.stack = event.target.value;
					} },
					NativeSelectOption({ value: "", selected: () => {
						return !view.stack;
					} }, "No stacking"),
					NativeSelectOption({ value: "classifier", selected: () => {
						return view.stack === "classifier";
					} }, "Stack by classifier"),
					NativeSelectOption({ value: "$source", selected: () => {
						return view.stack === "$source";
					} }, "Stack by source"))),
				() => {
					if (chart.error) {
						return el("div", { class: "dc-error" }, chart.error);
					}

					if (!chart.data) {
						return Skeleton({ class: "dc-skel-chart" });
					}

					const d = chart.data.data;
					return timeChart({
						times: d.times,
						interval: d.interval,
						series: d.series,
						from: chart.data.bounds.from,
						to: chart.data.bounds.to,
						retainedSince: d.retained_since,
						onBrush: setAbsoluteRange,
						onSeries: (key) => {
							if (view.stack) {
								addFilter({ field: view.stack, value: key });
							}
						}
					});
				}),
			() => {
				if (events.error) {
					return el("div", { class: "dc-error" }, events.error);
				}

				if (!events.data) {
					return Skeleton({ class: "dc-skel-table" });
				}

				if (!events.data.events.length) {
					return emptyState();
				}

				return null;
			},
			el("div", { class: "dc-events" }, list(() => {
				return events.data ? events.data.events : [];
			}, (event) => {
				return event.id;
			}, (event) => {
				return EventRow(event, expanded);
			})),
			when(() => {
				return events.data && events.data.next_cursor;
			}, () => {
				return Button({ variant: "outline", class: "dc-more", onclick: () => {
					limit.n += PAGE_SIZE;
				} }, "Load more");
			})));
};

const UnclassifiedView = () => {
	const expanded = state({});
	const records = resource(() => {
		return api("search_unclassified", Object.assign(queryArgs(), { limit: 1000 }));
	});

	const chartFor = (data) => {
		const bounds = timeBounds();
		const interval = Math.max(1000, Math.round((bounds.to - bounds.from) / CHART_BUCKETS));
		const times = [];

		for (let t = bounds.from; t < bounds.to; t += interval) {
			times.push(t);
		}

		const values = times.map(() => {
			return 0;
		});
		data.records.forEach((record) => {
			const i = Math.floor((Date.parse(record.t) - bounds.from) / interval);

			if (i >= 0 && i < values.length) {
				values[i]++;
			}
		});

		return timeChart({ times, interval, series: [{ key: "unclassified", values }], from: bounds.from, to: bounds.to, onBrush: setAbsoluteRange });
	};

	return el("section", { class: "dc-content dc-content-full" },
		Card({ class: "dc-card" },
			el("div", { class: "dc-card-head" },
				el("strong", {}, () => {
					return records.data ? formatNumber(records.data.total) + " unclassified records (buffered)" : "…";
				}),
				el("span", { class: "dc-muted" }, "Bare words search the raw line; envelope fields (e.g. level) are filterable.")),
			() => {
				return records.data ? chartFor(records.data) : Skeleton({ class: "dc-skel-chart" });
			}),
		() => {
			return records.error ? el("div", { class: "dc-error" }, records.error) : null;
		},
		el("div", { class: "dc-events" }, list(() => {
			return records.data ? records.data.records.slice(0, 300).map((r, i) => {
				return Object.assign({ key: r.t + ":" + i + ":" + r.raw.length }, r);
			}) : [];
		}, (r) => {
			return r.key;
		}, (r) => {
			return el("div", { class: "dc-event" },
				el("div", { class: "dc-event-line", onclick: () => {
					expanded[r.key] = !expanded[r.key];
				} },
				el("span", { class: "dc-time" }, formatTime(Date.parse(r.t), true)),
				el("a", { class: "dc-cluster-link", href: "#/unclassified", title: "Open the unclassified queue" }, r.cluster),
				el("span", { class: "dc-line-raw" }, r.raw)),
				when(() => {
					return expanded[r.key];
				}, () => {
					return el("div", { class: "dc-event-detail" },
						el("pre", { class: "dc-raw" }, r.raw),
						r.fields ? fieldValueTable({ fields: r.fields, source: r.source, labels: r.labels }) : el("p", { class: "dc-muted" }, "source: " + r.source));
				}));
		})));
};

export const DiscoverPage = () => {
	const classifiers = resource(() => {
		live.defRev;
		return api("list_classifiers", {});
	});

	return el("div", { class: "dc-page" },
		el("div", { class: "dc-page-head" },
			el("h1", {}, "Discover"),
			NativeSelect({ size: "sm", "aria-label": "Classifier", onchange: (event) => {
				view.c = event.target.value;
			} },
			NativeSelectOption({ value: "" }, "All classifiers"),
			() => {
				const data = classifiers.data;
				return data ? data.classifiers.map((c) => {
					const label = c.store === "count" ? formatNumber(c.count) + " · counts only" : formatNumber(c.count);
					return NativeSelectOption({ value: c.name, selected: c.name === view.c }, c.name + " (" + label + ")");
				}) : null;
			}),
			el("div", { class: "dc-seg" },
				el("button", { type: "button", class: () => {
					return view.mode !== "unclassified" ? "dc-seg-on" : "";
				}, onclick: () => {
					view.mode = "events";
				} }, "Events"),
				el("button", { type: "button", class: () => {
					return view.mode === "unclassified" ? "dc-seg-on" : "";
				}, onclick: () => {
					view.mode = "unclassified";
				} }, "Unclassified"))),
		when(() => {
			return view.mode === "unclassified" ? "u" : "e";
		}, (mode) => {
			return mode === "u" ? UnclassifiedView() : EventsView();
		}));
};

