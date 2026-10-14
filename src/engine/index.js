const EventEmitter = require("events");

const createPatterns = require("../patterns").createPatterns;
const createClassifiers = require("../classifier").createClassifiers;
const childBody = require("../classifier").childBody;
const serialiseClassifier = require("../classifier").serialise;
const createClusterer = require("../clusterer").createClusterer;
const createMetrics = require("../metrics").createMetrics;
const createAlarms = require("../alarms").createAlarms;
const serialiseAlarm = require("../alarms").serialise;
const createNotifier = require("../notifier").createNotifier;
const createSources = require("../sources").createSources;
const serialiseSource = require("../sources").serialise;
const createQueries = require("./queries").createQueries;
const createRateCounter = require("../utils/rate-counter").createRateCounter;
const createState = require("../state").createState;
const emptyState = require("../state").empty;
const parseTime = require("../utils/units").parseTime;
const createRedaction = require("../redaction").createRedaction;
const maskValues = require("../redaction").maskValues;
const MASK = require("../redaction").MASK;

const SAMPLE_MATCHES = 5;
const NEAR_MISSES = 5;
const DIGEST_TOP = 10;
const DIGEST_SHAPE_MAX = 160;
const VIEW_NAME_RE = /^[A-Za-z0-9_][\w .-]*$/;
const WAIT_DEFAULT_S = 60;
const WAIT_MAX_S = 600;

/*
 * The engine wires everything (SPEC.md §3): record → classify → metrics +
 * alarms, or → unclassified queue + debounced digest. It owns all
 * definitions, their persistence, and retroactive classification.
 */

/**
 * @param {{ settings: object, log?: function(string): void, now?: function(): number }} options
 */
const createEngine = (options) => {
	const settings = options.settings;
	const log = options.log || ((message) => {
		process.stderr.write("[diversity-classifier] " + message + "\n");
	});
	const now = options.now || Date.now;
	const emitter = new EventEmitter();
	emitter.setMaxListeners(100);

	const patterns = createPatterns();
	const classifiers = createClassifiers(patterns);
	const clusterer = createClusterer({
		bufferSize: settings.UNCLASSIFIED_BUFFER,
		maxClusters: settings.MAX_CLUSTERS,
		examples: settings.CLUSTER_EXAMPLES
	});
	const metrics = createMetrics({
		perClassifier: settings.EVENTS_PER_CLASSIFIER,
		total: settings.EVENTS_TOTAL,
		topK: settings.TOPK_VALUES
	});
	const notifier = createNotifier({
		quietMs: settings.DIGEST_QUIET_MS,
		maxWaitMs: settings.DIGEST_MAX_WAIT_MS,
		growthFactor: settings.DIGEST_GROWTH_FACTOR
	});
	const queries = createQueries({ classifiers, metrics, clusterer });
	const redaction = createRedaction();
	const multiline = { pending: new Map(), regexes: new Map() };

	const scopes = {
		parsers: new Map(),
		visualizations: new Map(),
		dashboards: new Map()
	};
	const counters = {
		records: 0,
		classified: 0,
		unclassified: 0,
		envelopeOnly: 0,
		startedAt: now(),
		loadErrors: [],
		bySource: new Map()
	};
	const rates = {
		records: createRateCounter(3600),
		classified: createRateCounter(3600)
	};

	let sources = null;
	let state = null;
	let alarms = null;

	const sourceCounters = (name) => {
		if (!counters.bySource.has(name)) {
			counters.bySource.set(name, { classified: 0, unclassified: 0 });
		}

		return counters.bySource.get(name);
	};

	// ------------------------------------------------------------------ ingest

	/** Field-level redaction: classifiers in the path may list fields to mask (value and raw occurrences). */
	const redactFields = (result, raw) => {
		const names = result.path.reduce((acc, name) => {
			const node = classifiers.get(name);
			return node && node.def.redact ? acc.concat(node.def.redact) : acc;
		}, []);

		if (!names.length) {
			return { fields: result.fields, raw };
		}

		const fields = Object.assign({}, result.fields);
		const values = [];
		Object.keys(fields).forEach((key) => {
			const hit = names.some((name) => {
				return key === name || key.indexOf(name + ".") === 0;
			});

			if (hit && fields[key] !== undefined && fields[key] !== null) {
				values.push(fields[key]);
				fields[key] = MASK;
			}
		});

		return { fields, raw: maskValues(raw, values) };
	};

	const recordEvent = (record, result, live) => {
		const leaf = result.node;
		const redacted = redactFields(result, record.raw);
		const event = metrics.record({
			t: result.time || record.t,
			ingest_t: record.t,
			source: record.source,
			labels: record.labels || {},
			classifier: leaf.name,
			path: result.path,
			fields: redacted.fields,
			raw: redacted.raw,
			assembled: record.assembled
		}, leaf.def.store);

		if (live) {
			alarms.onEvent(event);
			emitter.emit("event", event);
		}

		return event;
	};

	const recordUnclassified = (record, result, live) => {
		const entry = {
			raw: record.raw,
			t: record.t,
			source: record.source,
			labels: record.labels || {},
			envelope: result ? result.envelope : null,
			body: result ? result.body : null,
			assembled: record.assembled
		};
		const added = clusterer.add(entry);

		if (live) {
			alarms.onUnclassified(entry);
			notifier.touchDigest();
			emitter.emit("unclassified", { record: entry, cluster: added.cluster.id, isNew: added.isNew });
		}

		return added;
	};

	/**
	 * Classify a stored record (queue entry or event). Records assembled by
	 * an envelope's multiline rule are continued from that envelope with
	 * their joined body; others go through the full tree.
	 */
	const classifyStored = (record) => {
		if (record.assembled) {
			const continued = classifiers.continueFrom(record.assembled.envelope, record.assembled.fields, record);

			if (continued) {
				return continued;
			}
		}

		const result = classifiers.classify(record);

		if (result && result.multiline) {
			return classifiers.continueFrom(result.node.name, result.fields, record);
		}

		return result;
	};

	const multilineRegex = (node) => {
		const cfg = node.def.multiline;
		const cached = multiline.regexes.get(node.name);

		if (cached && cached.cfg === cfg) {
			return cached.re;
		}

		const re = new RegExp(cfg.start || cfg.continue);
		multiline.regexes.set(node.name, { cfg, re });
		return re;
	};

	const flushPending = (key) => {
		const pending = multiline.pending.get(key);

		if (!pending) {
			return;
		}

		clearTimeout(pending.timer);
		multiline.pending.delete(key);
		const fields = Object.assign({}, pending.fields);
		fields[pending.bodyField] = pending.bodies.join("\n");
		const record = Object.assign({}, pending.record, {
			raw: pending.raws.join("\n"),
			assembled: { envelope: pending.envelope, fields }
		});
		finalize(record, classifyStored(record));
	};

	const flushAllPending = (source) => {
		Array.from(multiline.pending.keys()).forEach((key) => {
			if (!source || multiline.pending.get(key).record.source === source) {
				flushPending(key);
			}
		});
	};

	/** Envelope multiline (SPEC.md §5.4): join continuation bodies per stream + group_by key. */
	const pushMultiline = (record, result) => {
		const node = result.node;
		const cfg = node.def.multiline;
		const bodyField = node.def.body;
		const body = result.fields[bodyField] === undefined || result.fields[bodyField] === null ? "" : String(result.fields[bodyField]);
		const groupValues = cfg.group_by.map((field) => {
			return result.fields[field] === undefined ? "" : String(result.fields[field]);
		});
		const key = [node.name, record.source, JSON.stringify(record.labels || {})].concat(groupValues).join("\u0001");
		const re = multilineRegex(node);
		const isContinuation = cfg.start ? !re.test(body) : re.test(body);
		const pending = multiline.pending.get(key);

		const schedule = (entry) => {
			clearTimeout(entry.timer);
			entry.timer = setTimeout(() => {
				flushPending(key);
			}, cfg.flush_ms);

			if (entry.timer.unref) {
				entry.timer.unref();
			}
		};

		if (isContinuation && pending && pending.bodies.length < cfg.max_lines) {
			pending.bodies.push(body);
			pending.raws.push(record.raw);
			schedule(pending);
			return;
		}

		if (pending) {
			flushPending(key);
		}

		const entry = { envelope: node.name, bodyField, fields: result.fields, record, bodies: [body], raws: [record.raw], timer: null };
		multiline.pending.set(key, entry);
		schedule(entry);
	};

	/** One record from a source. record: { raw, t, source, labels } */
	const ingest = (input) => {
		const raw = redaction.apply(input.raw);
		const record = raw === input.raw ? input : Object.assign({}, input, { raw });
		const result = classifiers.classify(record);

		if (result && result.multiline) {
			pushMultiline(record, result);
			return;
		}

		finalize(record, result);
	};

	/** Count and route a complete (possibly assembled) record. */
	const finalize = (record, result) => {
		counters.records++;
		rates.records.add(record.t);
		const perSource = sourceCounters(record.source);

		if (result && result.classified) {
			counters.classified++;
			perSource.classified++;
			rates.classified.add(record.t);
			recordEvent(record, result, true);
			return;
		}

		counters.unclassified++;
		perSource.unclassified++;

		if (result) {
			counters.envelopeOnly++;
		}

		recordUnclassified(record, result, true);
	};

	const queueRatio = () => {
		const stats = clusterer.stats();
		return { clusters: stats.clusters, records: stats.pending };
	};

	/**
	 * Retroactive classification (SPEC.md §5.5): re-run the current tree over
	 * every buffered unclassified record. Matches leave the queue as events
	 * with their original timestamps (no alarms). Records whose envelope
	 * context changed are re-clustered.
	 */
	const reclassifyQueue = () => {
		flushAllPending();
		const before = queueRatio();
		const absorbed = [];
		const moved = [];
		const byClassifier = new Map();
		const sample = [];

		clusterer.records().forEach((record) => {
			const result = classifyStored(record);

			if (result && result.classified) {
				absorbed.push({ record, leaf: result.node.name });
				rates.classified.add(record.t);
				recordEvent(record, result, false);
				byClassifier.set(result.node.name, (byClassifier.get(result.node.name) || 0) + 1);

				if (sample.length < SAMPLE_MATCHES) {
					sample.push({ classifier: result.node.name, fields: result.fields, raw: record.raw.slice(0, 300) });
				}

				return;
			}

			const envelopeBefore = record.envelope ? record.envelope.name : null;
			const envelopeAfter = result ? result.envelope.name : null;
			const bodyAfter = result ? result.body : null;

			if (envelopeBefore !== envelopeAfter || (result && bodyAfter !== record.body)) {
				moved.push({ record, result });
			}
		});

		const fromClusters = clusterer.absorb(absorbed.map((item) => {
			return item.record;
		}));

		fromClusters.forEach((summary) => {
			if (summary.backlog <= 0) {
				return;
			}

			const owners = new Map();
			absorbed.forEach((item) => {
				if (item.record.clusterId === summary.id) {
					owners.set(item.leaf, (owners.get(item.leaf) || 0) + 1);
				}
			});

			const owner = Array.from(owners.entries()).sort((a, b) => {
				return b[1] - a[1];
			})[0];

			if (owner) {
				metrics.addBacklog(owner[0], summary.backlog);
			}
		});

		if (moved.length) {
			clusterer.absorb(moved.map((item) => {
				return item.record;
			}));
			moved.forEach((item) => {
				recordUnclassified(item.record, item.result, false);
			});
		}

		counters.classified += absorbed.length;
		counters.unclassified -= absorbed.length;

		const after = queueRatio();
		const backlog = fromClusters.reduce((acc, summary) => {
			return acc + summary.backlog;
		}, 0);

		if (absorbed.length || moved.length) {
			emitter.emit("queue", { absorbed: absorbed.length, moved: moved.length });
		}

		return {
			absorbed: absorbed.length,
			by_classifier: Object.fromEntries(byClassifier),
			from_clusters: fromClusters.slice(0, 20).map((summary) => {
				return { id: summary.id, shape: summary.shape.slice(0, DIGEST_SHAPE_MAX), matched: summary.matched, remaining: summary.remaining, backlog: summary.backlog || undefined };
			}),
			reclustered_under_envelope: moved.length || undefined,
			backlog: backlog || undefined,
			sample,
			queue: { before, after }
		};
	};

	/** Re-run classification for stored raw events (SPEC.md §5.5 `reclassify`). */
	const reclassifyEvents = (names) => {
		const events = metrics.events(names).filter((event) => {
			return event.raw !== undefined;
		});
		metrics.dropClassifiers(names);
		const outcome = { reprocessed: events.length, classified: 0, unclassified: 0, by_classifier: {} };

		events.forEach((event) => {
			const record = { raw: event.raw, t: event.ingest_t || event.t, source: event.source, labels: event.labels, assembled: event.assembled };
			const result = classifyStored(record);

			if (result && result.classified) {
				recordEvent(record, result, false);
				outcome.classified++;
				outcome.by_classifier[result.node.name] = (outcome.by_classifier[result.node.name] || 0) + 1;
				return;
			}

			recordUnclassified(record, result, false);
			outcome.unclassified++;
			counters.classified--;
			counters.unclassified++;
		});

		return outcome;
	};

	// ------------------------------------------------------------ persistence

	const persist = () => {
		if (state) {
			state.save();
		}
	};

	const snapshot = () => {
		const out = { project: emptyState(), global: emptyState() };
		const put = (scope, section, value) => {
			const target = out[scope === "global" ? "global" : "project"];
			target[section].push(value);
		};

		patterns.listParsers().forEach((def) => {
			const clean = { name: def.name };

			if (def.template) {
				clean.template = def.template;
			} else {
				clean.regex = def.regex;

				if (def.convert) {
					clean.convert = def.convert;
				}
			}

			if (def.description) {
				clean.description = def.description;
			}

			put(scopes.parsers.get(def.name) || "project", "parsers", clean);
		});

		classifiers.defs().forEach((def) => {
			put(def.scope, "classifiers", serialiseClassifier(def));
		});

		alarms.defs().forEach((def) => {
			put(def.scope, "alarms", serialiseAlarm(def));
		});

		sources.defs().filter((def) => {
			return def.origin === "tool";
		}).forEach((def) => {
			put(def.scope, "sources", serialiseSource(def));
		});

		scopes.visualizations.forEach((def) => {
			put(def.scope, "visualizations", Object.assign({}, def, { scope: undefined }));
		});

		scopes.dashboards.forEach((def) => {
			put(def.scope, "dashboards", Object.assign({}, def, { scope: undefined }));
		});

		const redactionSettings = redaction.persistent();

		if (redactionSettings) {
			out.project.redaction = redactionSettings;
		}

		const notificationSettings = notifier.settings();
		const defaults = { muted: [], quiet_ms: settings.DIGEST_QUIET_MS, max_wait_ms: settings.DIGEST_MAX_WAIT_MS, growth_factor: settings.DIGEST_GROWTH_FACTOR };

		if (JSON.stringify(notificationSettings) !== JSON.stringify(defaults)) {
			out.project.notifications = notificationSettings;
		}

		const alarmState = alarms.persistentState();
		alarms.defs().forEach((def) => {
			if (alarmState[def.name]) {
				out[def.scope === "global" ? "global" : "project"].alarm_state[def.name] = alarmState[def.name];
			}
		});

		return out;
	};

	const definitionsChanged = (kind, name, context) => {
		persist();
		emitter.emit("definitions", { kind, name });

		if (context && context.origin === "ui") {
			notifier.notify({
				kind: "definitions",
				level: "info",
				content: "A human changed " + kind + " '" + name + "' in the web UI.",
				meta: { kind: "definitions", target: kind, name }
			});
		}
	};

	const scopeOf = (value) => {
		if (value && value !== "project" && value !== "global") {
			throw new Error("scope must be project or global");
		}

		return value || "project";
	};

	// ---------------------------------------------------------- definitions

	const engine = {
		emitter,
		notifier,
		settings,
		queries,
		ingest,

		// parsers ---------------------------------------------------------

		defineParser: (input, context) => {
			const scope = scopeOf(input.scope);
			const def = patterns.defineParser(Object.assign({}, input, { scope: undefined }));
			scopes.parsers.set(def.name, scope);
			classifiers.rebuild();
			const affected = classifiers.usingParsers([def.name].concat(patterns.dependentsOf(def.name)));
			const broken = affected.filter((name) => {
				return classifiers.get(name).error;
			}).map((name) => {
				return { classifier: name, error: classifiers.get(name).error };
			});
			const retro = reclassifyQueue();
			definitionsChanged("parser", def.name, context);

			return { parser: def.name, scope, recompiled_classifiers: affected, broken: broken.length ? broken : undefined, retro };
		},

		removeParser: (name, context) => {
			if (!patterns.hasParser(name)) {
				throw new Error("No parser named " + name);
			}

			const users = classifiers.usingParsers([name]);
			const parserUsers = patterns.dependentsOf(name);
			patterns.removeParser(name);
			scopes.parsers.delete(name);
			classifiers.rebuild();
			definitionsChanged("parser", name, context);

			return {
				removed: name,
				now_broken: users.length || parserUsers.length ? { classifiers: users, parsers: parserUsers } : undefined
			};
		},

		listParsers: () => {
			return {
				parsers: patterns.listParsers().map((def) => {
					return {
						name: def.name,
						scope: scopes.parsers.get(def.name) || "project",
						template: def.template,
						regex: def.regex,
						convert: def.convert,
						description: def.description,
						used_by: classifiers.usingParsers([def.name])
					};
				}),
				builtin_types: patterns.listBuiltins(),
				filters: patterns.listFilters()
			};
		},

		// classifiers -----------------------------------------------------

		/**
		 * Dry run (SPEC.md §5.6).
		 * @param {object} input classifier definition (not stored)
		 * @param {{ lines?: string[], cluster?: string, limit?: number }} opts
		 */
		testClassifier: (input, opts) => {
			const o = opts || {};
			const prepared = classifiers.prepare(Object.assign({}, input, { name: input.name || "__test__" }));
			const def = prepared.def;
			const compiled = prepared.compiled;
			const chain = [];
			let cursor = def.parent ? classifiers.get(def.parent) : null;

			while (cursor) {
				chain.unshift(cursor);
				cursor = cursor.parentNode;
			}

			const textFor = (record) => {
				const assembled = record.assembled;

				if (assembled && def.parent === assembled.envelope && !def.on) {
					const envelopeNode = classifiers.get(assembled.envelope);
					const body = envelopeNode ? assembled.fields[envelopeNode.def.body] : undefined;

					if (body !== undefined && body !== null) {
						return { text: childBody(body), inherited: assembled.fields };
					}
				}

				const raw = record.raw;
				let fields = {};
				let text = raw;
				let parentNode = null;
				const ok = chain.every((node) => {
					if (!node.compiled) {
						return false;
					}

					const nodeText = parentNode ? (node.def.on ? fields[node.def.on] : (parentNode.def.envelope ? childBody(fields[parentNode.def.body]) : raw)) : raw;

					if (nodeText === undefined || nodeText === null) {
						return false;
					}

					const m = node.compiled.match(String(nodeText));

					if (!m) {
						return false;
					}

					fields = Object.assign({}, fields, m.fields);
					parentNode = node;
					return true;
				});

				if (!ok) {
					return null;
				}

				if (parentNode) {
					if (def.on) {
						text = fields[def.on];
					} else if (parentNode.def.envelope) {
						text = childBody(fields[parentNode.def.body]);
					}
				}

				return text === undefined || text === null ? null : { text: String(text), inherited: fields };
			};

			let samples = null;
			let fromQueue = false;

			if (o.lines && o.lines.length) {
				samples = o.lines.map((raw) => {
					return { raw: String(raw) };
				});
			} else if (o.cluster) {
				if (!clusterer.get(o.cluster)) {
					throw new Error("No unclassified cluster " + o.cluster);
				}

				samples = clusterer.recordsOf(o.cluster);
				fromQueue = true;
			} else {
				samples = clusterer.records();
				fromQueue = true;
			}

			const matches = [];
			const nearMisses = [];
			const parentMisses = [];
			const clustersHit = new Map();

			samples.forEach((record) => {
				const target = textFor(record);

				if (!target) {
					if (parentMisses.length < NEAR_MISSES) {
						parentMisses.push(record.raw.slice(0, 300));
					}

					return;
				}

				const m = compiled.match(target.text);

				if (m) {
					matches.push({ record, fields: Object.assign({}, target.inherited, m.fields) });

					if (record.clusterId) {
						clustersHit.set(record.clusterId, (clustersHit.get(record.clusterId) || 0) + 1);
					}

					return;
				}

				if (nearMisses.length < NEAR_MISSES && (compiled.prefilter(target.text) || o.lines)) {
					nearMisses.push(Object.assign({ text: target.text.slice(0, 300) }, compiled.diagnose(target.text)));
				}
			});

			return {
				tested: samples.length,
				matched: matches.length,
				source: fromQueue ? (o.cluster ? "cluster " + o.cluster : "unclassified queue") : "given lines",
				would_absorb: fromQueue ? matches.length : undefined,
				clusters_hit: clustersHit.size ? Object.fromEntries(clustersHit) : undefined,
				prefilter_literal: compiled.literal || null,
				field_types: Object.assign({}, chain.reduce((acc, node) => {
					return Object.assign(acc, node.compiled ? node.compiled.fieldTypes : {});
				}, {}), compiled.fieldTypes),
				sample_matches: matches.slice(0, o.limit || SAMPLE_MATCHES).map((match) => {
					return { fields: match.fields, raw: match.record.raw.slice(0, 300) };
				}),
				near_misses: nearMisses.length ? nearMisses : undefined,
				parent_did_not_match: parentMisses.length ? parentMisses : undefined
			};
		},

		defineClassifier: (input, context) => {
			const scope = scopeOf(input.scope);
			const previous = classifiers.has(input.name);
			const def = classifiers.define(Object.assign({}, input, { scope }));
			let reprocessed = null;

			if (previous) {
				reprocessed = reclassifyEvents(classifiers.subtree(def.name));
			}

			const retro = reclassifyQueue();
			definitionsChanged("classifier", def.name, context);
			const node = classifiers.get(def.name);

			return {
				classifier: def.name,
				replaced: previous || undefined,
				scope,
				fields: classifiers.fieldTypes(def.name),
				prefilter_literal: node.compiled.literal || null,
				reprocessed_events: reprocessed || undefined,
				retro
			};
		},

		removeClassifier: (name, context) => {
			if (!classifiers.has(name)) {
				throw new Error("No classifier named " + name);
			}

			const names = classifiers.subtree(name);
			const events = metrics.events(names).filter((event) => {
				return event.raw !== undefined;
			});
			metrics.dropClassifiers(names);
			classifiers.remove(name);
			const outcome = { removed: names, returned_to_queue: 0, reclassified: 0 };

			events.forEach((event) => {
				const record = { raw: event.raw, t: event.ingest_t || event.t, source: event.source, labels: event.labels, assembled: event.assembled };
				const result = classifyStored(record);

				if (result && result.classified) {
					recordEvent(record, result, false);
					outcome.reclassified++;
					return;
				}

				recordUnclassified(record, result, false);
				counters.classified--;
				counters.unclassified++;
				outcome.returned_to_queue++;
			});

			definitionsChanged("classifier", name, context);
			return outcome;
		},

		reclassify: (selector, context) => {
			const names = classifiers.resolve(selector);
			const outcome = reclassifyEvents(names);
			const retro = reclassifyQueue();
			definitionsChanged("classifier", selector || "*", context);
			return Object.assign(outcome, { queue_retro: retro });
		},

		listClassifiers: (args) => {
			const a = args || {};
			const names = a.classifier ? classifiers.resolve(a.classifier) : null;

			return {
				classifiers: classifiers.nodes().filter((node) => {
					return !names || names.indexOf(node.name) !== -1;
				}).map((node) => {
					const stats = metrics.stats(node.name);
					const out = Object.assign({}, serialiseClassifier(node.def), {
						scope: node.def.scope,
						count: stats ? stats.count : 0,
						backlog: stats && stats.backlog ? stats.backlog : undefined,
						rate_1m: Math.round(metrics.rate(node.name, 60) * 100) / 100,
						rate_5m: Math.round(metrics.rate(node.name, 300) * 100) / 100,
						last_seen: stats && stats.last ? new Date(stats.last).toISOString() : null,
						stored: metrics.storedCount([node.name]),
						children: node.children.map((child) => {
							return child.name;
						}),
						error: node.error || undefined
					});

					if (!a.verbose) {
						delete out.description;
					}

					if (a.with_fields) {
						out.fields = classifiers.fieldTypes(node.name);
					}

					if (a.spark) {
						out.spark_60m = metrics.spark(node.name, 60);
					}

					return out;
				})
			};
		},

		// alarms ----------------------------------------------------------

		defineAlarm: (input, context) => {
			const scope = scopeOf(input.scope);
			let backfill = null;
			let seed = null;
			const def = Object.assign({}, input, { scope, backfill: undefined });

			if (input.backfill) {
				const names = def.kind === "sequence" ? classifiers.resolve([def.params.first, def.params.then]) : classifiers.resolve(def.classifier);
				const events = metrics.events(names);
				const result = alarms.backfill(def, events);
				seed = result.seen;
				backfill = { evaluated: events.length, would_fire: result.would_fire, firings: result.firings, learned_values: result.learned_values };
			}

			const alarm = alarms.define(def, seed && seed.length ? seed : null);
			definitionsChanged("alarm", alarm.name, context);
			return { alarm: alarm.name, scope, kind: alarm.kind, backfill: backfill || undefined };
		},

		removeAlarm: (name, context) => {
			if (!alarms.remove(name)) {
				throw new Error("No alarm named " + name);
			}

			definitionsChanged("alarm", name, context);
			return { removed: name };
		},

		listAlarms: () => {
			return { alarms: alarms.list() };
		},

		alarmHistory: (args) => {
			return { firings: alarms.history(args) };
		},

		// sources ---------------------------------------------------------

		addSource: (input, context) => {
			const scope = scopeOf(input.scope);
			const viaTool = !context || context.origin !== "cli";
			const def = sources.add(Object.assign({}, input, { scope, origin: viaTool ? "tool" : "cli" }), { viaTool });
			definitionsChanged("source", def.name, context);
			return { source: def.name, type: def.type, persisted: viaTool };
		},

		removeSource: (name, context) => {
			if (!sources.remove(name)) {
				throw new Error("No source named " + name);
			}

			definitionsChanged("source", name, context);
			return { removed: name };
		},

		restartSource: (name) => {
			sources.restart(name);
			return { restarted: name };
		},

		startSource: (name) => {
			sources.resume(name);
			return { started: name };
		},

		listSources: () => {
			return {
				sources: sources.list().map((entry) => {
					const perSource = counters.bySource.get(entry.name) || { classified: 0, unclassified: 0 };
					const total = perSource.classified + perSource.unclassified;
					return Object.assign(entry, {
						classified_pct: total ? Math.round(perSource.classified / total * 1000) / 10 : null
					});
				})
			};
		},

		/**
		 * Block until something worth looking at happens (or timeout).
		 * @param {{ for?: "any"|"records"|"new_cluster"|"alarm"|"event", count?: number, timeout_s?: number,
		 *   classifier?: string }} args
		 * @returns {Promise<object>}
		 */
		wait: (args) => {
			const a = args || {};
			const kind = a.for || "any";
			const kinds = ["any", "records", "new_cluster", "alarm", "event"];

			if (kinds.indexOf(kind) === -1) {
				throw new Error("for must be one of " + kinds.join(", "));
			}

			const target = Math.max(1, a.count || 1);
			const timeoutMs = Math.min(WAIT_MAX_S, Math.max(1, a.timeout_s || WAIT_DEFAULT_S)) * 1000;
			const started = now();
			const seen = { records: 0, events: 0, new_clusters: [], alarms: [], source_changes: [] };

			return new Promise((resolve) => {
				const listeners = {};
				let timer = null;

				const finish = (reason) => {
					clearTimeout(timer);
					Object.keys(listeners).forEach((name) => {
						emitter.removeListener(name, listeners[name]);
					});
					const stats = clusterer.stats();
					resolve({
						reason,
						waited_ms: now() - started,
						records: seen.records,
						classified_events: seen.events,
						new_clusters: seen.new_clusters.slice(0, DIGEST_TOP).map((id) => {
							const cluster = clusterer.get(id);
							return cluster ? { id, count: cluster.count, shape: cluster.shape.slice(0, DIGEST_SHAPE_MAX) } : { id, absorbed: true };
						}),
						alarms: seen.alarms.length ? seen.alarms : undefined,
						source_changes: seen.source_changes.length ? seen.source_changes : undefined,
						queue: { clusters: stats.clusters, records: stats.pending }
					});
				};

				const check = () => {
					if (kind === "records" && seen.records >= target) {
						finish("records");
					} else if (kind === "event" && seen.events >= target) {
						finish("event");
					} else if (kind === "new_cluster" && seen.new_clusters.length >= target) {
						finish("new_cluster");
					} else if (kind === "alarm" && seen.alarms.length >= target) {
						finish("alarm");
					} else if (kind === "any" && (seen.new_clusters.length || seen.alarms.length || seen.source_changes.length)) {
						finish(seen.alarms.length ? "alarm" : (seen.source_changes.length ? "source" : "new_cluster"));
					}
				};

				listeners.unclassified = (info) => {
					seen.records++;

					if (info.isNew) {
						seen.new_clusters.push(info.cluster);
					}

					check();
				};
				listeners.event = (event) => {
					seen.records++;

					if (!a.classifier || event.path.indexOf(a.classifier) !== -1) {
						seen.events++;
					}

					check();
				};
				listeners.alarm = (firing) => {
					seen.alarms.push({ alarm: firing.alarm, text: firing.text, t: firing.t });
					check();
				};
				listeners.source = (change) => {
					if (change.change === "exited" || change.change === "error") {
						seen.source_changes.push({ source: change.source, change: change.change, error: change.error, stderr_tail: change.stderr_tail });
						check();
					}
				};

				Object.keys(listeners).forEach((name) => {
					emitter.on(name, listeners[name]);
				});
				timer = setTimeout(() => {
					finish("timeout");
				}, timeoutMs);
			});
		},

		ingestLines: (lines, sourceName, labels) => {
			const count = sources.ingest(lines, sourceName, labels);
			flushAllPending(sourceName || "ingest");
			return { ingested: count, source: sourceName || "ingest" };
		},

		// visualizations & dashboards ------------------------------------

		defineView: (kind, input, context) => {
			const map = kind === "dashboard" ? scopes.dashboards : scopes.visualizations;

			if (!input || !VIEW_NAME_RE.test(input.name || "")) {
				throw new Error(kind + " name must match " + VIEW_NAME_RE);
			}

			if (kind === "visualization") {
				const types = ["bar", "histogram", "line", "area", "heatmap", "metric", "table"];

				if (types.indexOf(input.type) === -1) {
					throw new Error("visualization type must be one of " + types.join(", "));
				}
			} else if (!Array.isArray(input.panels)) {
				throw new Error("dashboard needs panels: [{ visualization: name, w?: 1-12, h?: rows }]");
			} else {
				input.panels.forEach((panel) => {
					if (!scopes.visualizations.has(panel.visualization)) {
						throw new Error("Dashboard panel references unknown visualization '" + panel.visualization + "'");
					}
				});
			}

			const def = Object.assign({}, input, { scope: scopeOf(input.scope) });
			map.set(def.name, def);
			definitionsChanged(kind, def.name, context);
			return { [kind]: def.name, url_path: "/#/" + (kind === "dashboard" ? "dashboards" : "visualize") + "/" + encodeURIComponent(def.name) };
		},

		removeView: (kind, name, context) => {
			const map = kind === "dashboard" ? scopes.dashboards : scopes.visualizations;

			if (!map.delete(name)) {
				throw new Error("No " + kind + " named " + name);
			}

			definitionsChanged(kind, name, context);
			return { removed: name };
		},

		listViews: (kind) => {
			const map = kind === "dashboard" ? scopes.dashboards : scopes.visualizations;
			return Array.from(map.values());
		},

		// unclassified ----------------------------------------------------

		getUnclassified: (args) => {
			const a = args || {};

			if (a.cluster) {
				const cluster = clusterer.get(a.cluster);

				if (!cluster) {
					throw new Error("No unclassified cluster " + a.cluster + " (it may have been absorbed)");
				}

				return clusterer.describe(cluster, a.examples || 20);
			}

			const list = clusterer.list({
				sort: a.sort,
				since: parseTime(a.since),
				source: a.source,
				min_count: a.min_count,
				envelope: a.envelope
			});
			const limit = a.limit || 20;
			const offset = a.cursor ? parseInt(a.cursor, 10) || 0 : 0;
			const stats = clusterer.stats();

			return {
				queue: { clusters: list.length, records: stats.pending, buffered: stats.buffered, evicted_records: stats.evicted_records || undefined, evicted_clusters: stats.evicted_clusters || undefined },
				clusters: list.slice(offset, offset + limit).map((cluster) => {
					const described = clusterer.describe(cluster);

					if (!a.verbose) {
						delete described.spark_30m;
						delete described.labels;
						described.examples = described.examples.slice(-2).map((example) => {
							return example.body !== undefined ? example.body : example.raw;
						});
					}

					return described;
				}),
				next_cursor: offset + limit < list.length ? String(offset + limit) : null
			};
		},

		/** Turn a cluster into a count-only ignore classifier (SPEC.md §6). */
		ignoreCluster: (id, context, scope) => {
			const cluster = clusterer.get(id);

			if (!cluster) {
				throw new Error("No unclassified cluster " + id);
			}

			const described = clusterer.describe(cluster);
			const def = {
				name: "ignore." + id,
				template: described.suggested_template,
				store: "count",
				description: "ignored: " + cluster.shape.slice(0, 120),
				tags: ["ignore"],
				scope: scope || "project"
			};

			if (cluster.envelope) {
				def.parent = cluster.envelope;
			}

			return engine.defineClassifier(def, context);
		},

		// notifications ---------------------------------------------------

		/** Ingest-time redaction settings; `test` previews the effect on a sample text. */
		setRedaction: (change, context) => {
			const c = change || {};
			const settings = Object.keys(c).filter((key) => {
				return key !== "test";
			}).length ? redaction.configure(c) : redaction.settings();

			if (Object.keys(c).some((key) => {
				return key !== "test";
			})) {
				definitionsChanged("redaction", "settings", context);
			}

			return Object.assign({ available_builtin: Object.keys(redaction.BUILTINS) }, settings, c.test !== undefined ? { test: redaction.apply(String(c.test)) } : {});
		},

		setNotifications: (change, context) => {
			const result = notifier.configure(change || {});
			definitionsChanged("notifications", "settings", context);
			return result;
		},

		// overview --------------------------------------------------------

		stats: () => {
			const queue = clusterer.stats();
			const recent = rates.records.sum(300);
			const recentClassified = rates.classified.sum(300);
			const nodes = classifiers.nodes();
			const disabled = nodes.filter((node) => {
				return node.error;
			});

			return {
				uptime_s: Math.round((now() - counters.startedAt) / 1000),
				records: {
					total: counters.records,
					classified: counters.classified,
					unclassified: counters.unclassified,
					envelope_only: counters.envelopeOnly || undefined,
					rate_1m: Math.round(rates.records.sum(60) / 60 * 100) / 100
				},
				classified_ratio: {
					all_time: counters.records ? Math.round(counters.classified / counters.records * 1000) / 1000 : null,
					last_5m: recent ? Math.round(recentClassified / recent * 1000) / 1000 : null
				},
				queue: {
					clusters: queue.clusters,
					records: queue.pending,
					buffered: queue.buffered,
					evicted: queue.evicted_records || undefined,
					top: clusterer.list({ sort: "count" }).slice(0, 5).map((cluster) => {
						return { id: cluster.id, count: cluster.count, shape: cluster.shape.slice(0, DIGEST_SHAPE_MAX) };
					})
				},
				classifiers: nodes.length,
				top_classifiers: nodes.map((node) => {
					const stats = metrics.stats(node.name);
					return { name: node.name, count: stats ? stats.count : 0, rate_1m: Math.round(metrics.rate(node.name, 60) * 100) / 100 };
				}).sort((a, b) => {
					return b.count - a.count;
				}).slice(0, 10),
				events: metrics.totals(),
				alarms: alarms.list().filter((alarm) => {
					return alarm.state === "firing";
				}).map((alarm) => {
					return { name: alarm.name, last_fired: alarm.last_fired };
				}),
				sources: sources.list().map((entry) => {
					return { name: entry.name, state: entry.state, records: entry.records, last_record: entry.last_record, error: entry.error };
				}),
				disabled_definitions: disabled.length ? disabled.map((node) => {
					return { classifier: node.name, error: node.error };
				}) : undefined,
				load_errors: counters.loadErrors.length ? counters.loadErrors : undefined,
				notifications: notifier.settings()
			};
		},

		definitionsExport: (args) => {
			const a = args || {};
			const snap = snapshot();
			const pick = (data) => {
				const out = {};
				["parsers", "classifiers", "alarms", "visualizations", "dashboards"].forEach((section) => {
					if (data[section].length) {
						out[section] = data[section];
					}
				});

				if (a.include_sources && data.sources.length) {
					out.sources = data.sources;
				}

				return out;
			};

			if (a.scope) {
				return pick(snap[a.scope]);
			}

			const merged = emptyState();
			["parsers", "classifiers", "alarms", "sources", "visualizations", "dashboards"].forEach((section) => {
				merged[section] = snap.global[section].concat(snap.project[section]);
			});

			return pick(merged);
		},

		/** Import a pack. Order: parsers, classifiers (parents first), alarms, views. */
		definitionsImport: (pack, context) => {
			const scope = scopeOf(pack.scope);
			const result = { imported: {}, errors: [] };
			const count = (section) => {
				result.imported[section] = (result.imported[section] || 0) + 1;
			};

			const apply = (section, list, fn) => {
				(list || []).forEach((item) => {
					try {
						fn(Object.assign({}, item, { scope }));
						count(section);
					} catch (e) {
						result.errors.push(section + " " + (item && item.name) + ": " + e.message);
					}
				});
			};

			const parsers = orderParsers(pack.parsers || []);
			apply("parsers", parsers, (def) => {
				patterns.defineParser(Object.assign({}, def, { scope: undefined }));
				scopes.parsers.set(def.name, scope);
			});

			apply("classifiers", orderClassifiers(pack.classifiers || []), (def) => {
				classifiers.define(def);
			});
			apply("alarms", pack.alarms, (def) => {
				alarms.define(def);
			});
			apply("visualizations", pack.visualizations, (def) => {
				scopes.visualizations.set(def.name, def);
			});
			apply("dashboards", pack.dashboards, (def) => {
				scopes.dashboards.set(def.name, def);
			});

			if (pack.sources && context && context.allowSources) {
				apply("sources", pack.sources, (def) => {
					engine.addSource(def, context);
				});
			}

			result.retro = reclassifyQueue();
			definitionsChanged("pack", "import", context);
			return result;
		},

		// lifecycle -------------------------------------------------------

		start: (startOptions) => {
			const so = startOptions || {};
			state = createState({
				projectFile: settings.STATE_FILE,
				globalFile: settings.NO_GLOBAL ? null : settings.GLOBAL_STATE_FILE,
				onExternalChange: () => {
					log("state file changed on disk, reloading definitions");
					engine.reload();
					notifier.notify({ kind: "definitions", level: "info", content: "State file edited on disk; definitions reloaded.", meta: { kind: "definitions" } });
				},
				log
			});
			state.setSnapshot(snapshot);
			loadDefinitions(true);
			(so.sources || []).forEach((def) => {
				try {
					engine.addSource(def, { origin: "cli" });
				} catch (e) {
					counters.loadErrors.push("source " + def.name + ": " + e.message);
				}
			});
			alarms.start();

			if (so.watch !== false) {
				state.watch();
			}

			if (counters.loadErrors.length) {
				log("load errors: " + counters.loadErrors.join("; "));
			}
		},

		/** Re-read the state files and re-apply all definitions. */
		reload: () => {
			const before = new Set(classifiers.nodes().map((node) => {
				return node.name;
			}));
			loadDefinitions(false);
			const after = new Set(classifiers.nodes().map((node) => {
				return node.name;
			}));
			const gone = Array.from(before).filter((name) => {
				return !after.has(name);
			});

			if (gone.length) {
				metrics.dropClassifiers(gone);
			}

			reclassifyQueue();
			emitter.emit("definitions", { kind: "reload" });
		},

		stop: () => {
			flushAllPending();
			alarms.stop();
			notifier.stop();
			sources.stopAll();

			if (state) {
				state.saveNow();
				state.close();
			}
		},

		flush: () => {
			flushAllPending();
			notifier.flushDigest();

			if (state) {
				state.saveNow();
			}
		},

		internals: { patterns, classifiers, clusterer, metrics }
	};

	// ---------------------------------------------------------- wiring

	alarms = createAlarms({
		historySize: settings.ALARM_HISTORY,
		now,
		onStateChange: () => {
			persist();
		},
		sourceActivity: (pattern) => {
			return sources.activity(pattern);
		},
		knownValues: (classifier, field) => {
			return classifiers.resolve(classifier).reduce((acc, name) => {
				return acc.concat(metrics.knownValues(name, field));
			}, []);
		},
		onFire: (firing) => {
			const content = "ALARM " + firing.alarm + ": " + firing.text + (firing.message ? " (" + firing.message + ")" : "") +
				(firing.sample && firing.sample.raw ? "\n  e.g. " + String(firing.sample.raw).slice(0, 300) : "");
			notifier.notify({
				kind: "alarm",
				level: "warning",
				content,
				meta: { kind: "alarm", alarm: firing.alarm, alarm_kind: firing.kind, value: String(firing.value) }
			});
			emitter.emit("alarm", firing);
		}
	});

	sources = createSources({
		allowCommands: !settings.NO_COMMANDS,
		now,
		onRecord: ingest,
		onStatus: (change) => {
			emitter.emit("source", change);

			if (change.change === "exited" || change.change === "error") {
				notifier.notify({
					kind: "source",
					level: "warning",
					content: "Source " + change.source + " " + change.change +
						(change.code !== undefined && change.code !== null ? " (code " + change.code + ")" : "") +
						(change.error ? ": " + change.error : "") +
						(change.stderr_tail ? "\n" + change.stderr_tail : ""),
					meta: { kind: "source", source: change.source, change: change.change }
				});
			}
		}
	});

	notifier.setDigestBuilder((digestSettings) => {
		const all = clusterer.all();
		const fresh = all.filter((cluster) => {
			return cluster.notifiedCount === 0;
		});
		const grown = all.filter((cluster) => {
			return cluster.notifiedCount > 0 && cluster.count >= cluster.notifiedCount * digestSettings.growthFactor;
		});

		if (!fresh.length && !grown.length) {
			return null;
		}

		const report = fresh.concat(grown).sort((a, b) => {
			return b.count - a.count;
		});
		report.forEach((cluster) => {
			cluster.notifiedCount = cluster.count;
		});

		const stats = clusterer.stats();
		const ratio = engine.stats().classified_ratio.last_5m;
		const lines = report.slice(0, DIGEST_TOP).map((cluster) => {
			const shape = cluster.shape.length > DIGEST_SHAPE_MAX ? cluster.shape.slice(0, DIGEST_SHAPE_MAX) + "…" : cluster.shape;
			const tag = cluster.notifiedCount === cluster.count && fresh.indexOf(cluster) !== -1 ? "new" : "grew";
			return "  [" + cluster.id + "] " + tag + " ×" + cluster.count + (cluster.envelope ? " (" + cluster.envelope + ")" : "") + "  " + shape;
		});
		const more = report.length > DIGEST_TOP ? "\n  … and " + (report.length - DIGEST_TOP) + " more" : "";
		const header = "Unclassified: " + fresh.length + " new, " + grown.length + " grown cluster(s). Queue: " +
			stats.clusters + " clusters / " + stats.pending + " records" +
			(ratio !== null ? "; classified last 5m: " + Math.round(ratio * 1000) / 10 + "%" : "") + ".";

		return {
			kind: "unclassified",
			level: "info",
			content: header + "\n" + lines.join("\n") + more + "\nInspect with get_unclassified; absorb with test_classifier → define_classifier.",
			meta: { kind: "unclassified", new_clusters: String(fresh.length), grown_clusters: String(grown.length), queue_clusters: String(stats.clusters) }
		};
	});

	/** Parsers may reference each other: order so dependencies come first. */
	const orderParsers = (list) => {
		const byName = new Map(list.map((def) => {
			return [def.name, def];
		}));
		const out = [];
		const visiting = new Set();
		const done = new Set();
		const visit = (def) => {
			if (done.has(def.name) || visiting.has(def.name)) {
				return;
			}

			visiting.add(def.name);

			if (def.template) {
				patterns.tokenize(def.template).forEach((token) => {
					if (token.kind === "cap" && token.typeName && byName.has(token.typeName)) {
						visit(byName.get(token.typeName));
					}
				});
			}

			visiting.delete(def.name);
			done.add(def.name);
			out.push(def);
		};

		list.forEach(visit);
		return out;
	};

	const orderClassifiers = (list) => {
		const byName = new Map(list.map((def) => {
			return [def.name, def];
		}));
		const out = [];
		const done = new Set();
		const visit = (def, depth) => {
			if (done.has(def.name) || depth > 50) {
				return;
			}

			if (def.parent && byName.has(def.parent)) {
				visit(byName.get(def.parent), depth + 1);
			}

			done.add(def.name);
			out.push(def);
		};

		list.forEach((def) => {
			visit(def, 0);
		});
		return out;
	};

	/** Apply state layers (global, then project). Invalid definitions load disabled. */
	const loadDefinitions = (initial) => {
		const loaded = state.load();
		counters.loadErrors = loaded.errors.slice();

		patterns.clear();
		scopes.parsers.clear();
		scopes.visualizations.clear();
		scopes.dashboards.clear();
		classifiers.clear();
		const alarmNames = alarms.defs().map((def) => {
			return def.name;
		});
		alarmNames.forEach((name) => {
			alarms.remove(name);
		});

		const merged = { parsers: new Map(), classifiers: new Map(), alarms: new Map(), sources: new Map(), visualizations: new Map(), dashboards: new Map() };
		let notificationSettings = null;
		let redactionSettings = null;
		const alarmState = {};

		loaded.layers.forEach((layer) => {
			Object.keys(merged).forEach((section) => {
				(layer.data[section] || []).forEach((def) => {
					if (def && def.name) {
						merged[section].set(def.name, Object.assign({}, def, { scope: layer.scope }));
					}
				});
			});

			if (layer.data.notifications) {
				notificationSettings = layer.data.notifications;
			}

			if (layer.data.redaction) {
				redactionSettings = layer.data.redaction;
			}

			Object.assign(alarmState, layer.data.alarm_state || {});
		});

		orderParsers(Array.from(merged.parsers.values())).forEach((def) => {
			try {
				patterns.defineParser(Object.assign({}, def, { scope: undefined }));
				scopes.parsers.set(def.name, def.scope);
			} catch (e) {
				counters.loadErrors.push("parser " + def.name + ": " + e.message);
			}
		});

		orderClassifiers(Array.from(merged.classifiers.values())).forEach((def) => {
			try {
				classifiers.define(def, true);
			} catch (e) {
				counters.loadErrors.push("classifier " + def.name + ": " + e.message);
			}
		});

		merged.alarms.forEach((def) => {
			try {
				const saved = alarmState[def.name];
				alarms.define(def, saved && saved.seen ? saved.seen : null);
			} catch (e) {
				counters.loadErrors.push("alarm " + def.name + ": " + e.message);
			}
		});

		merged.visualizations.forEach((def) => {
			scopes.visualizations.set(def.name, def);
		});
		merged.dashboards.forEach((def) => {
			scopes.dashboards.set(def.name, def);
		});

		redaction.reset();

		if (redactionSettings) {
			try {
				redaction.configure(redactionSettings);
			} catch (e) {
				counters.loadErrors.push("redaction: " + e.message);
			}
		}

		if (notificationSettings) {
			try {
				notifier.configure({
					mute: notificationSettings.muted || [],
					quiet_ms: notificationSettings.quiet_ms,
					max_wait_ms: notificationSettings.max_wait_ms,
					growth_factor: notificationSettings.growth_factor
				});
			} catch (e) {
				counters.loadErrors.push("notifications: " + e.message);
			}
		}

		const wanted = new Map();
		merged.sources.forEach((def) => {
			wanted.set(def.name, def);
		});

		sources.defs().filter((def) => {
			return def.origin === "tool";
		}).forEach((def) => {
			const next = wanted.get(def.name);

			if (!next || JSON.stringify(serialiseSource(def)) !== JSON.stringify(serialiseSource(Object.assign({}, def, next)))) {
				sources.remove(def.name);
			} else {
				wanted.delete(def.name);
			}
		});

		wanted.forEach((def) => {
			if (sources.has(def.name)) {
				return;
			}

			try {
				const paused = def.type === "command" && !settings.RESUME_SOURCES;
				sources.add(Object.assign({}, def, { origin: "tool" }), { viaTool: !initial, paused });
			} catch (e) {
				counters.loadErrors.push("source " + def.name + ": " + e.message);
			}
		});
	};

	return engine;
};

module.exports = {
	createEngine
};
