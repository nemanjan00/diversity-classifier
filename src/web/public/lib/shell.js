import {
	state, el, when, effect, batch,
	Button, Input, Badge, NativeSelect, NativeSelectOption
} from "@nemanjan00/qrp-shadcdn";
import {
	view, RANGES, REFRESH, refresh, hrefFor, addFilter, updateFilter, removeFilter, describeFilter, formatTime
} from "./view.js";
import { live } from "./live.js";
import { api } from "./api.js";
import { resource } from "./resource.js";

/*
 * App chrome: nav, KQL query bar (with field autocomplete), time picker,
 * live refresh, filter pills, theme toggle and server status.
 */

export const NAV = [
	{ page: "discover", label: "Discover" },
	{ page: "classifiers", label: "Classifiers" },
	{ page: "unclassified", label: "Unclassified" },
	{ page: "visualize", label: "Visualize" },
	{ page: "dashboards", label: "Dashboards" },
	{ page: "ops", label: "Alarms & Sources" }
];

const THEME_KEY = "dc-theme";

const applyTheme = (mode) => {
	const dark = mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
};

export const initTheme = () => {
	let mode = "system";

	try {
		mode = localStorage.getItem(THEME_KEY) || "system";
	} catch (e) {
		mode = "system";
	}

	applyTheme(mode);
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		applyTheme(mode);
	});
};

const toggleTheme = () => {
	const next = document.documentElement.classList.contains("dark") ? "light" : "dark";

	try {
		localStorage.setItem(THEME_KEY, next);
	} catch (e) {
		// per-viewer convenience only
	}

	applyTheme(next);
};

const QueryBar = () => {
	const draft = state({ text: view.q, focus: false });
	const fields = resource(() => {
		if (!draft.focus) {
			return null;
		}

		live.defRev;
		return api("fields", {});
	});

	effect(() => {
		draft.text = view.q;
	});

	const fieldNames = () => {
		const data = fields.data;

		if (!data) {
			return [];
		}

		const names = new Set(["classifier", "$source", "$raw", "exists"]);
		data.classifiers.forEach((c) => {
			c.fields.forEach((f) => {
				names.add(f.field);
			});
		});

		return Array.from(names).sort();
	};

	const lastToken = () => {
		const m = /([\w.$@-]*)$/.exec(draft.text);
		return m ? m[1] : "";
	};

	const suggestions = () => {
		const token = lastToken();

		if (!draft.focus || !token || /:$/.test(draft.text)) {
			return [];
		}

		return fieldNames().filter((name) => {
			return name.indexOf(token) === 0 && name !== token;
		}).slice(0, 8);
	};

	const apply = () => {
		view.q = draft.text.trim();
		refresh();
	};

	const complete = (name) => {
		const token = lastToken();
		draft.text = draft.text.slice(0, draft.text.length - token.length) + name + ":";
	};

	return el("div", { class: "dc-query" },
		Input({
			class: "dc-mono",
			placeholder: "Query: status >= 500 and not path:/health* and took > 2s and $source:api",
			bind: [draft, "text"],
			onkeydown: (event) => {
				if (event.key === "Enter") {
					apply();
				}
			},
			onfocus: () => {
				draft.focus = true;
			},
			onblur: () => {
				setTimeout(() => {
					draft.focus = false;
				}, 150);
			}
		}),
		when(() => {
			return suggestions().length ? suggestions().join(",") : null;
		}, () => {
			return el("div", { class: "dc-suggest" }, ...suggestions().map((name) => {
				return el("button", { type: "button", onmousedown: (event) => {
					event.preventDefault();
					complete(name);
				} }, name);
			}));
		}));
};

const TimePicker = () => {
	return el("div", { class: "dc-time" },
		when(() => {
			return view.from ? view.from + "-" + view.to : null;
		}, () => {
			return Badge({ variant: "secondary", class: "dc-abs" },
				formatTime(view.from) + " → " + (view.to ? formatTime(view.to) : "now"),
				el("button", { type: "button", class: "dc-mini", title: "Back to relative range", onclick: () => {
					batch(() => {
						view.from = null;
						view.to = null;
					});
				} }, "×"));
		}, () => {
			return NativeSelect({
				size: "sm",
				"aria-label": "Time range",
				onchange: (event) => {
					view.range = event.target.value;
				}
			}, ...RANGES.map((range) => {
				return NativeSelectOption({ value: range, selected: () => {
					return view.range === range;
				} }, "Last " + range);
			}));
		}),
		NativeSelect({
			size: "sm",
			"aria-label": "Live refresh",
			onchange: (event) => {
				view.refresh = Number(event.target.value);
			}
		}, ...REFRESH.map((ms) => {
			return NativeSelectOption({ value: String(ms), selected: () => {
				return view.refresh === ms;
			} }, ms ? "Live " + (ms / 1000) + "s" : "Live off");
		})),
		Button({ size: "sm", variant: "outline", onclick: refresh, title: "Refresh now" }, "Refresh"));
};

const FilterPills = () => {
	const adder = state({ open: false, field: "", value: "" });

	const submit = () => {
		if (!adder.field.trim()) {
			return;
		}

		const raw = adder.value.trim();
		let value = raw;

		if (/^-?\d+(\.\d+)?$/.test(raw)) {
			value = Number(raw);
		}

		if (raw === "") {
			addFilter({ field: adder.field.trim(), op: "exists" });
		} else {
			addFilter({ field: adder.field.trim(), value });
		}

		batch(() => {
			adder.open = false;
			adder.field = "";
			adder.value = "";
		});
	};

	return el("div", { class: "dc-pills" },
		() => {
			return view.filters.map((f, i) => {
				return el("span", { class: "dc-pill" + (f.negate ? " dc-pill-neg" : "") + (f.disabled ? " dc-pill-off" : "") },
					el("button", { type: "button", class: "dc-pill-text", title: "Enable/disable", onclick: () => {
						updateFilter(i, { disabled: !f.disabled });
					} }, describeFilter(f)),
					el("button", { type: "button", class: "dc-mini", title: "Negate", onclick: () => {
						updateFilter(i, { negate: !f.negate });
					} }, "¬"),
					el("button", { type: "button", class: "dc-mini", title: "Remove", onclick: () => {
						removeFilter(i);
					} }, "×"));
			});
		},
		when(() => {
			return adder.open;
		}, () => {
			return el("span", { class: "dc-pill-form" },
				Input({ class: "dc-narrow", placeholder: "field", bind: [adder, "field"] }),
				Input({ class: "dc-narrow", placeholder: "value (empty = exists)", bind: [adder, "value"], onkeydown: (event) => {
					if (event.key === "Enter") {
						submit();
					}
				} }),
				Button({ size: "sm", onclick: submit }, "Add"),
				Button({ size: "sm", variant: "ghost", onclick: () => {
					adder.open = false;
				} }, "Cancel"));
		}, () => {
			return Button({ size: "sm", variant: "ghost", class: "dc-add-filter", onclick: () => {
				adder.open = true;
			} }, "+ Add filter");
		}),
		when(() => {
			return view.filters.length > 0;
		}, () => {
			return Button({ size: "sm", variant: "link", onclick: () => {
				view.filters = [];
			} }, "Clear all");
		}));
};

const Status = () => {
	return el("div", { class: "dc-status" },
		() => {
			const s = live.stats;

			if (!s) {
				return null;
			}

			const ratio = s.classified_ratio.last_5m !== null ? s.classified_ratio.last_5m : s.classified_ratio.all_time;
			return el("span", { class: "dc-muted", title: "Classified share (last 5m)" },
				ratio === null ? "no records yet" : Math.round(ratio * 1000) / 10 + "% classified · " + s.records.rate_1m + "/s");
		},
		el("span", {
			class: () => {
				return "dc-dot " + (live.connected ? "dc-dot-on" : "dc-dot-off");
			},
			title: () => {
				return live.connected ? "Live connection" : "Disconnected";
			}
		}),
		when(() => {
			return live.readOnly;
		}, () => {
			return Badge({ variant: "outline" }, "read-only");
		}),
		Button({ size: "sm", variant: "ghost", title: "Toggle light/dark", onclick: toggleTheme }, "Theme"));
};

const Nav = () => {
	return el("nav", { class: "dc-nav" }, ...NAV.map((item) => {
		return el("a", {
			href: () => {
				return hrefFor(item.page, "", { c: view.c });
			},
			class: () => {
				return "dc-nav-link" + (view.page === item.page ? " dc-nav-active" : "");
			}
		}, item.label, item.page === "unclassified" ? () => {
			const s = live.stats;
			return s && s.queue.clusters ? el("span", { class: "dc-count" }, String(s.queue.clusters)) : null;
		} : null);
	}));
};

/**
 * @param {Object<string, function(): Node>} pages
 * @param {function(): Node} editorComponent
 */
export const Shell = (pages, editorComponent) => {
	return el("div", { class: "dc-app" },
		el("header", { class: "dc-header" },
			el("a", { class: "dc-brand", href: "#/discover" }, "diversity", el("span", {}, "classifier")),
			Nav(),
			Status()),
		el("div", { class: "dc-toolbar" }, QueryBar(), TimePicker()),
		FilterPills(),
		el("main", { class: "dc-main" }, when(() => {
			return view.page;
		}, (page) => {
			const render = pages[page];

			if (!render) {
				return el("div", { class: "dc-error" }, "Unknown page " + page);
			}

			return render();
		})),
		editorComponent());
};
