/*
 * Masking: replace variable tokens with typed placeholders so repeated
 * messages collapse onto one "shape" (SPEC.md §6). One combined regex, one
 * pass; alternatives are ordered by priority.
 */

const MASKS = [
	{ type: "quoted", placeholder: "<str>", re: "\"(?:[^\"\\\\\\n]|\\\\.){0,512}\"|'(?:[^'\\\\\\n]|\\\\.){0,512}'" },
	{ type: "uuid", placeholder: "<uuid>", re: "\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b" },
	{ type: "timestamp", placeholder: "<ts>", re: "\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?|\\b\\d{2}/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/\\d{4}:\\d{2}:\\d{2}:\\d{2}(?: [+-]\\d{4})?|\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \\d]\\d \\d{2}:\\d{2}:\\d{2}|\\b\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b" },
	{ type: "url", placeholder: "<url>", re: "\\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s\"'<>]+" },
	{ type: "ip", placeholder: "<ip>", re: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b|\\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\\b|\\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?\\b" },
	{ type: "email", placeholder: "<email>", re: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b" },
	{ type: "path", placeholder: "<path>", re: "(?<![\\w.:/])(?:/[\\w.@%+~=&?-]+){2,}/?" },
	{ type: "hex", placeholder: "<hex>", re: "\\b0[xX][0-9a-fA-F]+\\b|\\b(?=[0-9a-fA-F]*\\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,}\\b" },
	{ type: "duration", placeholder: "<dur>", re: "(?<![\\w.])\\d+(?:\\.\\d+)?(?:ns|us|µs|ms|s|m|h)(?![\\w])" },
	{ type: "bytes", placeholder: "<bytes>", re: "(?<![\\w.])\\d+(?:\\.\\d+)?\\s?(?:[KMGT]i?B|B)(?![\\w])" },
	{ type: "id", placeholder: "<id>", re: "\\b(?=[\\w-]*\\d)(?=[\\w-]*[A-Za-z])[\\w-]{6,}\\b" },
	{ type: "number", placeholder: "<num>", re: "(?<![\\w.])[-+]?\\d+(?:\\.\\d+)?(?![\\w])" }
];

const COMBINED = new RegExp(MASKS.map((mask, i) => {
	return "(?<m" + i + ">" + mask.re + ")";
}).join("|"), "g");

const PLACEHOLDER_TYPES = {
	"<str>": "quoted",
	"<uuid>": "uuid",
	"<ts>": "timestamp",
	"<url>": "url",
	"<ip>": "host",
	"<email>": "email",
	"<path>": "path",
	"<hex>": "hex",
	"<id>": "word",
	"<dur>": "duration",
	"<bytes>": "bytes",
	"<num>": "number"
};

const MAX_SHAPE = 400;

/**
 * Mask a line.
 * @returns {{ shape: string, values: Array<{type: string, placeholder: string, text: string}> }}
 */
const mask = (text) => {
	const values = [];
	const shape = text.replace(COMBINED, function () {
		const groups = arguments[arguments.length - 1];
		const index = MASKS.findIndex((_mask, i) => {
			return groups["m" + i] !== undefined;
		});
		const found = MASKS[index];
		const matched = groups["m" + index];
		const withPort = found.type === "ip" ? /^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/.exec(matched) : null;

		if (withPort) {
			values.push({ type: "ip", placeholder: "<ip>", text: withPort[1] });
			values.push({ type: "number", placeholder: "<num>", text: withPort[2] });
			return "<ip>:<num>";
		}

		values.push({ type: found.type, placeholder: found.placeholder, text: matched });
		return found.placeholder;
	}).replace(/\s+/g, " ").trim();

	return { shape: shape.length > MAX_SHAPE ? shape.slice(0, MAX_SHAPE) + "…" : shape, values };
};

/**
 * Turn a masked shape into a starting template: placeholders become typed
 * captures, named from a preceding "key=" / "key:" when present.
 * Numbers that are always integers in the examples become int.
 */
const suggestTemplate = (shape, examples) => {
	const used = {};
	let counter = 0;
	const truncated = shape.slice(-1) === "…";
	const base = truncated ? shape.slice(0, -1) : shape;

	const exampleValues = (examples || []).map((example) => {
		return mask(example).values;
	});

	const placeholderRe = /<(str|uuid|ts|url|ip|email|path|hex|id|dur|bytes|num)>/g;
	let index = 0;
	let out = "";
	let last = 0;
	let m = placeholderRe.exec(base);

	const nameFor = (before, type) => {
		const key = /([A-Za-z_][\w.-]*)\s*[=:]\s*["']?$/.exec(before);
		const short = { timestamp: "ts", quoted: "str", duration: "took", number: "num", float: "num", int: "num" };
		const raw = key ? key[1].replace(/[.-]/g, "_").toLowerCase() : (short[type] || type) + "_" + (++counter);
		const name = /^[A-Za-z_]/.test(raw) ? raw : "f_" + raw;

		if (used[name]) {
			used[name]++;
			return name + "_" + used[name];
		}

		used[name] = 1;
		return name;
	};

	while (m) {
		const literal = base.slice(last, m.index).replace(/\{/g, "{{").replace(/\}/g, "}}");
		out += literal;
		let type = PLACEHOLDER_TYPES[m[0]];

		if (type === "number") {
			const allInts = exampleValues.every((values) => {
				const value = values[index];
				return !value || /^[-+]?\d+$/.test(value.text);
			});
			type = allInts ? "int" : "float";
		}

		out += "{" + nameFor(base.slice(0, m.index), type === "word" ? "id" : type) + ":" + type + "}";
		last = placeholderRe.lastIndex;
		index++;
		m = placeholderRe.exec(base);
	}

	out += base.slice(last).replace(/\{/g, "{{").replace(/\}/g, "}}");

	if (truncated) {
		out += "{rest:rest}";
	}

	return out;
};

module.exports = {
	mask,
	suggestTemplate,
	MASKS
};
