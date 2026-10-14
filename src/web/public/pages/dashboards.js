import {
	state, el, toast,
	Button, Card, Input, Label, Checkbox, NativeSelect, NativeSelectOption,
	Empty, EmptyHeader, EmptyTitle, EmptyDescription
} from "@nemanjan00/qrp-shadcdn";
import { api } from "../lib/api.js";
import { resource } from "../lib/resource.js";
import { live } from "../lib/live.js";
import { view, go, hrefFor } from "../lib/view.js";
import { VizView } from "../lib/viz.js";

/*
 * Dashboards: grids of saved visualizations sharing the global query, filters
 * and time range. Clicking a value in any panel filters every panel.
 */

const WIDTHS = [3, 4, 6, 8, 12];

const DashboardList = (views) => {
	const draft = state({ name: "", title: "", picked: {}, widths: {} });

	const create = () => {
		const panels = Object.keys(draft.picked).filter((name) => {
			return draft.picked[name];
		}).map((name) => {
			return { visualization: name, w: Number(draft.widths[name] || 6) };
		});

		if (!draft.name || !panels.length) {
			toast.error("Name the dashboard and pick at least one visualization");
			return;
		}

		api("define_dashboard", { name: draft.name, title: draft.title || undefined, panels }).then(() => {
			toast.success("Saved dashboard " + draft.name);
			go("dashboards", draft.name);
		}).catch((error) => {
			toast.error(error.message);
		});
	};

	return el("div", { class: "dc-page" },
		el("div", { class: "dc-page-head" }, el("h1", {}, "Dashboards")),
		() => {
			const data = views.data;

			if (!data) {
				return null;
			}

			if (!data.dashboards.length) {
				return Empty(EmptyHeader(EmptyTitle("No dashboards yet"), EmptyDescription("Build one below from saved visualizations, or ask the agent to define_dashboard.")));
			}

			return el("div", { class: "dc-cards" }, ...data.dashboards.map((d) => {
				return el("a", { class: "dc-card-link", href: hrefFor("dashboards", d.name) },
					Card({ class: "dc-card" }, el("strong", {}, d.title || d.name), el("p", { class: "dc-muted" }, d.panels.length + " panel(s)" + (d.description ? " · " + d.description : ""))));
			}));
		},
		() => {
			if (live.readOnly || !views.data) {
				return null;
			}

			const vizs = views.data.visualizations;

			if (!vizs.length) {
				return el("p", { class: "dc-muted" }, "Save some visualizations first (Visualize page).");
			}

			return Card({ class: "dc-card dc-create" },
				el("strong", {}, "New dashboard"),
				el("div", { class: "dc-grid2" },
					el("div", { class: "dc-field" }, Label({}, "Name"), Input({ bind: [draft, "name"] })),
					el("div", { class: "dc-field" }, Label({}, "Title"), Input({ bind: [draft, "title"] }))),
				...vizs.map((v) => {
					return el("div", { class: "dc-row" },
						Checkbox({ checked: () => {
							return !!draft.picked[v.name];
						}, onCheckedChange: (checked) => {
							draft.picked[v.name] = checked;
						} }),
						el("span", {}, (v.title || v.name) + " (" + v.type + ")"),
						NativeSelect({ size: "sm", onchange: (event) => {
							draft.widths[v.name] = event.target.value;
						} }, ...WIDTHS.map((w) => {
							return NativeSelectOption({ value: String(w), selected: w === 6 }, w + "/12 wide");
						})));
				}),
				Button({ onclick: create }, "Create dashboard"));
		});
};

const DashboardView = (views) => {
	const remove = (name) => {
		if (!window.confirm("Delete dashboard " + name + "?")) {
			return;
		}

		api("remove_view", { kind: "dashboard", name }).then(() => {
			go("dashboards");
		}).catch((error) => {
			toast.error(error.message);
		});
	};

	return el("div", { class: "dc-page" }, () => {
		const data = views.data;

		if (!data) {
			return null;
		}

		const dash = data.dashboards.find((d) => {
			return d.name === view.param;
		});

		if (!dash) {
			return el("div", { class: "dc-error" }, "No dashboard named " + view.param);
		}

		const byName = {};
		data.visualizations.forEach((v) => {
			byName[v.name] = v;
		});

		return el("div", {},
			el("div", { class: "dc-page-head" },
				el("a", { href: hrefFor("dashboards"), class: "dc-back" }, "← Dashboards"),
				el("h1", {}, dash.title || dash.name),
				dash.q ? el("code", { class: "dc-muted" }, dash.q) : null,
				el("span", { class: "dc-spacer" }),
				live.readOnly ? null : Button({ size: "sm", variant: "ghost", onclick: () => {
					remove(dash.name);
				} }, "Delete")),
			dash.description ? el("p", { class: "dc-muted" }, dash.description) : null,
			el("div", { class: "dc-dash-grid" }, ...dash.panels.map((panel) => {
				const v = byName[panel.visualization];

				if (!v) {
					return Card({ class: "dc-card dc-error" }, "Missing visualization " + panel.visualization);
				}

				const def = Object.assign({}, v, { q: [dash.q, v.q].filter(Boolean).join(" and ") || undefined });
				return Card({ class: "dc-card dc-panel", style: "grid-column: span " + Math.min(12, Math.max(1, panel.w || 6)) },
					el("div", { class: "dc-card-head" },
						el("a", { href: hrefFor("visualize", v.name), class: "dc-panel-title" }, v.title || v.name),
						el("span", { class: "dc-muted" }, v.type + (v.field ? " · " + v.field : ""))),
					VizView(() => {
						return def;
					}));
			})));
	});
};

export const DashboardsPage = () => {
	const views = resource(() => {
		live.defRev;
		return api("list_views", {});
	});

	return el("div", {}, () => {
		return view.param ? DashboardView(views) : DashboardList(views);
	});
};
