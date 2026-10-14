const units = require("../../utils/units");
const escapeRegex = require("../../utils/glob").escapeRegex;

/*
 * Built-in capture types. Each type has:
 *   regex(args)      → regex source WITHOUT named groups
 *   convert(text, args) → value, or undefined to reject the match
 *   object           → value is an object, flattened into `name.key` fields
 *   numeric          → value is a number (drives histograms / comparisons)
 *   description      → shown by list_parsers
 */

/** Case-insensitive literal without the `i` flag (keeps the template's other parts case-sensitive). */
const ci = (word) => {
	return word.split("").map((ch) => {
		const lower = ch.toLowerCase();
		const upper = ch.toUpperCase();

		if (lower === upper) {
			return escapeRegex(ch);
		}

		return "[" + lower + upper + "]";
	}).join("");
};

const LEVELS = {
	trace: "trace",
	trc: "trace",
	debug: "debug",
	dbg: "debug",
	info: "info",
	inf: "info",
	information: "info",
	notice: "notice",
	warn: "warn",
	warning: "warn",
	wrn: "warn",
	err: "error",
	error: "error",
	eror: "error",
	crit: "critical",
	critical: "critical",
	alert: "alert",
	emerg: "emergency",
	emergency: "emergency",
	fatal: "fatal",
	ftl: "fatal",
	panic: "panic",
	severe: "error",
	v: "verbose",
	verbose: "verbose",
	d: "debug",
	i: "info",
	w: "warn",
	e: "error",
	f: "fatal"
};

const LEVEL_WORDS = Object.keys(LEVELS).sort((a, b) => {
	return b.length - a.length;
});

const unquote = (text) => {
	const quote = text[0];
	const body = text.slice(1, -1);

	if (quote === "\"") {
		try {
			return JSON.parse(text);
		} catch (e) {
			return body.replace(/\\(.)/g, "$1");
		}
	}

	return body.replace(/\\(.)/g, "$1");
};

const parseKv = (text) => {
	const out = {};
	const re = /([\w.$@-]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,]*)/g;
	let m = re.exec(text);

	while (m) {
		const raw = m[2];

		if (raw.length >= 2 && (raw[0] === "\"" || raw[0] === "'") && raw[raw.length - 1] === raw[0]) {
			out[m[1]] = unquote(raw);
		} else if (/^[-+]?\d+(\.\d+)?$/.test(raw)) {
			out[m[1]] = parseFloat(raw);
		} else {
			out[m[1]] = raw;
		}

		m = re.exec(text);
	}

	return out;
};

const toNumber = (text) => {
	const n = Number(text);
	return isFinite(n) ? n : undefined;
};

const identity = (text) => {
	return text;
};

const IPV4 = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}";
const IPV6 = "(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::";
const HOSTNAME = "(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*";
const ISO = "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:\\s?(?:Z|[+-]\\d{2}:?\\d{2}))?";
const SYSLOG_TS = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?";
const CLF_TS = "\\d{2}/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/\\d{4}:\\d{2}:\\d{2}:\\d{2}(?:\\s[+-]\\d{4})?";
const EPOCH = "\\d{13}|\\d{10}(?:\\.\\d+)?";
const NUMBER = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";

/** Zone-less timestamps: apply an explicit zone from the type argument (utc, local, +02:00). */
const withZone = (args) => {
	const zone = args && args[0] ? String(args[0]).trim() : "";

	if (!zone || zone === "local") {
		return null;
	}

	if (/^utc|z$/i.test(zone)) {
		return "Z";
	}

	if (/^[+-]\d{2}:?\d{2}$/.test(zone)) {
		return zone.length === 5 ? zone.slice(0, 3) + ":" + zone.slice(3) : zone;
	}

	throw new Error("timestamp zone must be utc, local or ±HH:MM");
};

const zoned = (text, args) => {
	const zone = withZone(args);

	if (zone && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?$/.test(text.trim())) {
		return units.parseTimestamp(text.trim() + zone);
	}

	return units.parseTimestamp(text);
};

const types = {
	word: {
		description: "non-whitespace run",
		regex: () => {
			return "\\S+";
		},
		convert: identity
	},
	text: {
		description: "any text, as short as possible (lazy)",
		regex: () => {
			return ".*?";
		},
		convert: identity
	},
	rest: {
		description: "everything to the end (greedy; spans lines in multiline records)",
		regex: () => {
			return "[\\s\\S]*";
		},
		convert: identity
	},
	int: {
		description: "integer → number",
		numeric: true,
		regex: () => {
			return "[-+]?\\d+";
		},
		convert: (text) => {
			return parseInt(text, 10);
		}
	},
	float: {
		description: "decimal or scientific number → number",
		numeric: true,
		regex: () => {
			return NUMBER;
		},
		convert: toNumber
	},
	number: {
		description: "alias of float",
		numeric: true,
		regex: () => {
			return NUMBER;
		},
		convert: toNumber
	},
	hex: {
		description: "hex number, optional 0x prefix",
		regex: () => {
			return "(?:0[xX])?[0-9a-fA-F]+";
		},
		convert: (text) => {
			return text.toLowerCase();
		}
	},
	bool: {
		description: "true/false/yes/no/on/off → boolean",
		regex: () => {
			return ["true", "false", "yes", "no", "on", "off"].map(ci).join("|");
		},
		convert: (text) => {
			return ["true", "yes", "on"].indexOf(text.toLowerCase()) !== -1;
		}
	},
	uuid: {
		description: "canonical UUID → lowercase string",
		regex: () => {
			return "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
		},
		convert: (text) => {
			return text.toLowerCase();
		}
	},
	ipv4: {
		description: "IPv4 address",
		regex: () => {
			return IPV4;
		},
		convert: identity
	},
	ipv6: {
		description: "IPv6 address",
		regex: () => {
			return IPV6;
		},
		convert: (text) => {
			return text.toLowerCase();
		}
	},
	ip: {
		description: "IPv4 or IPv6 address",
		regex: () => {
			return IPV4 + "|" + IPV6;
		},
		convert: identity
	},
	host: {
		description: "hostname or IP address",
		regex: () => {
			return IPV4 + "|\\[(?:" + IPV6 + ")\\]|" + HOSTNAME;
		},
		convert: (text) => {
			return text.replace(/^\[|\]$/g, "").toLowerCase();
		}
	},
	port: {
		description: "TCP/UDP port 1-65535 → number",
		numeric: true,
		regex: () => {
			return "\\d{1,5}";
		},
		convert: (text) => {
			const n = parseInt(text, 10);
			return n >= 1 && n <= 65535 ? n : undefined;
		}
	},
	email: {
		description: "e-mail address",
		regex: () => {
			return "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
		},
		convert: (text) => {
			return text.toLowerCase();
		}
	},
	url: {
		description: "URL with scheme",
		regex: () => {
			return "[A-Za-z][A-Za-z0-9+.-]*://[^\\s\"'<>]+";
		},
		convert: identity
	},
	path: {
		description: "absolute or relative path, may include query string",
		regex: () => {
			return "(?:\\.{0,2}/|~/)[^\\s\"'<>]*|[\\w.-]+(?:/[^\\s\"'<>]*)+";
		},
		convert: identity
	},
	iso8601: {
		description: "ISO-8601 timestamp → epoch ms; iso8601(utc|local|±HH:MM) sets the zone for zone-less values (default local)",
		numeric: true,
		time: true,
		regex: (args) => {
			withZone(args);
			return ISO;
		},
		convert: zoned
	},
	timestamp: {
		description: "ISO-8601, 'YYYY-MM-DD HH:MM:SS', syslog 'Mmm dd HH:MM:SS', CLF 'dd/Mmm/YYYY:HH:MM:SS +zzzz', epoch s/ms → epoch ms; timestamp(utc|local|±HH:MM) sets the zone for zone-less values (default local)",
		numeric: true,
		time: true,
		regex: (args) => {
			withZone(args);
			return ISO + "|" + CLF_TS + "|" + SYSLOG_TS + "|" + EPOCH;
		},
		convert: zoned
	},
	duration: {
		description: "250ms, 1.5s, 2m, 1h30m, 15us, 300ns → milliseconds",
		numeric: true,
		regex: () => {
			return "(?:\\d+(?:\\.\\d+)?\\s?(?:ns|us|µs|ms|s|m|h|d))+";
		},
		convert: (text) => {
			return units.parseDuration(text.replace(/\s/g, ""));
		}
	},
	bytes: {
		description: "512, 12KB, 3.4MiB, 1G → bytes",
		numeric: true,
		regex: () => {
			return "\\d+(?:\\.\\d+)?\\s?(?:[KMGTkmgt]i?[Bb]?|[Bb])?";
		},
		convert: (text) => {
			return units.parseBytes(text.replace(/\s/g, ""));
		}
	},
	level: {
		description: "log level (trace/debug/info/warn/error/fatal/..., any case, short forms) → normalised lowercase",
		regex: () => {
			return "(?:" + LEVEL_WORDS.map(ci).join("|") + ")(?![A-Za-z])";
		},
		convert: (text) => {
			return LEVELS[text.toLowerCase()];
		}
	},
	quoted: {
		description: "\"double\" or 'single' quoted string with escapes → unquoted",
		regex: () => {
			return "\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'";
		},
		convert: unquote
	},
	json: {
		description: "JSON object or array → parsed, flattened into name.key fields",
		object: true,
		regex: () => {
			return "\\{.*\\}|\\[.*\\]";
		},
		convert: (text) => {
			try {
				return JSON.parse(text);
			} catch (e) {
				return undefined;
			}
		}
	},
	kv: {
		description: "k=v k2=\"v 2\" pairs → object, flattened into name.k fields",
		object: true,
		regex: () => {
			return "[\\w.$@-]+=(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,]*)(?:[\\s,]+[\\w.$@-]+=(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,]*))*";
		},
		convert: parseKv
	},
	enum: {
		description: "enum(a,b,c): one of the given literals",
		regex: (args) => {
			if (!args.length) {
				throw new Error("enum() needs at least one value");
			}

			return args.slice().sort((a, b) => {
				return b.length - a.length;
			}).map(escapeRegex).join("|");
		},
		convert: identity
	},
	regex: {
		description: "regex(<pattern>): custom regex, string value",
		rawArgs: true,
		regex: (args) => {
			if (!args.length || !args[0]) {
				throw new Error("regex() needs a pattern");
			}

			new RegExp(args[0]);
			return args[0];
		},
		convert: identity
	}
};

module.exports = {
	types,
	ci
};
