import { state, effect, batch, untracked } from "@nemanjan00/qrp-shadcdn";

/*
 * Global view state (page, query, filters, time range, live refresh) kept in
 * the URL hash so every view is linkable:
 *   #/<page>/<param>?q=...&f=<json>&range=15m&from=..&to=..&refresh=5000&c=..&mode=..
 */

export const RANGES = ["5m", "15m", "1h", "6h", "24h"];
export const REFRESH = [0, 1000, 5000, 30000];

const DEFAULTS = {
	page: "discover",
	param: "",
	q: "",
	filters: [],
	range: "15m",
	from: null,
	to: null,
	refresh: 0,
	c: "",
	mode: "events",
	stack: "",
	cols: []
};

export const view = state(Object.assign({}, DEFAULTS, { filters: [], cols: [] }));

/** Bumped to force every data effect to refetch (refresh button, live timer, definition changes). */
export const tick = state({ n: 0 });

export const refresh = () => {
	tick.n++;
};

const parseHash = (hash) => {
	const text = hash.replace(/^#\/?/, "");
	const qIndex = text.indexOf("?");
	const pathPart = qIndex === -1 ? text : text.slice(0, qIndex);
	const query = new URLSearchParams(qIndex === -1 ? "" : text.slice(qIndex + 1));
	const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
	const out = Object.assign({}, DEFAULTS, { filters: [], cols: [] });

	out.page = segments[0] || DEFAULTS.page;
	out.param = segments.slice(1).join("/");
	out.q = query.get("q") || "";
	out.range = query.get("range") || DEFAULTS.range;
	out.from = query.get("from") ? Number(query.get("from")) : null;
	out.to = query.get("to") ? Number(query.get("to")) : null;
	out.refresh = query.get("refresh") ? Number(query.get("refresh")) : 0;
	out.c = query.get("c") || "";
	out.mode = query.get("mode") || "events";
	out.stack = query.get("stack") || "";
	out.cols = query.get("cols") ? query.get("cols").split(",").filter(Boolean) : [];

	try {
		out.filters = query.get("f") ? JSON.parse(query.get("f")) : [];
	} catch (e) {
		out.filters = [];
	}

	return out;
};

const buildHash = (v) => {
	const query = new URLSearchParams();
	const set = (key, value) => {
		if (value !== null && value !== undefined && value !== "" && value !== DEFAULTS[key]) {
			query.set(key, String(value));
		}
	};

	set("q", v.q);
	set("range", v.range);
	set("from", v.from);
	set("to", v.to);
	set("refresh", v.refresh || null);
	set("c", v.c);
	set("mode", v.mode);
	set("stack", v.stack);

	if (v.cols.length) {
		query.set("cols", v.cols.join(","));
	}

	if (v.filters.length) {
		query.set("f", JSON.stringify(v.filters));
	}

	const path = "#/" + encodeURIComponent(v.page) + (v.param ? "/" + v.param.split("/").map(encodeURIComponent).join("/") : "");
	const qs = query.toString();
	return path + (qs ? "?" + qs : "");
};

const snapshot = () => {
	return {
		page: view.page,
		param: view.param,
		q: view.q,
		filters: view.filters.map((f) => {
			return Object.assign({}, f);
		}),
		range: view.range,
		from: view.from,
		to: view.to,
		refresh: view.refresh,
		c: view.c,
		mode: view.mode,
		stack: view.stack,
		cols: view.cols.slice()
	};
};

const applyHash = () => {
	const parsed = parseHash(location.hash);

	if (buildHash(parsed) === untracked(() => {
		return buildHash(snapshot());
	})) {
		return;
	}

	batch(() => {
		Object.keys(parsed).forEach((key) => {
			view[key] = parsed[key];
		});
	});
};

/** Start two-way sync between `view` and location.hash. */
export const startUrlSync = () => {
	applyHash();
	window.addEventListener("hashchange", applyHash);

	effect(() => {
		const next = buildHash(snapshot());

		if (next !== location.hash) {
			history.replaceState(null, "", next);
		}
	});

	let timer = null;
	effect(() => {
		const ms = view.refresh;
		clearInterval(timer);

		if (ms > 0) {
			timer = setInterval(refresh, ms);
		}
	});
};

/**
 * Navigate to a page, keeping the global query/time state.
 * @param {string} page
 * @param {string} [param]
 * @param {object} [overrides] other view keys to set (e.g. { c, filters })
 */
export const go = (page, param, overrides) => {
	const next = Object.assign(snapshot(), { page, param: param || "" }, overrides || {});
	location.hash = buildHash(next);
};

/** href for a link to a page (keeps global state). */
export const hrefFor = (page, param, overrides) => {
	return buildHash(Object.assign(snapshot(), { page, param: param || "" }, overrides || {}));
};

// --- filters -----------------------------------------------------------------

/**
 * Add a filter pill.
 * @param {{ field: string, op?: "eq"|"range"|"exists", value?: *, from?: number, to?: number, negate?: boolean }} filter
 */
export const addFilter = (filter) => {
	const f = Object.assign({ op: "eq", negate: false, disabled: false }, filter);
	const same = view.filters.findIndex((existing) => {
		return existing.field === f.field && existing.op === f.op && JSON.stringify(existing.value) === JSON.stringify(f.value) &&
			existing.from === f.from && existing.to === f.to;
	});

	if (same !== -1) {
		view.filters = view.filters.map((existing, i) => {
			return i === same ? Object.assign({}, existing, { negate: f.negate, disabled: false }) : existing;
		});
		return;
	}

	view.filters = view.filters.concat([f]);
};

export const updateFilter = (index, change) => {
	view.filters = view.filters.map((existing, i) => {
		return i === index ? Object.assign({}, existing, change) : existing;
	});
};

export const removeFilter = (index) => {
	view.filters = view.filters.filter((_f, i) => {
		return i !== index;
	});
};

const filterClause = (f) => {
	const clause = {};

	if (f.op === "range") {
		const range = {};

		if (f.from !== undefined && f.from !== null) {
			range.gte = f.from;
		}

		if (f.to !== undefined && f.to !== null) {
			range.lt = f.to;
		}

		clause[f.field] = range;
	} else if (f.op === "exists") {
		clause[f.field] = { exists: true };
	} else {
		clause[f.field] = f.value;
	}

	return f.negate ? { not: clause } : clause;
};

export const filtersWhere = (filters) => {
	const active = (filters || view.filters).filter((f) => {
		return !f.disabled;
	});

	if (!active.length) {
		return undefined;
	}

	return { and: active.map(filterClause) };
};

export const describeFilter = (f) => {
	let body = "";

	if (f.op === "range") {
		body = f.field + " ∈ [" + formatNumber(f.from) + ", " + formatNumber(f.to) + ")";
	} else if (f.op === "exists") {
		body = "exists " + f.field;
	} else {
		body = f.field + ": " + (typeof f.value === "string" ? f.value : JSON.stringify(f.value));
	}

	return (f.negate ? "NOT " : "") + body;
};

// --- time --------------------------------------------------------------------

/** Current time bounds as API args. Reads view reactively. */
export const timeArgs = () => {
	if (view.from) {
		return { since: new Date(view.from).toISOString(), until: view.to ? new Date(view.to).toISOString() : undefined };
	}

	return { since: "-" + view.range };
};

/** Absolute ms bounds of the current range (for chart domains). */
export const timeBounds = () => {
	if (view.from) {
		return { from: view.from, to: view.to || Date.now() };
	}

	const units = { m: 60000, h: 3600000, d: 86400000 };
	const m = /^(\d+)([mhd])$/.exec(view.range) || ["", "15", "m"];
	const now = Date.now();
	return { from: now - Number(m[1]) * units[m[2]], to: now };
};

/** Common query args: q + filters + time. Reads view and tick reactively. */
export const queryArgs = (extra) => {
	tick.n;
	return Object.assign({ q: view.q || undefined, where: filtersWhere() }, timeArgs(), extra || {});
};

export const setAbsoluteRange = (from, to) => {
	batch(() => {
		view.from = Math.round(from);
		view.to = Math.round(to);
		view.refresh = 0;
	});
};

// --- formatting --------------------------------------------------------------

export const formatNumber = (n) => {
	if (n === null || n === undefined || Number.isNaN(n)) {
		return "–";
	}

	if (typeof n !== "number") {
		return String(n);
	}

	const abs = Math.abs(n);

	if (abs >= 1e9) {
		return (n / 1e9).toFixed(1) + "G";
	}

	if (abs >= 1e6) {
		return (n / 1e6).toFixed(1) + "M";
	}

	if (abs >= 1e4) {
		return (n / 1e3).toFixed(1) + "k";
	}

	if (Number.isInteger(n)) {
		return String(n);
	}

	return abs >= 100 ? n.toFixed(0) : n.toFixed(abs >= 1 ? 2 : 3);
};

export const formatTime = (t, withDate) => {
	const d = new Date(t);
	const pad = (x, w) => {
		return String(x).padStart(w || 2, "0");
	};
	const time = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());

	if (withDate) {
		return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + time + "." + pad(d.getMilliseconds(), 3);
	}

	return time;
};

export const formatValue = (value) => {
	if (value === null || value === undefined) {
		return "–";
	}

	if (Array.isArray(value)) {
		return value.join(", ");
	}

	if (typeof value === "object") {
		return JSON.stringify(value);
	}

	return String(value);
};
