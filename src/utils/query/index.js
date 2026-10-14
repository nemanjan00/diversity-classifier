/*
 * KQL-like query string → `where` tree (see SPEC.md §7.2).
 *
 *   query   := or
 *   or      := and ( "or" and )*
 *   and     := unary ( ["and"] unary )*          implicit AND between terms
 *   unary   := "not" unary | primary
 *   primary := "(" query ")" | term
 *   term    := "exists:" FIELD
 *            | FIELD ":" valueExpr
 *            | FIELD ( ">" | ">=" | "<" | "<=" ) VALUE
 *            | VALUE                               free text over the raw line
 *   valueExpr := "(" VALUE ( "or" VALUE )* ")" | /regex/flags | VALUE
 */

const RAW_FIELD = "$raw";

const createError = (message, pos) => {
	const error = new Error(message + " at position " + pos);
	error.position = pos;
	return error;
};

const isSpace = (ch) => {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
};

const FIELD_RE = /[A-Za-z_$@][\w.$@*-]*/y;
const COMPARATOR_RE = /\s*(>=|<=|>|<)\s*/y;

const parseQuery = (input) => {
	const text = String(input || "");
	const state = { pos: 0 };

	const skipSpace = () => {
		while (state.pos < text.length && isSpace(text[state.pos])) {
			state.pos++;
		}
	};

	const peekWord = (word) => {
		skipSpace();
		const slice = text.slice(state.pos, state.pos + word.length);
		const after = text[state.pos + word.length];

		return slice.toLowerCase() === word && (after === undefined || isSpace(after) || after === "(" || after === ")");
	};

	const eatWord = (word) => {
		if (peekWord(word)) {
			state.pos += word.length;
			return true;
		}

		return false;
	};

	const readQuoted = () => {
		const quote = text[state.pos];
		const start = state.pos;
		state.pos++;
		let out = "";

		while (state.pos < text.length && text[state.pos] !== quote) {
			if (text[state.pos] === "\\" && state.pos + 1 < text.length) {
				state.pos++;
			}

			out += text[state.pos];
			state.pos++;
		}

		if (state.pos >= text.length) {
			throw createError("Unterminated string", start);
		}

		state.pos++;
		return out;
	};

	/** Bare value: runs until whitespace or a closing paren. Colons are allowed (timestamps). */
	const readBare = () => {
		const start = state.pos;

		while (state.pos < text.length && !isSpace(text[state.pos]) && text[state.pos] !== ")" && text[state.pos] !== "(") {
			state.pos++;
		}

		if (state.pos === start) {
			throw createError("Expected a value", start);
		}

		return text.slice(start, state.pos);
	};

	/** Returns { value, quoted, regex } */
	const readValue = () => {
		skipSpace();
		const ch = text[state.pos];

		if (ch === "\"" || ch === "'") {
			return { value: readQuoted(), quoted: true };
		}

		if (ch === "/") {
			const m = /\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)(?=$|[\s)])/y;
			m.lastIndex = state.pos;
			const found = m.exec(text);

			if (found) {
				state.pos = m.lastIndex;
				return { regex: { source: found[1], flags: found[2] } };
			}
		}

		return { value: readBare(), quoted: false };
	};

	const literal = (raw) => {
		if (raw.quoted) {
			return raw.value;
		}

		if (/^[-+]?\d+(\.\d+)?$/.test(raw.value)) {
			return parseFloat(raw.value);
		}

		if (raw.value === "true" || raw.value === "false") {
			return raw.value === "true";
		}

		return raw.value;
	};

	const condition = (field, raw) => {
		const out = {};

		if (raw.regex) {
			out[field] = { regex: raw.regex };
		} else if (!raw.quoted && raw.value.indexOf("*") !== -1) {
			out[field] = { glob: raw.value };
		} else {
			out[field] = literal(raw);
		}

		return out;
	};

	const parseValueExpr = (field) => {
		skipSpace();

		if (text[state.pos] === "(") {
			state.pos++;
			const alternatives = [condition(field, readValue())];

			while (eatWord("or")) {
				alternatives.push(condition(field, readValue()));
			}

			skipSpace();

			if (text[state.pos] !== ")") {
				throw createError("Expected )", state.pos);
			}

			state.pos++;

			if (alternatives.length === 1) {
				return alternatives[0];
			}

			return { or: alternatives };
		}

		return condition(field, readValue());
	};

	const parseTerm = () => {
		skipSpace();
		const start = state.pos;

		if (text[state.pos] === "\"" || text[state.pos] === "'") {
			const out = {};
			out[RAW_FIELD] = { contains: readQuoted() };
			return out;
		}

		FIELD_RE.lastIndex = state.pos;
		const fieldMatch = FIELD_RE.exec(text);

		if (fieldMatch) {
			const field = fieldMatch[0];
			const after = FIELD_RE.lastIndex;

			if (text[after] === ":") {
				state.pos = after + 1;

				if (field === "exists") {
					skipSpace();
					FIELD_RE.lastIndex = state.pos;
					const target = FIELD_RE.exec(text);

					if (!target) {
						throw createError("Expected a field name after exists:", state.pos);
					}

					state.pos = FIELD_RE.lastIndex;
					const out = {};
					out[target[0]] = { exists: true };
					return out;
				}

				return parseValueExpr(field);
			}

			COMPARATOR_RE.lastIndex = after;
			const cmp = COMPARATOR_RE.exec(text);

			if (cmp) {
				state.pos = COMPARATOR_RE.lastIndex;
				const raw = readValue();
				const ops = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
				const opValue = {};
				opValue[ops[cmp[1]]] = literal(raw);
				const out = {};
				out[field] = opValue;
				return out;
			}
		}

		state.pos = start;
		const free = readBare();
		const out = {};
		out[RAW_FIELD] = { contains: free };
		return out;
	};

	let parseOr = null;

	const parsePrimary = () => {
		skipSpace();

		if (text[state.pos] === "(") {
			const start = state.pos;
			state.pos++;
			const inner = parseOr();
			skipSpace();

			if (text[state.pos] !== ")") {
				throw createError("Expected ) to close ( from position " + start, state.pos);
			}

			state.pos++;
			return inner;
		}

		if (state.pos >= text.length) {
			throw createError("Unexpected end of query", state.pos);
		}

		if (text[state.pos] === ")") {
			throw createError("Unexpected )", state.pos);
		}

		return parseTerm();
	};

	const parseUnary = () => {
		if (eatWord("not")) {
			return { not: parseUnary() };
		}

		return parsePrimary();
	};

	const parseAnd = () => {
		const terms = [parseUnary()];

		const more = () => {
			skipSpace();

			if (state.pos >= text.length || text[state.pos] === ")" || peekWord("or")) {
				return false;
			}

			eatWord("and");
			return true;
		};

		while (more()) {
			terms.push(parseUnary());
		}

		return terms.length === 1 ? terms[0] : { and: terms };
	};

	parseOr = () => {
		const terms = [parseAnd()];

		while (eatWord("or")) {
			terms.push(parseAnd());
		}

		return terms.length === 1 ? terms[0] : { or: terms };
	};

	skipSpace();

	if (state.pos >= text.length) {
		return {};
	}

	const tree = parseOr();
	skipSpace();

	if (state.pos < text.length) {
		throw createError("Unexpected input", state.pos);
	}

	return tree;
};

/** Combine an optional query string and an optional where tree (ANDed). */
const combine = (q, where) => {
	const parsed = q ? parseQuery(q) : null;
	const parts = [parsed, where].filter((part) => {
		return part && Object.keys(part).length > 0;
	});

	if (parts.length === 0) {
		return {};
	}

	if (parts.length === 1) {
		return parts[0];
	}

	return { and: parts };
};

module.exports = {
	parseQuery,
	combine,
	RAW_FIELD
};
