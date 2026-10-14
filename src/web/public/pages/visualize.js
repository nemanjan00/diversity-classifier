import {
	state, el, effect, batch, toast,
	Button, Card, Input, Label, NativeSelect, NativeSelectOption
} from "@nemanjan00/qrp-shadcdn";
import { api } from "../lib/api.js";
import { resource } from "../lib/resource.js";
import { live } from "../lib/live.js";
import { view, go, hrefFor } from "../lib/view.js";
import { VizView, VIZ_TYPES, AGGS } from "../lib/viz.js";

/*
 * Visualize: chart builder over the global query (bar, histogram, line, area,
 * heatmap, metric, table). Saved charts feed dashboards.
 */

const DEBOUNCE_MS = 400;

/** Set by other pages ("Visualize" in the Discover field sidebar) before navigating here. */
export const vizPreset = state({ value: null });

const blank = () => {
	return { name: "", title: "", type: "bar", classifier: "", field: "", agg: "count", split_by: "", interval: "", buckets: 20, top: 15 };
};

const clean = (b) => {
	const out = { type: b.type };
	["name", "title", "classifier", "field", "split_by", "interval"].forEach((key) => {
		if (b[key]) {
			out[key] = b[key];
		}
	});

	if (b.agg && b.agg !== "count") {
		out.agg = b.agg;
	}

	if (b.type === "histogram" || b.type === "heatmap") {
		out.buckets = Number(b.buckets) || 20;
	}

	if (b.type === "bar" || b.type === "table" || b.type === "line" || b.type === "area") {
		out.top = Number(b.top) || 15;
	}

	if (b.type === "table" && b.split_by) {
		out.group_by = b.split_by.split(",").map((s) => {
			return s.trim();
		}).filter(Boolean);
	}

	return out;
};

/** `list` is a read-only DOM property, so set the datalist link as an attribute. */
const withList = (node) => {
	node.setAttribute("list", "dc-viz-fields");
	return node;
};

const control = (label, node) => {
	return el("div", { class: "dc-field" }, Label({}, label), node);
};

export const VizBuilder = () => {
	const b = state(blank());
	const committed = state({ json: "" });
	const views = resource(() => {
		live.defRev;
		return api("list_views", {});
	});
	const fields = resource(() => {
		live.defRev;
		return api("fields", { classifier: b.classifier || undefined });
	});

	if (vizPreset.value) {
		Object.assign(b, blank(), vizPreset.value);
		vizPreset.value = null;
	}

	effect(() => {
		const name = view.param;
		const data = views.data;

		if (!name || !data) {
			return;
		}

		const saved = data.visualizations.find((v) => {
			return v.name === name;
		});

		if (saved) {
			batch(() => {
				Object.assign(b, blank(), saved, { split_by: saved.group_by ? saved.group_by.join(",") : (saved.split_by || "") });
			});
		}
	});

	let timer = null;
	effect(() => {
		const json = JSON.stringify(clean(b));
		clearTimeout(timer);
		timer = setTimeout(() => {
			committed.json = json;
		}, DEBOUNCE_MS);
	});

	const save = () => {
		const def = clean(b);

		if (!def.name) {
			toast.error("Give the visualization a name");
			return;
		}

		api("define_visualization", def).then(() => {
			toast.success("Saved visualization " + def.name);
			go("visualize", def.name);
		}).catch((error) => {
			toast.error(error.message);
		});
	};

	const fieldOptions = () => {
		const data = fields.data;

		if (!data) {
			return [];
		}

		const names = new Set(["$source", "classifier"]);
		data.classifiers.forEach((c) => {
			c.fields.forEach((f) => {
				names.add(f.field);
			});
		});

		return Array.from(names).sort();
	};

	const select = (key, options) => {
		return NativeSelect({ size: "sm", onchange: (event) => {
			b[key] = event.target.value;
		} }, ...options.map((option) => {
			const value = Array.isArray(option) ? option[0] : option;
			const text = Array.isArray(option) ? option[1] : option;
			return NativeSelectOption({ value, selected: () => {
				return String(b[key]) === value;
			} }, text);
		}));
	};

	return el("div", { class: "dc-page dc-viz-page" },
		el("aside", { class: "dc-sidebar dc-builder" },
			el("div", { class: "dc-side-title" }, "Chart"),
			control("Type", select("type", VIZ_TYPES)),
			control("Classifier (glob)", Input({ bind: [b, "classifier"], placeholder: "all" })),
			el("datalist", { id: "dc-viz-fields" }, () => {
				return fieldOptions().map((name) => {
					return el("option", { value: name });
				});
			}),
			control("Field", withList(Input({ bind: [b, "field"], placeholder: "status" }))),
			control("Aggregate", select("agg", AGGS)),
			control(() => {
				return b.type === "table" ? "Group by (comma separated)" : "Split by";
			}, withList(Input({ bind: [b, "split_by"], placeholder: "optional" }))),
			control("Interval", Input({ bind: [b, "interval"], placeholder: "auto (e.g. 30s, 1m)" })),
			el("div", { class: "dc-grid2" },
				control("Buckets", Input({ type: "number", bind: [b, "buckets"] })),
				control("Top N", Input({ type: "number", bind: [b, "top"] }))),
			el("div", { class: "dc-side-title" }, "Save"),
			control("Name", Input({ bind: [b, "name"], placeholder: "status-codes" })),
			control("Title", Input({ bind: [b, "title"], placeholder: "optional" })),
			() => {
				return live.readOnly ? null : Button({ onclick: save }, "Save visualization");
			},
			el("div", { class: "dc-side-title" }, "Saved"),
			() => {
				const data = views.data;

				if (!data || !data.visualizations.length) {
					return el("p", { class: "dc-muted" }, "None yet.");
				}

				return el("div", { class: "dc-saved" }, ...data.visualizations.map((v) => {
					return el("a", { href: hrefFor("visualize", v.name), class: "dc-saved-link" }, v.title || v.name, el("small", {}, v.type));
				}));
			}),
		el("section", { class: "dc-content" },
			Card({ class: "dc-card" },
				el("div", { class: "dc-card-head" }, el("strong", {}, () => {
					return b.title || b.name || "Untitled " + b.type;
				}), el("span", { class: "dc-muted" }, "Uses the global query, filters and time range. Click values to filter.")),
				VizView(() => {
					return committed.json ? JSON.parse(committed.json) : null;
				}))));
};

export const VisualizePage = VizBuilder;
