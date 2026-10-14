const globMatch = require("../utils/glob").globMatch;
const isGlob = require("../utils/glob").isGlob;

const NAME_RE = /^[A-Za-z0-9_][\w.-]*$/;
const STORE_LEVELS = ["full", "fields", "count"];
const DEFAULT_BODY = "msg";

/*
 * Classifier registry + matcher (SPEC.md §5). Every definition is compiled
 * into a node; nodes form a forest via `parent`. Classification walks the
 * forest: first matching top-level node by priority wins, then the first
 * matching child at each level.
 */

const normalise = (def) => {
	if (!def || !NAME_RE.test(def.name || "")) {
		throw new Error("Classifier name must match " + NAME_RE + " (letters, digits, _ . -)");
	}

	if (!def.template === !def.regex) {
		throw new Error("Classifier needs exactly one of template or regex");
	}

	if (def.store && STORE_LEVELS.indexOf(def.store) === -1) {
		throw new Error("store must be one of " + STORE_LEVELS.join(", "));
	}

	if (def.on && !def.parent) {
		throw new Error("'on' only applies to sub-classifiers (set parent)");
	}

	if (def.multiline) {
		if (!def.envelope) {
			throw new Error("multiline only applies to envelope classifiers (it joins envelope bodies)");
		}

		if (!def.multiline.start === !def.multiline.continue) {
			throw new Error("multiline needs exactly one of start or continue (regex over the envelope body)");
		}

		new RegExp(def.multiline.start || def.multiline.continue);
	}

	if (def.residual && def.envelope) {
		throw new Error("residual is for regular classifiers; an envelope already sends unmatched bodies to the queue");
	}

	if (def.residual && typeof def.residual !== "string") {
		throw new Error("residual must be a field name (e.g. \"path\")");
	}

	if (def.redact && !Array.isArray(def.redact)) {
		throw new Error("redact must be a list of field names");
	}

	const out = {
		name: def.name,
		description: def.description || "",
		priority: typeof def.priority === "number" ? def.priority : 0,
		sources: def.sources && def.sources.length ? [].concat(def.sources) : null,
		time_field: def.time_field || null,
		store: def.store || "full",
		tags: def.tags || [],
		parent: def.parent || null,
		on: def.on || null,
		envelope: !!def.envelope,
		body: def.envelope ? (def.body || DEFAULT_BODY) : null,
		enabled: def.enabled !== false,
		multiline: def.multiline ? {
			start: def.multiline.start || null,
			continue: def.multiline.continue || null,
			group_by: def.multiline.group_by ? [].concat(def.multiline.group_by) : [],
			flush_ms: def.multiline.flush_ms || 300,
			max_lines: def.multiline.max_lines || 500
		} : null,
		redact: def.redact && def.redact.length ? def.redact.slice() : null,
		residual: def.residual || null,
		scope: def.scope || "project"
	};

	if (def.template) {
		out.template = def.template;
	} else {
		out.regex = def.regex;
		out.flags = def.flags || "";
		out.types = def.types || {};
	}

	return out;
};

/** Persistable form: drop defaults to keep the state file readable. */
const serialise = (def) => {
	const out = { name: def.name };
	const keys = ["template", "regex", "flags", "types", "description", "priority", "sources", "time_field",
		"store", "tags", "parent", "on", "envelope", "body", "multiline", "redact", "residual", "enabled"];
	const defaults = { description: "", priority: 0, sources: null, time_field: null, store: "full", parent: null,
		on: null, envelope: false, body: null, enabled: true, flags: "", multiline: null, redact: null, residual: null };

	keys.forEach((key) => {
		const value = def[key];

		if (value === undefined) {
			return;
		}

		if (Object.prototype.hasOwnProperty.call(defaults, key) && JSON.stringify(defaults[key]) === JSON.stringify(value)) {
			return;
		}

		if (Array.isArray(value) && value.length === 0) {
			return;
		}

		if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
			return;
		}

		out[key] = value;
	});

	return out;
};

/**
 * Text an envelope hands to its children: the body without leading spaces/tabs.
 * The envelope field itself (and multiline detection) keep the original indentation.
 */
const childBody = (body) => {
	return String(body).replace(/^[ \t]+/, "");
};

const sourceMatches = (patterns, source) => {
	if (!patterns) {
		return true;
	}

	return patterns.some((pattern) => {
		return globMatch(pattern, source);
	});
};

/**
 * @param {object} patterns pattern registry from ../patterns
 */
const createClassifiers = (patterns) => {
	const defs = new Map();
	const state = {
		nodes: new Map(),
		roots: [],
		order: 0
	};

	const byPriority = (a, b) => {
		if (b.def.priority !== a.def.priority) {
			return b.def.priority - a.def.priority;
		}

		return a.seq - b.seq;
	};

	const compileDef = (def) => {
		if (def.template) {
			return patterns.compile(def.template);
		}

		return patterns.compileRegex(def.regex, def.flags, def.types);
	};

	/** Recompile every definition and rebuild the tree. Invalid ones become disabled nodes with an error. */
	const rebuild = () => {
		const nodes = new Map();

		defs.forEach((entry, name) => {
			const node = { name, def: entry.def, seq: entry.seq, compiled: null, error: null, children: [], parentNode: null };

			try {
				node.compiled = compileDef(entry.def);
			} catch (e) {
				node.error = e.message;
			}

			nodes.set(name, node);
		});

		nodes.forEach((node) => {
			if (!node.def.parent) {
				return;
			}

			const parent = nodes.get(node.def.parent);

			if (!parent) {
				node.error = node.error || "Parent classifier '" + node.def.parent + "' does not exist";
				return;
			}

			let cursor = parent;
			const seen = new Set([node.name]);

			while (cursor) {
				if (seen.has(cursor.name)) {
					node.error = "Parent cycle through '" + cursor.name + "'";
					return;
				}

				seen.add(cursor.name);
				cursor = cursor.def.parent ? nodes.get(cursor.def.parent) : null;
			}

			node.parentNode = parent;
			parent.children.push(node);
		});

		nodes.forEach((node) => {
			if (node.def.envelope && node.compiled && !node.compiled.fieldTypes[node.def.body]) {
				node.error = node.error || "Envelope body field '" + node.def.body + "' is not captured by the template";
			}

			node.children.sort(byPriority);
		});

		state.nodes = nodes;
		state.roots = Array.from(nodes.values()).filter((node) => {
			return !node.def.parent;
		}).sort(byPriority);
	};

	const usable = (node) => {
		if (node.error || !node.compiled || !node.def.enabled) {
			return false;
		}

		let cursor = node.parentNode;

		while (cursor) {
			if (cursor.error || !cursor.def.enabled) {
				return false;
			}

			cursor = cursor.parentNode;
		}

		return true;
	};

	const tryNode = (node, text, source) => {
		if (!usable(node) || !sourceMatches(node.def.sources, source)) {
			return null;
		}

		return node.compiled.match(text);
	};

	const textFor = (child, parent, fields, raw) => {
		if (child.def.on) {
			const value = fields[child.def.on];
			return value === undefined || value === null ? null : String(value);
		}

		if (parent.def.envelope) {
			const body = fields[parent.def.body];
			return body === undefined || body === null ? null : childBody(body);
		}

		return raw;
	};

	const descend = (node, fields, path, record, assembled) => {
		if (node.def.multiline && !assembled) {
			return { node, path, fields, pause: true };
		}

		const found = node.children.reduce((acc, child) => {
			if (acc) {
				return acc;
			}

			const text = textFor(child, node, fields, record.raw);

			if (text === null) {
				return null;
			}

			const m = tryNode(child, text, record.source);
			return m ? { child, m } : null;
		}, null);

		if (!found) {
			return { node, path, fields };
		}

		return descend(found.child, Object.assign({}, fields, found.m.fields), path.concat([found.child.name]), record, assembled);
	};

	const finish = (result) => {
		const time = timeFor(result.node, result.fields);

		if (result.pause) {
			return { multiline: true, classified: false, node: result.node, path: result.path, fields: result.fields, time };
		}

		if (result.node.def.envelope) {
			return {
				classified: false,
				node: result.node,
				path: result.path,
				fields: result.fields,
				time,
				envelope: { name: result.node.name, path: result.path, fields: result.fields },
				body: String(result.fields[result.node.def.body] === undefined ? "" : result.fields[result.node.def.body])
			};
		}

		return { classified: true, node: result.node, path: result.path, fields: result.fields, time };
	};

	const timeFor = (node, fields) => {
		let cursor = node;

		while (cursor) {
			if (cursor.def.time_field && typeof fields[cursor.def.time_field] === "number") {
				return fields[cursor.def.time_field];
			}

			cursor = cursor.parentNode;
		}

		return null;
	};

	const classifiers = {
		/**
		 * Classify one record ({ raw, source }).
		 * @returns {?{ classified: boolean, node: object, path: string[], fields: object, time: ?number,
		 *   envelope?: { name: string, path: string[], fields: object }, body?: string }}
		 *   null when nothing matched at all.
		 */
		classify: (record) => {
			const top = state.roots.reduce((acc, node) => {
				if (acc) {
					return acc;
				}

				const m = tryNode(node, record.raw, record.source);
				return m ? { node, m } : null;
			}, null);

			if (!top) {
				return null;
			}

			return finish(descend(top.node, top.m.fields, [top.node.name], record, false));
		},

		/**
		 * Continue classification below an envelope with already-extracted fields
		 * (an assembled multiline record: fields[body] holds the joined body).
		 * Returns null if the envelope no longer exists or is unusable.
		 */
		continueFrom: (envelopeName, fields, record) => {
			const node = state.nodes.get(envelopeName);

			if (!node || !usable(node) || !node.def.envelope) {
				return null;
			}

			const path = [];
			let cursor = node;

			while (cursor) {
				path.unshift(cursor.name);
				cursor = cursor.parentNode;
			}

			return finish(descend(node, fields, path, record, true));
		},

		/** Validate a definition without storing it. Returns { def, compiled } or throws. */
		prepare: (input) => {
			const def = normalise(input);
			const compiled = compileDef(def);

			if (def.parent && !defs.has(def.parent) && def.parent !== def.name) {
				throw new Error("Parent classifier '" + def.parent + "' does not exist");
			}

			if (def.envelope && !compiled.fieldTypes[def.body]) {
				throw new Error("Envelope body field '" + def.body + "' is not captured by the template (add e.g. {" + def.body + ":rest})");
			}

			return { def, compiled };
		},

		/** Store (create/replace) a definition. Strict: throws on invalid unless `lenient`. */
		define: (input, lenient) => {
			const def = lenient ? normalise(input) : classifiers.prepare(input).def;
			const previous = defs.get(def.name);
			defs.set(def.name, { def, seq: previous ? previous.seq : state.order++ });
			rebuild();

			const node = state.nodes.get(def.name);

			if (node.error && !lenient) {
				if (previous) {
					defs.set(def.name, previous);
				} else {
					defs.delete(def.name);
				}

				rebuild();
				throw new Error(node.error);
			}

			return def;
		},

		/** Remove a classifier and its subtree. Returns removed names. */
		remove: (name) => {
			if (!defs.has(name)) {
				return [];
			}

			const removed = classifiers.subtree(name);
			removed.forEach((n) => {
				defs.delete(n);
			});
			rebuild();
			return removed;
		},

		has: (name) => {
			return defs.has(name);
		},

		get: (name) => {
			return state.nodes.get(name) || null;
		},

		defs: () => {
			return Array.from(defs.values()).sort((a, b) => {
				return a.seq - b.seq;
			}).map((entry) => {
				return entry.def;
			});
		},

		nodes: () => {
			return Array.from(state.nodes.values());
		},

		roots: () => {
			return state.roots;
		},

		/** name and all descendants */
		subtree: (name) => {
			const node = state.nodes.get(name);

			if (!node) {
				return defs.has(name) ? [name] : [];
			}

			return node.children.reduce((acc, child) => {
				return acc.concat(classifiers.subtree(child.name));
			}, [name]);
		},

		/**
		 * Resolve a classifier selector (name, glob, or list) to node names,
		 * including descendants. Empty/undefined selects everything.
		 */
		resolve: (selector) => {
			if (!selector || (Array.isArray(selector) && selector.length === 0)) {
				return Array.from(state.nodes.keys());
			}

			const out = new Set();
			[].concat(selector).forEach((pattern) => {
				state.nodes.forEach((node, name) => {
					if (isGlob(pattern) ? globMatch(pattern, name) : name === pattern) {
						classifiers.subtree(name).forEach((n) => {
							out.add(n);
						});
					}
				});
			});

			return Array.from(out);
		},

		/** Field catalogue for nodes: own fields + inherited from ancestors. */
		fieldTypes: (name) => {
			const node = state.nodes.get(name);
			const out = {};
			let cursor = node;
			const chain = [];

			while (cursor) {
				chain.unshift(cursor);
				cursor = cursor.parentNode;
			}

			chain.forEach((n) => {
				if (n.compiled) {
					Object.assign(out, n.compiled.fieldTypes);
				}
			});

			return out;
		},

		/** Classifiers that use a parser (directly or through other parsers). */
		usingParsers: (parserNames) => {
			return classifiers.nodes().filter((node) => {
				return node.compiled && node.compiled.uses.some((used) => {
					return parserNames.indexOf(used) !== -1;
				});
			}).map((node) => {
				return node.name;
			});
		},

		rebuild,

		clear: () => {
			defs.clear();
			rebuild();
		}
	};

	return classifiers;
};

module.exports = {
	createClassifiers,
	childBody,
	normalise,
	serialise,
	STORE_LEVELS
};
