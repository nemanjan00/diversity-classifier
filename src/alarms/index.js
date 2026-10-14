const parseDuration = require("../utils/units").parseDuration;
const createRingBuffer = require("../utils/ring-buffer").createRingBuffer;
const globMatch = require("../utils/glob").globMatch;
const compileWhere = require("../utils/filter").compileWhere;
const combineQuery = require("../utils/query").combine;
const getField = require("../metrics/compute").getField;
const aggregate = require("../metrics/compute").aggregate;

const NAME_RE = /^[A-Za-z0-9_][\w.-]*$/;
const SEEN_CAP = 10000;
const SEQUENCE_PENDING_CAP = 10000;
const TIMER_MS = 1000;

/*
 * Alarm engine (SPEC.md §8). Each kind has a pure-ish evaluator over a
 * runtime state object, so the same code runs live and in `backfill` dry runs.
 */

const KINDS = {
	every: {
		params: ["n"],
		describe: "fires on every n-th matching event",
		validate: (p) => {
			if (!(p.n >= 1)) {
				throw new Error("every: params.n must be >= 1");
			}
		}
	},
	rate: {
		params: ["count", "window"],
		describe: ">= count matching events within a sliding window",
		validate: (p) => {
			if (!(p.count >= 1) || !(parseDuration(p.window) > 0)) {
				throw new Error("rate: needs params.count >= 1 and params.window (e.g. \"1m\")");
			}
		}
	},
	absence: {
		params: ["window"],
		describe: "no matching event for a window (heartbeat)",
		validate: (p) => {
			if (!(parseDuration(p.window) > 0)) {
				throw new Error("absence: needs params.window");
			}
		}
	},
	threshold: {
		params: ["field", "agg", "op", "value", "window"],
		describe: "aggregate of a field over a window crosses a value",
		validate: (p) => {
			if (!p.field || [">", ">=", "<", "<=", "gt", "gte", "lt", "lte"].indexOf(p.op || ">") === -1 || typeof p.value !== "number" || !(parseDuration(p.window) > 0)) {
				throw new Error("threshold: needs params.field, params.op (> >= < <=), numeric params.value, params.window; params.agg defaults to avg");
			}
		}
	},
	new_value: {
		params: ["field"],
		describe: "a field takes a value never seen before",
		validate: (p) => {
			if (!p.field) {
				throw new Error("new_value: needs params.field");
			}
		}
	},
	unclassified: {
		params: ["count", "window"],
		describe: ">= count unclassified records within a window",
		validate: (p) => {
			if (!(p.count >= 1) || !(parseDuration(p.window) > 0)) {
				throw new Error("unclassified: needs params.count and params.window");
			}
		}
	},
	source_silent: {
		params: ["source", "window"],
		describe: "a source produced no records for a window",
		validate: (p) => {
			if (!p.source || !(parseDuration(p.window) > 0)) {
				throw new Error("source_silent: needs params.source (name or glob) and params.window");
			}
		}
	},
	sequence: {
		params: ["first", "then", "within", "key"],
		describe: "an event of `first` followed by `then` within a window (optionally sharing `key`)",
		validate: (p) => {
			if (!p.first || !p.then || !(parseDuration(p.within) > 0)) {
				throw new Error("sequence: needs params.first, params.then (classifier names/globs) and params.within");
			}
		}
	}
};

const OPS = {
	">": (a, b) => {
		return a > b;
	},
	">=": (a, b) => {
		return a >= b;
	},
	"<": (a, b) => {
		return a < b;
	},
	"<=": (a, b) => {
		return a <= b;
	}
};
OPS.gt = OPS[">"];
OPS.gte = OPS[">="];
OPS.lt = OPS["<"];
OPS.lte = OPS["<="];

const normalise = (def) => {
	if (!def || !NAME_RE.test(def.name || "")) {
		throw new Error("Alarm name must match " + NAME_RE);
	}

	const kind = KINDS[def.kind];

	if (!kind) {
		throw new Error("Unknown alarm kind '" + def.kind + "'. Kinds: " + Object.keys(KINDS).join(", "));
	}

	const params = def.params || {};
	kind.validate(params);

	const needsClassifier = ["every", "rate", "absence", "threshold", "new_value"].indexOf(def.kind) !== -1;

	if (needsClassifier && !def.classifier) {
		throw new Error(def.kind + " alarms need a classifier (name or glob)");
	}

	const cooldown = def.cooldown !== undefined ? parseDuration(def.cooldown) : (def.kind === "new_value" ? 0 : 60000);

	if (cooldown === undefined) {
		throw new Error("Invalid cooldown");
	}

	combineQuery(def.q, def.where);

	return {
		name: def.name,
		kind: def.kind,
		classifier: def.classifier || null,
		where: def.where || null,
		q: def.q || null,
		params,
		cooldown: def.cooldown !== undefined ? def.cooldown : null,
		cooldownMs: cooldown,
		message: def.message || "",
		enabled: def.enabled !== false,
		scope: def.scope || "project"
	};
};

const serialise = (def) => {
	const out = { name: def.name, kind: def.kind };
	["classifier", "where", "q", "params", "cooldown", "message"].forEach((key) => {
		if (def[key] !== null && def[key] !== undefined && def[key] !== "") {
			out[key] = def[key];
		}
	});

	if (!def.enabled) {
		out.enabled = false;
	}

	return out;
};

const pathMatches = (pattern, path) => {
	if (!pattern) {
		return true;
	}

	return path.some((name) => {
		return globMatch(pattern, name);
	});
};

const createRuntime = (def, seed, createdAt) => {
	return {
		counter: 0,
		window: [],
		seen: new Set(seed || []),
		pending: new Map(),
		lastEventAt: null,
		lastFired: null,
		firing: false,
		fired: 0,
		suppressed: 0,
		createdAt: createdAt || Date.now(),
		def
	};
};

/**
 * Evaluate an event against an alarm. Returns a firing description or null.
 * Mutates the runtime state.
 */
const evaluateEvent = (alarm, runtime, event, test) => {
	const p = alarm.params;

	switch (alarm.kind) {
		case "every": {
			if (!pathMatches(alarm.classifier, event.path) || !test(event)) {
				return null;
			}

			runtime.counter++;
			return runtime.counter % p.n === 0 ? { value: runtime.counter, text: runtime.counter + " matching events" } : null;
		}
		case "rate": {
			if (!pathMatches(alarm.classifier, event.path) || !test(event)) {
				return null;
			}

			const windowMs = parseDuration(p.window);
			runtime.window.push(event.t);

			while (runtime.window.length && runtime.window[0] <= event.t - windowMs) {
				runtime.window.shift();
			}

			if (runtime.window.length >= p.count) {
				return { value: runtime.window.length, text: runtime.window.length + " events in " + p.window };
			}

			runtime.firing = false;
			return null;
		}
		case "absence": {
			if (pathMatches(alarm.classifier, event.path) && test(event)) {
				runtime.lastEventAt = Math.max(runtime.lastEventAt || 0, event.t);
				runtime.firing = false;
			}

			return null;
		}
		case "threshold": {
			if (!pathMatches(alarm.classifier, event.path) || !test(event)) {
				return null;
			}

			const windowMs = parseDuration(p.window);
			runtime.window.push(event);

			while (runtime.window.length && runtime.window[0].t <= event.t - windowMs) {
				runtime.window.shift();
			}

			const value = aggregate(p.agg || "avg", runtime.window, p.field);
			const op = OPS[p.op || ">"];

			if (value !== null && op(value, p.value)) {
				return { value, text: (p.agg || "avg") + "(" + p.field + ") = " + Math.round(value * 100) / 100 + " " + (p.op || ">") + " " + p.value + " over " + p.window };
			}

			runtime.firing = false;
			return null;
		}
		case "new_value": {
			if (!pathMatches(alarm.classifier, event.path) || !test(event)) {
				return null;
			}

			const raw = getField(event, p.field);

			if (raw === undefined || raw === null) {
				return null;
			}

			const value = String(raw);

			if (runtime.seen.has(value)) {
				return null;
			}

			if (runtime.seen.size >= SEEN_CAP) {
				runtime.seen.delete(runtime.seen.values().next().value);
			}

			runtime.seen.add(value);
			runtime.seenChanged = true;
			return { value, text: p.field + " = " + value + " (new)" };
		}
		case "sequence": {
			const withinMs = parseDuration(p.within);
			const keyOf = (ev) => {
				if (!p.key) {
					return "*";
				}

				const v = getField(ev, p.key);
				return v === undefined || v === null ? null : String(v);
			};

			if (pathMatches(p.then, event.path) && test(event)) {
				const key = keyOf(event);
				const startedAt = key === null ? undefined : runtime.pending.get(key);

				if (startedAt !== undefined && event.t - startedAt <= withinMs) {
					runtime.pending.delete(key);
					return { value: key, text: p.first + " → " + p.then + " within " + Math.round(event.t - startedAt) + "ms" + (p.key ? " (" + p.key + "=" + key + ")" : "") };
				}
			}

			if (pathMatches(p.first, event.path) && test(event)) {
				const key = keyOf(event);

				if (key !== null) {
					runtime.pending.set(key, event.t);

					if (runtime.pending.size > SEQUENCE_PENDING_CAP) {
						runtime.pending.delete(runtime.pending.keys().next().value);
					}
				}
			}

			return null;
		}
		default:
			return null;
	}
};

/**
 * @param {{ historySize: number, onFire: function(object), now?: function(): number,
 *   sourceActivity: function(string): Array<{ source: string, last: ?number }>,
 *   knownValues?: function(string, string): string[] }} options
 */
const createAlarms = (options) => {
	const alarms = new Map();
	const runtimes = new Map();
	const tests = new Map();
	const history = createRingBuffer(options.historySize);
	const now = options.now || Date.now;
	const state = { timer: null, unclassifiedWindow: [] };

	const testFor = (alarm) => {
		if (!tests.has(alarm.name)) {
			const where = combineQuery(alarm.q, alarm.where);
			tests.set(alarm.name, compileWhere(where, { get: getField }));
		}

		return tests.get(alarm.name);
	};

	const fire = (alarm, runtime, result, event) => {
		const t = event ? event.t : now();

		if (runtime.lastFired !== null && alarm.cooldownMs > 0 && t - runtime.lastFired < alarm.cooldownMs) {
			runtime.suppressed++;
			return null;
		}

		runtime.lastFired = t;
		runtime.firing = true;
		runtime.fired++;

		const firing = {
			alarm: alarm.name,
			kind: alarm.kind,
			t: new Date(t).toISOString(),
			value: result.value,
			text: result.text,
			message: alarm.message || null,
			classifier: alarm.classifier,
			sample: event ? { id: event.id, classifier: event.classifier, source: event.source, fields: event.fields, raw: event.raw } : null
		};

		history.push(firing);
		options.onFire(firing);
		return firing;
	};

	const tick = () => {
		const t = now();

		alarms.forEach((alarm) => {
			if (!alarm.enabled) {
				return;
			}

			const runtime = runtimes.get(alarm.name);

			if (alarm.kind === "absence") {
				const windowMs = parseDuration(alarm.params.window);
				const since = runtime.lastEventAt !== null ? runtime.lastEventAt : runtime.createdAt;

				if (!runtime.firing && t - since >= windowMs) {
					runtime.firing = true;
					fire(alarm, runtime, { value: t - since, text: "no matching events for " + alarm.params.window }, null);
				}
			}

			if (alarm.kind === "source_silent") {
				const windowMs = parseDuration(alarm.params.window);
				const silent = options.sourceActivity(alarm.params.source).filter((entry) => {
					const last = entry.last !== null ? entry.last : entry.started;
					return last !== null && t - last >= windowMs;
				});

				if (silent.length && !runtime.firing) {
					runtime.firing = true;
					fire(alarm, runtime, {
						value: silent.map((entry) => {
							return entry.source;
						}).join(", "),
						text: silent.map((entry) => {
							return entry.source;
						}).join(", ") + " silent for " + alarm.params.window
					}, null);
				} else if (!silent.length) {
					runtime.firing = false;
				}
			}
		});
	};

	const engine = {
		KINDS,

		/** Validate and store an alarm. `seed` pre-fills new_value seen sets. */
		define: (input, seed) => {
			const alarm = normalise(input);
			alarms.set(alarm.name, alarm);
			tests.delete(alarm.name);
			let initial = seed || [];

			if (!seed && alarm.kind === "new_value" && options.knownValues) {
				initial = options.knownValues(alarm.classifier, alarm.params.field);
			}

			runtimes.set(alarm.name, createRuntime(alarm, initial, now()));
			return alarm;
		},

		remove: (name) => {
			tests.delete(name);
			runtimes.delete(name);
			return alarms.delete(name);
		},

		get: (name) => {
			return alarms.get(name) || null;
		},

		list: () => {
			return Array.from(alarms.values()).map((alarm) => {
				const runtime = runtimes.get(alarm.name);
				return Object.assign({}, serialise(alarm), {
					scope: alarm.scope,
					state: runtime.firing ? "firing" : "ok",
					fired: runtime.fired,
					suppressed: runtime.suppressed,
					last_fired: runtime.lastFired ? new Date(runtime.lastFired).toISOString() : null
				});
			});
		},

		defs: () => {
			return Array.from(alarms.values());
		},

		/** Persistable runtime bits (new_value seen sets). Clears the changed flags. */
		persistentState: () => {
			const out = {};
			runtimes.forEach((runtime) => {
				runtime.seenChanged = false;
			});
			alarms.forEach((alarm) => {
				if (alarm.kind === "new_value") {
					out[alarm.name] = { seen: Array.from(runtimes.get(alarm.name).seen).slice(-SEEN_CAP) };
				}
			});

			return out;
		},

		/** Live classified event. */
		onEvent: (event) => {
			const changedBefore = Array.from(runtimes.values()).some((runtime) => {
				return runtime.seenChanged;
			});

			alarms.forEach((alarm) => {
				if (!alarm.enabled || alarm.kind === "unclassified" || alarm.kind === "source_silent") {
					return;
				}

				const runtime = runtimes.get(alarm.name);
				const result = evaluateEvent(alarm, runtime, event, testFor(alarm));

				if (result) {
					fire(alarm, runtime, result, event);
				}
			});

			const changedNow = Array.from(runtimes.values()).some((runtime) => {
				return runtime.seenChanged;
			});

			if (changedNow && !changedBefore && options.onStateChange) {
				options.onStateChange();
			}
		},

		/** Live unclassified record. */
		onUnclassified: (record) => {
			alarms.forEach((alarm) => {
				if (!alarm.enabled || alarm.kind !== "unclassified") {
					return;
				}

				const runtime = runtimes.get(alarm.name);
				const windowMs = parseDuration(alarm.params.window);
				runtime.window.push(record.t);

				while (runtime.window.length && runtime.window[0] <= record.t - windowMs) {
					runtime.window.shift();
				}

				if (runtime.window.length >= alarm.params.count) {
					fire(alarm, runtime, { value: runtime.window.length, text: runtime.window.length + " unclassified records in " + alarm.params.window }, null);
				}
			});
		},

		/**
		 * Dry-run an alarm definition over stored events (sorted by time).
		 * Returns what would have fired, respecting cooldown. No notifications.
		 */
		backfill: (input, events) => {
			const alarm = normalise(input);
			const runtime = createRuntime(alarm, []);
			const test = compileWhere(combineQuery(alarm.q, alarm.where), { get: getField });
			const firings = [];

			events.forEach((event) => {
				const result = evaluateEvent(alarm, runtime, event, test);

				if (!result) {
					return;
				}

				if (runtime.lastFired !== null && alarm.cooldownMs > 0 && event.t - runtime.lastFired < alarm.cooldownMs) {
					return;
				}

				runtime.lastFired = event.t;
				firings.push({ t: new Date(event.t).toISOString(), value: result.value, text: result.text, event_id: event.id });
			});

			return { would_fire: firings.length, firings: firings.slice(0, 50), learned_values: runtime.seen.size || undefined, seen: Array.from(runtime.seen) };
		},

		history: (query) => {
			const q = query || {};
			return history.toArray().filter((firing) => {
				return !q.alarm || firing.alarm === q.alarm;
			}).slice(-(q.limit || 50)).reverse();
		},

		start: () => {
			if (!state.timer) {
				state.timer = setInterval(tick, TIMER_MS);
				state.timer.unref();
			}
		},

		stop: () => {
			clearInterval(state.timer);
			state.timer = null;
		},

		tick,

		clear: () => {
			alarms.clear();
			runtimes.clear();
			tests.clear();
		}
	};

	return engine;
};

module.exports = {
	createAlarms,
	normalise,
	serialise,
	KINDS
};
