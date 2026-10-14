const builtins = require("./types").types;
const builtinFilters = require("./filters").filters;
const NUMERIC_FILTERS = require("./filters").NUMERIC_FILTERS;
const escapeRegex = require("../utils/glob").escapeRegex;

const NAME_RE = /^[A-Za-z_][\w-]*$/;
const FIELD_NAME_RE = /[A-Za-z_$@][\w.$@-]*/y;
const MAX_FLATTEN_DEPTH = 4;

/*
 * Template language (SPEC.md §4):
 *
 *   {name:type}  {name:type(args)}  {name:type|filter|filter(args)}
 *   {name?:type} {name:/regex/flags} {name}  (= word)
 *   {_:type} {*}  match but do not keep
 *   {...parser}  spread a template parser's fields into this namespace
 *   {{ }}        literal braces; whitespace runs match \s+; ^ / $ anchor
 */

const templateError = (message, template, pos) => {
	const error = new Error(message + (pos !== undefined ? " (at position " + pos + ")" : ""));
	error.template = template;
	error.position = pos;
	return error;
};

/** Read a balanced "( ... )" starting at text[pos] === "(". Returns { raw, end }. */
const readParens = (text, pos, template) => {
	let depth = 0;
	let i = pos;
	let inClass = false;

	while (i < text.length) {
		const ch = text[i];

		if (ch === "\\") {
			i += 2;
			continue;
		}

		if (inClass) {
			if (ch === "]") {
				inClass = false;
			}
		} else if (ch === "[") {
			inClass = true;
		} else if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;

			if (depth === 0) {
				return { raw: text.slice(pos + 1, i), end: i + 1 };
			}
		}

		i++;
	}

	throw templateError("Unbalanced parentheses", template, pos);
};

const splitArgs = (raw) => {
	if (raw.trim() === "") {
		return [];
	}

	const out = [];
	let depth = 0;
	let current = "";

	raw.split("").forEach((ch) => {
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
		}

		if (ch === "," && depth === 0) {
			out.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	});

	out.push(current.trim());
	return out;
};

/** Read "/regex/flags" starting at text[pos] === "/". */
const readRegexLiteral = (text, pos, template) => {
	let i = pos + 1;
	let inClass = false;

	while (i < text.length) {
		const ch = text[i];

		if (ch === "\\") {
			i += 2;
			continue;
		}

		if (inClass) {
			if (ch === "]") {
				inClass = false;
			}
		} else if (ch === "[") {
			inClass = true;
		} else if (ch === "/") {
			const source = text.slice(pos + 1, i);
			const flagsMatch = /[a-z]*/y;
			flagsMatch.lastIndex = i + 1;
			const flags = flagsMatch.exec(text)[0];
			return { source, flags, end: i + 1 + flags.length };
		}

		i++;
	}

	throw templateError("Unterminated /regex/", template, pos);
};

/** Parse "|filter|filter(args)" chain starting at pos. */
const readFilters = (text, pos, template) => {
	const out = [];
	let i = pos;

	while (text[i] === "|") {
		const nameMatch = /[A-Za-z_]\w*/y;
		nameMatch.lastIndex = i + 1;
		const found = nameMatch.exec(text);

		if (!found) {
			throw templateError("Expected filter name after |", template, i + 1);
		}

		i = nameMatch.lastIndex;
		let args = [];

		if (text[i] === "(") {
			const parens = readParens(text, i, template);
			args = splitArgs(parens.raw);
			i = parens.end;
		}

		out.push({ name: found[0], args });
	}

	return { filters: out, end: i };
};

/**
 * Tokenise a template into literal and capture tokens.
 * @returns {Array<object>}
 */
const tokenize = (template) => {
	const tokens = [];
	let literal = "";
	let i = 0;

	const flush = () => {
		if (literal) {
			tokens.push({ kind: "lit", text: literal });
			literal = "";
		}
	};

	while (i < template.length) {
		const ch = template[i];

		if (ch === "{" && template[i + 1] === "{") {
			literal += "{";
			i += 2;
			continue;
		}

		if (ch === "}" && template[i + 1] === "}") {
			literal += "}";
			i += 2;
			continue;
		}

		if (ch === "}") {
			throw templateError("Unmatched } (use }} for a literal brace)", template, i);
		}

		if (ch !== "{") {
			literal += ch;
			i++;
			continue;
		}

		flush();
		const start = i;
		i++;

		if (template[i] === "*" && template[i + 1] === "}") {
			tokens.push({ kind: "cap", skipAny: true, pos: start });
			i += 2;
			continue;
		}

		if (template.slice(i, i + 3) === "...") {
			const nameMatch = /[A-Za-z_][\w-]*/y;
			nameMatch.lastIndex = i + 3;
			const found = nameMatch.exec(template);

			if (!found || template[nameMatch.lastIndex] !== "}") {
				throw templateError("Spread must look like {...parserName}", template, start);
			}

			tokens.push({ kind: "cap", spread: true, typeName: found[0], pos: start });
			i = nameMatch.lastIndex + 1;
			continue;
		}

		FIELD_NAME_RE.lastIndex = i;
		const nameFound = FIELD_NAME_RE.exec(template);

		if (!nameFound) {
			throw templateError("Expected a field name after {", template, i);
		}

		const token = { kind: "cap", name: nameFound[0], optional: false, pos: start, args: [], filters: [] };
		i = FIELD_NAME_RE.lastIndex;

		if (template[i] === "?") {
			token.optional = true;
			i++;
		}

		if (template[i] === "}") {
			token.typeName = "word";
			tokens.push(token);
			i++;
			continue;
		}

		if (template[i] !== ":") {
			throw templateError("Expected : or } after field name '" + token.name + "'", template, i);
		}

		i++;

		if (template[i] === "/") {
			const re = readRegexLiteral(template, i, template);
			token.inlineRegex = { source: re.source, flags: re.flags };
			i = re.end;
		} else {
			const typeMatch = /[A-Za-z_][\w-]*/y;
			typeMatch.lastIndex = i;
			const typeFound = typeMatch.exec(template);

			if (!typeFound) {
				throw templateError("Expected a type after ':' in {" + token.name + "}", template, i);
			}

			token.typeName = typeFound[0];
			i = typeMatch.lastIndex;

			if (template[i] === "(") {
				const parens = readParens(template, i, template);
				token.rawArgs = parens.raw;
				token.args = splitArgs(parens.raw);
				i = parens.end;
			}
		}

		const chain = readFilters(template, i, template);
		token.filters = chain.filters;
		i = chain.end;

		if (template[i] !== "}") {
			throw templateError("Expected } to close capture '" + token.name + "'", template, i);
		}

		i++;
		tokens.push(token);
	}

	flush();
	return tokens;
};

/**
 * Required literal runs of a raw regex, for the prefilter. Only text at
 * nesting depth 0, outside character classes, not followed by a quantifier;
 * a top-level alternation means nothing is required.
 */
const regexLiterals = (source) => {
	const runs = [];
	let current = "";
	let depth = 0;
	let inClass = false;
	let alternation = false;

	const cut = () => {
		if (current.length >= 3) {
			runs.push(current);
		}

		current = "";
	};

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];
		const quantified = next === "?" || next === "*" || next === "+" || next === "{";

		if (inClass) {
			if (ch === "\\") {
				i++;
			} else if (ch === "]") {
				inClass = false;
			}

			continue;
		}

		if (ch === "\\") {
			const escaped = source[i + 1];
			const afterEscape = source[i + 2];
			const plainEscape = escaped !== undefined && !/[A-Za-z0-9]/.test(escaped);
			i++;

			if (depth === 0 && plainEscape && !(afterEscape === "?" || afterEscape === "*" || afterEscape === "+" || afterEscape === "{")) {
				current += escaped;
			} else {
				cut();
			}

			continue;
		}

		if (ch === "[") {
			inClass = true;
			cut();
			continue;
		}

		if (ch === "(") {
			depth++;
			cut();
			continue;
		}

		if (ch === ")") {
			depth = Math.max(0, depth - 1);
			cut();
			continue;
		}

		if (ch === "|" && depth === 0) {
			alternation = true;
		}

		if (depth > 0 || /[.^$|?*+{}]/.test(ch) || quantified) {
			cut();
			continue;
		}

		current += ch;
	}

	cut();
	return alternation ? [] : runs;
};

/** Flatten nested objects (json / kv captures) into dotted keys. */
const flatten = (prefix, value, out, depth) => {
	if (value === null || typeof value !== "object" || depth >= MAX_FLATTEN_DEPTH) {
		if (value !== null && typeof value === "object") {
			out[prefix] = JSON.stringify(value);
		} else {
			out[prefix] = value;
		}

		return out;
	}

	if (Array.isArray(value)) {
		const primitive = value.every((item) => {
			return item === null || typeof item !== "object";
		});
		out[prefix] = primitive ? value : JSON.stringify(value);
		return out;
	}

	Object.keys(value).forEach((key) => {
		flatten(prefix ? prefix + "." + key : key, value[key], out, depth + 1);
	});

	return out;
};

const inferType = (value) => {
	if (typeof value === "number") {
		return "number";
	}

	if (typeof value === "boolean") {
		return "bool";
	}

	return "string";
};

/**
 * Pattern registry: built-in types + user parsers, and the template compiler.
 */
const createPatterns = () => {
	const parsers = new Map();

	const resolveType = (name) => {
		if (parsers.has(name)) {
			return { kind: "parser", def: parsers.get(name) };
		}

		if (Object.prototype.hasOwnProperty.call(builtins, name)) {
			return { kind: "builtin", def: builtins[name] };
		}

		return null;
	};

	const buildFilterChain = (specs, template) => {
		return specs.map((spec) => {
			const factory = builtinFilters[spec.name];

			if (!factory) {
				throw templateError("Unknown filter '" + spec.name + "'. Known: " + Object.keys(builtinFilters).join(", "), template);
			}

			return factory(spec.args);
		});
	};

	const filterTypeOverride = (specs) => {
		const numeric = specs.map((spec) => {
			return spec.name;
		}).filter((name) => {
			return NUMERIC_FILTERS.indexOf(name) !== -1;
		});

		if (!numeric.length) {
			return null;
		}

		const last = numeric[numeric.length - 1];
		const mapping = { int: "int", float: "float", duration: "duration", bytes: "bytes", timestamp: "timestamp", s: "number", ms: "number" };
		return mapping[last];
	};

	/**
	 * Compile tokens to regex pieces. Shared `ctx` carries the group counter,
	 * cycle-detection stack and collected metadata across nested template parsers.
	 */
	const compileTokens = (template, prefix, ctx, required) => {
		const tokens = tokenize(template);
		const pieces = [];
		const segments = [];

		const pushPiece = (piece, label) => {
			pieces.push(piece);
			segments.push({ src: piece.src, label });
		};

		tokens.forEach((token, index) => {
			if (token.kind === "lit") {
				let text = token.text;
				let lead = "";
				let trail = "";

				if (index === 0 && text[0] === "^") {
					lead = "^";
					text = text.slice(1);
				}

				if (index === tokens.length - 1 && text[text.length - 1] === "$" && text[text.length - 2] !== "\\") {
					trail = "$";
					text = text.slice(0, -1);
				}

				if (lead) {
					pushPiece({ src: "^" }, "^");
				}

				text.split(/(\s+)/).forEach((part) => {
					if (!part) {
						return;
					}

					if (/^\s+$/.test(part)) {
						pushPiece({ src: "\\s+", ws: true }, "whitespace");
						return;
					}

					if (required) {
						ctx.literals.push(part);
					}

					pushPiece({ src: escapeRegex(part) }, JSON.stringify(part));
				});

				if (trail) {
					pushPiece({ src: "$" }, "$");
				}

				return;
			}

			if (token.skipAny) {
				pushPiece({ src: ".*?" }, "{*}");
				return;
			}

			const wrapOptional = (src) => {
				if (!token.optional) {
					return src;
				}

				const last = pieces[pieces.length - 1];

				if (last && last.ws) {
					pieces.pop();
					segments.pop();
					return "(?:\\s+" + src + ")?";
				}

				return "(?:" + src + ")?";
			};

			if (token.inlineRegex) {
				try {
					new RegExp(token.inlineRegex.source);
				} catch (e) {
					throw templateError("Invalid regex in {" + token.name + "}: " + e.message, template, token.pos);
				}

				const group = "g" + (ctx.counter++);
				const flagsNote = token.inlineRegex.flags.indexOf("i") !== -1 ? "(?i:" : "(?:";
				const inner = token.inlineRegex.flags.indexOf("i") !== -1 ? flagsNote + token.inlineRegex.source + ")" : token.inlineRegex.source;
				const keep = token.name !== "_";
				const src = keep ? "(?<" + group + ">" + inner + ")" : "(?:" + inner + ")";

				if (keep) {
					ctx.captures.push({
						group,
						name: prefix + token.name,
						type: filterTypeOverride(token.filters) || "string",
						convert: (text) => {
							return text;
						},
						filters: buildFilterChain(token.filters, template),
						object: false
					});
				}

				pushPiece({ src: wrapOptional(src) }, "{" + token.name + ":/" + token.inlineRegex.source + "/}");
				return;
			}

			const resolved = resolveType(token.typeName);

			if (!resolved) {
				throw templateError("Unknown type '" + token.typeName + "'. Use list_parsers to see available types and parsers", template, token.pos);
			}

			if (resolved.kind === "parser") {
				ctx.uses.add(token.typeName);
			}

			if (resolved.kind === "parser" && resolved.def.template) {
				if (ctx.stack.indexOf(token.typeName) !== -1) {
					throw templateError("Parser cycle: " + ctx.stack.concat([token.typeName]).join(" → "), template, token.pos);
				}

				const childPrefix = token.spread ? prefix : prefix + token.name + ".";
				const keep = token.spread || token.name !== "_";
				ctx.stack.push(token.typeName);
				ctx.depth++;
				const captureStart = ctx.captures.length;
				const inner = compileTokens(resolved.def.template, childPrefix, ctx, required && !token.optional);
				ctx.depth--;
				ctx.stack.pop();

				if (!keep) {
					ctx.captures.splice(captureStart);
				}

				const src = inner.pieces.map((piece) => {
					return piece.src;
				}).join("");
				const label = token.spread ? "{..." + token.typeName + "}" : "{" + token.name + ":" + token.typeName + "}";
				pushPiece({ src: wrapOptional("(?:" + src + ")") }, label);
				return;
			}

			if (token.spread) {
				throw templateError("{..." + token.typeName + "} can only spread a template parser", template, token.pos);
			}

			let regexSource = null;
			let convert = null;
			let type = token.typeName;
			let object = false;

			if (resolved.kind === "builtin") {
				const args = resolved.def.rawArgs && token.rawArgs !== undefined ? [token.rawArgs] : token.args;

				try {
					regexSource = resolved.def.regex(args);
				} catch (e) {
					throw templateError("Bad arguments for " + token.typeName + ": " + e.message, template, token.pos);
				}

				convert = (text) => {
					return resolved.def.convert(text, args);
				};
				object = !!resolved.def.object;

				if (token.typeName === "enum" || token.typeName === "regex") {
					type = "string";
				}
			} else {
				regexSource = resolved.def.regex;
				const chain = buildFilterChain(resolved.def.convertChain || [], template);
				convert = (text) => {
					return chain.reduce((value, step) => {
						return value === undefined ? undefined : step(value);
					}, text);
				};
				type = filterTypeOverride(resolved.def.convertChain || []) || "string";
			}

			type = filterTypeOverride(token.filters) || type;
			const keep = token.name !== "_";
			const group = "g" + (ctx.counter++);
			const src = keep ? "(?<" + group + ">" + regexSource + ")" : "(?:" + regexSource + ")";

			ctx.captures.push({
				group,
				name: prefix + token.name,
				type,
				convert,
				filters: buildFilterChain(token.filters, template),
				object,
				keep
			});

			pushPiece({ src: wrapOptional(src) }, "{" + token.name + ":" + token.typeName + "}");
		});

		return { pieces, segments };
	};

	/**
	 * Compile a template into a matcher.
	 * @returns {{ regex: RegExp, source: string, captures: Array, literal: string, uses: Array<string>,
	 *   fieldTypes: object, match: function(string): ?object, diagnose: function(string): object }}
	 */
	const compile = (template) => {
		if (typeof template !== "string" || template.length === 0) {
			throw templateError("Template must be a non-empty string");
		}

		const ctx = { counter: 0, stack: [], depth: 0, captures: [], literals: [], uses: new Set() };
		const out = compileTokens(template, "", ctx, true);
		const source = out.pieces.map((piece) => {
			return piece.src;
		}).join("");
		let regex = null;

		try {
			regex = new RegExp(source);
		} catch (e) {
			throw templateError("Template compiles to an invalid regex: " + e.message, template);
		}

		return finish({
			regex,
			source,
			captures: ctx.captures,
			literals: ctx.literals,
			uses: Array.from(ctx.uses),
			segments: out.segments,
			template
		});
	};

	/**
	 * Compile a raw regex with named groups. Group names may use "__" for dots
	 * (peer__host → peer.host). `types` converts groups with built-in types.
	 */
	const compileRegex = (regexSource, flags, types) => {
		let regex = null;

		try {
			regex = new RegExp(regexSource, (flags || "").replace(/[gy]/g, ""));
		} catch (e) {
			throw templateError("Invalid regex: " + e.message);
		}

		const names = [];
		const groupRe = /\(\?<([A-Za-z_$][\w$]*)>/g;
		let m = groupRe.exec(regexSource);

		while (m) {
			names.push(m[1]);
			m = groupRe.exec(regexSource);
		}

		const typeMap = types || {};
		const captures = names.map((group) => {
			const name = group.replace(/__/g, ".");
			const typeName = typeMap[name] || typeMap[group];
			const builtin = typeName ? builtins[typeName] : null;

			if (typeName && !builtin) {
				throw templateError("Unknown type '" + typeName + "' for regex group " + group);
			}

			return {
				group,
				name,
				type: typeName || "string",
				convert: builtin ? (text) => {
					return builtin.convert(text, []);
				} : (text) => {
					return text;
				},
				filters: [],
				object: builtin ? !!builtin.object : false,
				keep: true
			};
		});

		return finish({
			regex,
			source: regexSource,
			captures,
			literals: (flags || "").indexOf("i") !== -1 ? [] : regexLiterals(regexSource),
			uses: [],
			segments: [{ src: regexSource, label: "regex" }],
			template: null
		});
	};

	const finish = (compiled) => {
		const fieldTypes = {};
		compiled.captures.forEach((capture) => {
			if (capture.keep !== false && !capture.object) {
				fieldTypes[capture.name] = capture.type;
			}
		});

		const literal = compiled.literals.reduce((best, candidate) => {
			return candidate.length > best.length ? candidate : best;
		}, "");

		const extract = (m) => {
			const groups = m.groups || {};
			const fields = {};
			const ok = compiled.captures.every((capture) => {
				const raw = groups[capture.group];

				if (raw === undefined || capture.keep === false) {
					return true;
				}

				const converted = capture.convert(raw);

				if (converted === undefined || (typeof converted === "number" && isNaN(converted))) {
					return false;
				}

				const value = capture.filters.reduce((acc, step) => {
					return acc === undefined ? undefined : step(acc);
				}, converted);

				if (value === undefined) {
					return false;
				}

				if (capture.object) {
					flatten(capture.name, value, fields, 0);
				} else {
					fields[capture.name] = value;
				}

				return true;
			});

			return ok ? fields : null;
		};

		return {
			regex: compiled.regex,
			source: compiled.source,
			captures: compiled.captures,
			literal,
			uses: compiled.uses,
			fieldTypes,

			/** @returns {?{ fields: object, index: number, length: number }} */
			match: (text) => {
				if (literal && text.indexOf(literal) === -1) {
					return null;
				}

				const m = compiled.regex.exec(text);

				if (!m) {
					return null;
				}

				const fields = extract(m);

				if (!fields) {
					return null;
				}

				return { fields, index: m.index, length: m[0].length };
			},

			/** True if the cheap prefilter passes (used to report near-misses). */
			prefilter: (text) => {
				return !literal || text.indexOf(literal) !== -1;
			},

			/**
			 * Explain why a line does not match: the longest prefix of the template
			 * that still matches, and the first piece that fails.
			 */
			diagnose: (text) => {
				const segs = compiled.segments;
				let matched = 0;
				let matchedText = "";

				for (let k = 1; k <= segs.length; k++) {
					const src = segs.slice(0, k).map((seg) => {
						return seg.src;
					}).join("");
					let re = null;

					try {
						re = new RegExp(src);
					} catch (e) {
						continue;
					}

					const m = re.exec(text);

					if (!m) {
						break;
					}

					matched = k;
					matchedText = m[0];
				}

				if (matched === segs.length) {
					return { matches: true, note: "regex matches but a field failed to convert (check types)" };
				}

				return {
					matches: false,
					matched_up_to: segs.slice(0, matched).map((seg) => {
						return seg.label;
					}).join(" "),
					matched_text: matchedText,
					failed_at: segs[matched] ? segs[matched].label : null
				};
			}
		};
	};

	/**
	 * Parser definitions:
	 *   { name, template }                       composite (nested / spreadable fields)
	 *   { name, regex, convert?: ["upper", "map(a=b)"] | "upper|map(a=b)" }
	 */
	const normaliseParser = (def) => {
		if (!def || !NAME_RE.test(def.name || "")) {
			throw new Error("Parser name must match " + NAME_RE);
		}

		if (Object.prototype.hasOwnProperty.call(builtins, def.name)) {
			throw new Error("'" + def.name + "' is a built-in type");
		}

		if (!def.template === !def.regex) {
			throw new Error("Parser needs exactly one of template or regex");
		}

		const out = Object.assign({}, def);

		if (def.regex) {
			try {
				new RegExp(def.regex);
			} catch (e) {
				throw new Error("Invalid regex: " + e.message);
			}

			if (/\(\?<[A-Za-z]/.test(def.regex)) {
				throw new Error("Regex parsers must not use named groups; use a template parser for multiple fields");
			}

			const convert = Array.isArray(def.convert) ? def.convert.join("|") : (def.convert || "");
			const chain = convert ? readFilters("|" + convert.replace(/^\|/, ""), 0, convert).filters : [];
			buildFilterChain(chain, def.name);
			out.convertChain = chain;
		}

		return out;
	};

	const patterns = {
		compile,
		compileRegex,
		tokenize,

		/** Validate and store a parser; returns the stored definition. Throws on error. */
		defineParser: (def) => {
			const normalised = normaliseParser(def);
			const previous = parsers.get(def.name);
			parsers.set(def.name, normalised);

			if (normalised.template) {
				try {
					compile("{x:" + def.name + "}");
				} catch (e) {
					if (previous) {
						parsers.set(def.name, previous);
					} else {
						parsers.delete(def.name);
					}

					throw e;
				}
			}

			return normalised;
		},

		removeParser: (name) => {
			return parsers.delete(name);
		},

		hasParser: (name) => {
			return parsers.has(name);
		},

		getParser: (name) => {
			return parsers.get(name);
		},

		listParsers: () => {
			return Array.from(parsers.values());
		},

		listBuiltins: () => {
			return Object.keys(builtins).map((name) => {
				return { name, builtin: true, description: builtins[name].description };
			});
		},

		listFilters: () => {
			return Object.keys(builtinFilters);
		},

		/** Names of user parsers that (transitively) reference `name`. */
		dependentsOf: (name) => {
			const out = new Set();
			const visit = (target) => {
				parsers.forEach((def) => {
					if (!def.template || out.has(def.name)) {
						return;
					}

					const refs = tokenize(def.template).filter((token) => {
						return token.kind === "cap" && token.typeName === target;
					});

					if (refs.length) {
						out.add(def.name);
						visit(def.name);
					}
				});
			};

			visit(name);
			return Array.from(out);
		},

		clear: () => {
			parsers.clear();
		}
	};

	return patterns;
};

module.exports = {
	createPatterns,
	tokenize,
	flatten,
	inferType
};
