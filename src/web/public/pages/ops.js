import {
	el, toast,
	Button, Badge, Card, Skeleton,
	Table, TableHeader, TableBody, TableRow, TableHead, TableCell
} from "@nemanjan00/qrp-shadcdn";
import { api } from "../lib/api.js";
import { resource } from "../lib/resource.js";
import { live } from "../lib/live.js";
import { tick, refresh, hrefFor, formatNumber, formatTime } from "../lib/view.js";

/*
 * Alarms & Sources: alarm states and firing history (each firing links to
 * Discover around its time), and per-source / per-demux-stream health.
 */

const BEFORE_MS = 300000;
const AFTER_MS = 60000;

const sourceAction = (tool, name) => {
	api(tool, { name }).then(() => {
		toast.success(tool.replace("_source", "") + "ed " + name);
		refresh();
	}).catch((error) => {
		toast.error(error.message);
	});
};

const stateBadge = (value) => {
	const variants = { firing: "destructive", running: "default", ok: "secondary", paused: "outline", exited: "destructive", error: "destructive", stopped: "outline" };
	return Badge({ variant: variants[value] || "outline" }, value);
};

const paramsText = (params) => {
	return Object.keys(params || {}).map((k) => {
		return k + "=" + (typeof params[k] === "object" ? JSON.stringify(params[k]) : params[k]);
	}).join(" ");
};

const Alarms = () => {
	const alarms = resource(() => {
		tick.n;
		live.defRev;
		return api("list_alarms", {});
	});

	return Card({ class: "dc-card" },
		el("div", { class: "dc-card-head" }, el("strong", {}, "Alarms")),
		() => {
			const data = alarms.data;

			if (!data) {
				return Skeleton({ class: "dc-skel" });
			}

			if (!data.alarms.length) {
				return el("p", { class: "dc-muted" }, "No alarms defined (the agent adds them with define_alarm).");
			}

			return Table({},
				TableHeader({}, TableRow({}, TableHead({}, "name"), TableHead({}, "state"), TableHead({}, "kind"), TableHead({}, "on"), TableHead({}, "fired"), TableHead({}, "last fired"))),
				TableBody({}, ...data.alarms.map((a) => {
					return TableRow({},
						TableCell({}, el("strong", {}, a.name), a.message ? el("div", { class: "dc-muted" }, a.message) : null),
						TableCell({}, stateBadge(a.state), a.enabled === false ? Badge({ variant: "outline" }, "disabled") : null),
						TableCell({}, a.kind, el("div", { class: "dc-muted" }, paramsText(a.params))),
						TableCell({}, a.classifier ? el("a", { href: hrefFor("classifiers", a.classifier) }, a.classifier) : "–", a.q ? el("div", { class: "dc-muted dc-mono" }, a.q) : null),
						TableCell({}, formatNumber(a.fired) + (a.suppressed ? " (+" + a.suppressed + " suppressed)" : "")),
						TableCell({}, a.last_fired ? formatTime(Date.parse(a.last_fired), true) : "never"));
				})));
		});
};

const History = () => {
	const history = resource(() => {
		tick.n;
		live.defRev;
		return api("alarm_history", { limit: 50 });
	});

	return Card({ class: "dc-card" },
		el("div", { class: "dc-card-head" }, el("strong", {}, "Recent firings")),
		() => {
			const data = history.data;

			if (!data) {
				return Skeleton({ class: "dc-skel" });
			}

			if (!data.firings.length) {
				return el("p", { class: "dc-muted" }, "Nothing fired yet.");
			}

			return el("div", { class: "dc-history" }, ...data.firings.map((f) => {
				const t = Date.parse(f.t);
				return el("a", {
					class: "dc-history-row",
					href: hrefFor("discover", "", { c: f.classifier || "", from: t - BEFORE_MS, to: t + AFTER_MS, refresh: 0, mode: "events" }),
					title: "Open Discover around this firing"
				},
				el("span", { class: "dc-time" }, formatTime(t, true)),
				Badge({ variant: "destructive" }, f.alarm),
				el("span", {}, f.text),
				f.message ? el("span", { class: "dc-muted" }, f.message) : null,
				f.sample && f.sample.raw ? el("code", { class: "dc-line-raw" }, f.sample.raw) : null);
			}));
		});
};

const Sources = () => {
	const sources = resource(() => {
		tick.n;
		live.defRev;
		live.stats;
		return api("list_sources", {});
	});

	return Card({ class: "dc-card" },
		el("div", { class: "dc-card-head" }, el("strong", {}, "Sources")),
		() => {
			const data = sources.data;

			if (!data) {
				return Skeleton({ class: "dc-skel" });
			}

			if (!data.sources.length) {
				return el("p", { class: "dc-muted" }, "No sources. The agent adds them with add_source (e.g. a command like ssh host journalctl -f).");
			}

			return Table({},
				TableHeader({}, TableRow({}, TableHead({}, "name"), TableHead({}, "state"), TableHead({}, "target"), TableHead({}, "records"), TableHead({}, "classified"), TableHead({}, "last record"), TableHead({}, ""))),
				TableBody({}, ...data.sources.reduce((rows, s) => {
					rows.push(TableRow({},
						TableCell({}, el("strong", {}, s.name), el("div", { class: "dc-muted" }, s.type + " · " + s.origin)),
						TableCell({}, stateBadge(s.state), s.restarts ? el("div", { class: "dc-muted" }, s.restarts + " restart(s)") : null, s.error ? el("div", { class: "dc-error" }, s.error) : null),
						TableCell({}, el("code", { class: "dc-mono dc-target" }, s.target || "")),
						TableCell({}, formatNumber(s.records)),
						TableCell({}, s.classified_pct === null || s.classified_pct === undefined ? "–" : s.classified_pct + "%"),
						TableCell({}, s.last_record ? formatTime(Date.parse(s.last_record), true) : "never"),
						TableCell({}, live.readOnly ? null : el("div", { class: "dc-row" },
							s.state === "paused" || s.state === "exited" || s.state === "stopped" ? Button({ size: "xs", onclick: () => {
								sourceAction("start_source", s.name);
							} }, "Start") : null,
							s.type !== "ingest" ? Button({ size: "xs", variant: "outline", onclick: () => {
								sourceAction("restart_source", s.name);
							} }, "Restart") : null))));

					(s.streams || []).forEach((stream) => {
						rows.push(TableRow({ class: "dc-substream" },
							TableCell({}, el("span", { class: "dc-muted" }, "↳ " + stream.label)),
							TableCell({}, ""),
							TableCell({}, ""),
							TableCell({}, formatNumber(stream.records)),
							TableCell({}, ""),
							TableCell({}, formatTime(Date.parse(stream.last_record), true)),
							TableCell({}, "")));
					});

					return rows;
				}, [])));
		});
};

export const OpsPage = () => {
	return el("div", { class: "dc-page" },
		el("div", { class: "dc-page-head" }, el("h1", {}, "Alarms & Sources")),
		Alarms(),
		History(),
		Sources());
};
