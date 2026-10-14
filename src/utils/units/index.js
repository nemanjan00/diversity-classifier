const DURATION_UNITS = {
	ns: 1e-6,
	us: 1e-3,
	"µs": 1e-3,
	ms: 1,
	s: 1000,
	sec: 1000,
	m: 60000,
	min: 60000,
	h: 3600000,
	hr: 3600000,
	d: 86400000
};

const BYTE_UNITS = {
	b: 1,
	k: 1e3,
	kb: 1e3,
	kib: 1024,
	m: 1e6,
	mb: 1e6,
	mib: 1024 * 1024,
	g: 1e9,
	gb: 1e9,
	gib: 1024 * 1024 * 1024,
	t: 1e12,
	tb: 1e12,
	tib: 1024 * 1024 * 1024 * 1024
};

const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|sec|min|hr|s|m|h|d)/gy;
const BYTES_RE = /^(\d+(?:\.\d+)?)\s*([kmgt]i?b?|b)?$/i;

/**
 * "250ms", "1.5s", "1h30m", "2m" → milliseconds. A bare number is ms.
 * Returns undefined when not a duration.
 */
const parseDuration = (input) => {
	if (typeof input === "number") {
		return input;
	}

	const text = String(input).trim();

	if (/^-?\d+(\.\d+)?$/.test(text)) {
		return parseFloat(text);
	}

	DURATION_PART.lastIndex = 0;
	let total = 0;
	let matched = 0;
	let m = DURATION_PART.exec(text);

	while (m) {
		total += parseFloat(m[1]) * DURATION_UNITS[m[2]];
		matched = DURATION_PART.lastIndex;
		m = DURATION_PART.exec(text);
	}

	if (matched === 0 || matched !== text.length) {
		return undefined;
	}

	return total;
};

/** "12KB", "3.4MiB", "1G", "512" → bytes. */
const parseBytes = (input) => {
	if (typeof input === "number") {
		return input;
	}

	const m = BYTES_RE.exec(String(input).trim());

	if (!m) {
		return undefined;
	}

	const unit = (m[2] || "b").toLowerCase();
	const factor = BYTE_UNITS[unit] || BYTE_UNITS[unit + "b"];

	if (!factor) {
		return undefined;
	}

	return parseFloat(m[1]) * factor;
};

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Timestamps in common log formats → epoch ms. Returns undefined when unknown.
 * ISO-8601, "YYYY-MM-DD HH:MM:SS[.fff]", syslog "Mmm dd HH:MM:SS", epoch s/ms,
 * nginx "dd/Mmm/YYYY:HH:MM:SS +zzzz".
 */
const parseTimestamp = (input) => {
	if (typeof input === "number") {
		return input < 1e11 ? input * 1000 : input;
	}

	const text = String(input).trim();

	if (/^\d{10}(\.\d+)?$/.test(text)) {
		return Math.round(parseFloat(text) * 1000);
	}

	if (/^\d{13}$/.test(text)) {
		return parseInt(text, 10);
	}

	const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);

	if (iso) {
		const frac = iso[3] ? "." + iso[3].slice(0, 3).padEnd(3, "0") : "";
		let zone = iso[4] || "";

		if (zone && zone !== "Z" && zone.indexOf(":") === -1) {
			zone = zone.slice(0, 3) + ":" + zone.slice(3);
		}

		const ms = Date.parse(iso[1] + "T" + iso[2] + frac + zone);
		return isNaN(ms) ? undefined : ms;
	}

	const syslog = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text);

	if (syslog) {
		const month = MONTHS[syslog[1].toLowerCase()];

		if (month === undefined) {
			return undefined;
		}

		const now = new Date();
		const date = new Date(now.getFullYear(), month, parseInt(syslog[2], 10),
			parseInt(syslog[3], 10), parseInt(syslog[4], 10), parseInt(syslog[5], 10),
			syslog[6] ? parseInt(syslog[6].slice(0, 3).padEnd(3, "0"), 10) : 0);

		if (date.getTime() > now.getTime() + 86400000) {
			date.setFullYear(date.getFullYear() - 1);
		}

		return date.getTime();
	}

	const clf = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/.exec(text);

	if (clf) {
		const month = MONTHS[clf[2].toLowerCase()];

		if (month === undefined) {
			return undefined;
		}

		const mm = String(month + 1).padStart(2, "0");
		const zone = clf[7] ? clf[7].slice(0, 3) + ":" + clf[7].slice(3) : "Z";
		const ms = Date.parse(clf[3] + "-" + mm + "-" + clf[1] + "T" + clf[4] + ":" + clf[5] + ":" + clf[6] + zone);
		return isNaN(ms) ? undefined : ms;
	}

	const fallback = Date.parse(text);
	return isNaN(fallback) ? undefined : fallback;
};

/**
 * Time reference → epoch ms. Accepts "now", relative "-15m" / "15m" (ago),
 * ISO strings and numbers.
 */
const parseTime = (input, now) => {
	const base = now || Date.now();

	if (input === undefined || input === null || input === "") {
		return undefined;
	}

	if (typeof input === "number") {
		return input;
	}

	const text = String(input).trim();

	if (text === "now") {
		return base;
	}

	const rel = /^-?(\d.*)$/.exec(text);

	if (rel && !/^\d{4}-/.test(text) && !/^\d{10,13}$/.test(text)) {
		const ms = parseDuration(rel[1]);

		if (ms !== undefined) {
			return base - ms;
		}
	}

	return parseTimestamp(text);
};

/** Pick a "nice" bucket interval giving roughly `target` buckets over `span` ms. */
const NICE_INTERVALS = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000,
	900000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000];

const autoInterval = (span, target) => {
	const ideal = span / (target || 60);
	const found = NICE_INTERVALS.find((ms) => {
		return ms >= ideal;
	});

	return found || NICE_INTERVALS[NICE_INTERVALS.length - 1];
};

module.exports = {
	parseDuration,
	parseBytes,
	parseTimestamp,
	parseTime,
	autoInterval
};
