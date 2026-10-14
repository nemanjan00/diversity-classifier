import {
	state, el, when, toast,
	Button, Badge, Card, NativeSelect, NativeSelectOption, Skeleton,
	Empty, EmptyHeader, EmptyTitle, EmptyDescription
} from "@nemanjan00/qrp-shadcdn";
import { api } from "../lib/api.js";
import { resource } from "../lib/resource.js";
import { live } from "../lib/live.js";
import { tick, refresh, formatNumber, formatTime } from "../lib/view.js";
import { sparkline } from "../lib/charts.js";
import { openEditor, templateView } from "../lib/editor.js";

/*
 * The unclassified queue: clusters of records nothing matches. Classify opens
 * the editor with the suggested template; Ignore makes a count-only classifier.
 * An empty page means everything is understood.
 */

const LIMIT = 50;

const shapeView = (shape) => {
	const parts = shape.split(/(<(?:str|uuid|ts|url|ip|email|path|hex|id|dur|bytes|num)>)/g);
	return el("code", { class: "dc-shape" }, ...parts.map((part) => {
		return /^<\w+>$/.test(part) ? el("span", { class: "dc-ph" }, part) : part;
	}));
};

/** "app" envelope + "pool exhausted waiting=<num>" → "app.pool_exhausted". */
const suggestName = (cluster) => {
	const words = cluster.shape.replace(/<\w+>/g, " ").split(/[^A-Za-z]+/).filter((w) => {
		return w.length > 2;
	}).slice(0, 2).map((w) => {
		return w.toLowerCase();
	});
	const base = words.length ? words.join("_") : "cluster_" + cluster.id;
	return (cluster.envelope ? cluster.envelope + "." : "") + base;
};

const ignore = (id) => {
	api("ignore_cluster", { id }).then((r) => {
		toast.success("Ignoring cluster " + id, { description: "Created " + r.classifier + " (count only); absorbed " + r.retro.absorbed });
		refresh();
	}).catch((error) => {
		toast.error(error.message);
	});
};

const ClusterCard = (cluster) => {
	const open = state({ examples: false });
	const total = Object.keys(cluster.sources || {}).length;

	return Card({ class: "dc-card dc-cluster" },
		el("div", { class: "dc-cluster-head" },
			el("span", { class: "dc-cluster-count" }, formatNumber(cluster.count)),
			shapeView(cluster.shape),
			el("span", { class: "dc-spacer" }),
			sparkline(cluster.spark_30m || [], { width: 110, height: 22, color: 1 })),
		el("div", { class: "dc-cluster-meta" },
			Badge({ variant: "outline" }, cluster.id),
			cluster.envelope ? Badge({ variant: "secondary" }, "under " + cluster.envelope) : null,
			el("span", { class: "dc-muted" }, total + " source(s): " + Object.keys(cluster.sources || {}).map((s) => {
				return s + " ×" + formatNumber(cluster.sources[s]);
			}).join(", ")),
			el("span", { class: "dc-muted" }, "last " + formatTime(Date.parse(cluster.last_seen), true)),
			cluster.buffered < cluster.count ? el("span", { class: "dc-muted" }, formatNumber(cluster.buffered) + " buffered") : null),
		el("div", { class: "dc-suggest-row" }, el("small", { class: "dc-muted" }, "suggested"), templateView(cluster.suggested_template)),
		el("div", { class: "dc-cluster-actions" },
			Button({ size: "sm", variant: "ghost", onclick: () => {
				open.examples = !open.examples;
			} }, () => {
				return open.examples ? "Hide examples" : "Examples (" + (cluster.examples || []).length + ")";
			}),
			el("span", { class: "dc-spacer" }),
			live.readOnly ? null : Button({ size: "sm", variant: "outline", onclick: () => {
				ignore(cluster.id);
			} }, "Ignore"),
			live.readOnly ? null : Button({ size: "sm", onclick: () => {
				openEditor({ name: suggestName(cluster), template: cluster.suggested_template, parent: cluster.envelope || "" }, { cluster: cluster.id });
			} }, "Classify")),
		when(() => {
			return open.examples;
		}, () => {
			return el("div", { class: "dc-examples" }, ...(cluster.examples || []).map((example) => {
				return el("pre", { class: "dc-raw" }, el("span", { class: "dc-muted" }, formatTime(example.t) + " " + example.source + "  "), example.raw);
			}));
		}));
};

export const UnclassifiedPage = () => {
	const opts = state({ sort: "count" });
	const data = resource(() => {
		tick.n;
		live.queueRev;
		live.defRev;
		return api("get_unclassified", { verbose: true, limit: LIMIT, sort: opts.sort });
	});

	return el("div", { class: "dc-page" },
		el("div", { class: "dc-page-head" },
			el("h1", {}, "Unclassified"),
			() => {
				const q = data.data ? data.data.queue : null;
				return q ? el("span", { class: "dc-muted" }, formatNumber(q.clusters) + " clusters · " + formatNumber(q.records) + " records" +
					(q.evicted_records ? " · " + formatNumber(q.evicted_records) + " evicted (queue overflowed)" : "")) : null;
			},
			el("span", { class: "dc-spacer" }),
			NativeSelect({ size: "sm", onchange: (event) => {
				opts.sort = event.target.value;
			} },
			NativeSelectOption({ value: "count" }, "Biggest first"),
			NativeSelectOption({ value: "recent" }, "Most recent"),
			NativeSelectOption({ value: "new" }, "Newest clusters"))),
		el("p", { class: "dc-muted" }, "Records no classifier matches, grouped by shape. Classify the biggest clusters first; every classifier you save absorbs matching records immediately."),
		() => {
			if (data.error) {
				return el("div", { class: "dc-error" }, data.error);
			}

			if (!data.data) {
				return Skeleton({ class: "dc-skel-table" });
			}

			if (!data.data.clusters.length) {
				return Empty(EmptyHeader(EmptyTitle("Everything is understood"), EmptyDescription("No unclassified records. New unknown lines will show up here (and be reported to the agent).")));
			}

			return el("div", { class: "dc-clusters" }, ...data.data.clusters.map(ClusterCard));
		});
};
