/*
 * Tool table shared by MCP and the REST API (SPEC.md §11, §13.3).
 * Each tool: { name, description, inputSchema, mutates, handler(engine, args, ctx) }.
 * ctx: { origin: "mcp" | "ui", startWeb?: function(): Promise<string> }
 */

const str = (description) => {
	return { type: "string", description };
};

const num = (description) => {
	return { type: "number", description };
};

const bool = (description) => {
	return { type: "boolean", description };
};

const obj = (description) => {
	return { type: "object", description, additionalProperties: true };
};

const strOrList = (description) => {
	return { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description };
};

const schema = (properties, required) => {
	return { type: "object", properties, required: required || [], additionalProperties: false };
};

const FILTER_PROPS = {
	classifier: strOrList("Classifier name or glob (\"app.*\"); includes sub-classifiers. Omit for all."),
	q: str("Query string, e.g. 'status >= 500 and not path:/health* and took > 2s and $source:api and $labels.pod:api-*'. Typed literals (2s, 1MB, ISO time) compare by field type; bare words search the raw line."),
	where: obj("Structured filter, ANDed with q: { field: value | { eq|ne|gt|gte|lt|lte|in|nin|regex|glob|exists|contains: v }, or: [...], and: [...], not: {...} }"),
	since: str("Start: ISO time or relative like '-15m', '2h'"),
	until: str("End: ISO time, relative, or 'now'")
};

const CLASSIFIER_PROPS = {
	name: str("Unique name, e.g. 'nginx.access' or 'app.db.conn_failed'"),
	template: str("Template: literal text + {field:type} captures. Types: word text rest int float hex bool uuid ip ipv4 ipv6 host port email url path pathname qs iso8601 timestamp duration(→ms) bytes level quoted json kv enum(a,b) regex(..), or a parser name. {f:type|lower|map(a=b)} converters, {f?:type} optional, {f:/re/} inline regex, {_:type}/{*} skip, {...parser} spreads a template parser's fields. Whitespace matches any run; ^/$ anchor; {{ }} literal braces."),
	regex: str("Alternative to template: JS regex with named groups (use __ for dots: peer__host → peer.host)"),
	flags: str("Regex flags for `regex`"),
	types: obj("For `regex`: { field: builtinType } conversions"),
	description: str("What this classifier means"),
	priority: num("Higher is tried first (default 0). First matching top-level classifier wins."),
	sources: { type: "array", items: { type: "string" }, description: "Only apply to these sources (names/globs)" },
	time_field: str("Use this (timestamp) field as event time instead of ingest time"),
	store: { type: "string", enum: ["full", "fields", "count"], description: "full = fields + raw line (default); fields = no raw; count = counters/aggregates only (use for noise, 'ignore.*')" },
	tags: { type: "array", items: { type: "string" } },
	parent: str("Make this a sub-classifier: only runs on records the parent matched"),
	on: str("Sub-classifier: match against this parent field instead of the raw line (envelope children default to the envelope body)"),
	envelope: bool("Envelope: captures a common line head + body; records matching only the envelope stay unclassified and are clustered by body. Attach real classifiers as children."),
	body: str("Envelope body field (default 'msg'); must be captured, typically {msg:rest}"),
	multiline: obj("Envelope only: join continuation lines (stack traces) by their BODY, after the head is stripped: { continue: '^\\s+at |^\\s' } or { start: '^[A-Z]\\w+Error|^\\S' }, group_by: ['task'] (envelope fields that identify one interleaved stream), flush_ms (default 300). The joined record is classified as one; {x:rest} spans lines."),
	redact: { type: "array", items: { type: "string" }, description: "Fields whose values are masked as [REDACTED] in stored events and in the raw line (prefix match: 'auth' covers auth.*)" },
	enabled: bool("Default true"),
	scope: { type: "string", enum: ["project", "global"], description: "Which state file to persist to (default project; global = shared across projects)" }
};

const pick = (source, keys) => {
	const out = {};
	keys.forEach((key) => {
		if (source[key] !== undefined) {
			out[key] = source[key];
		}
	});

	return out;
};

const CLASSIFIER_KEYS = Object.keys(CLASSIFIER_PROPS);

const TOOLS = [
	{
		name: "stats",
		description: "Overview: record counts, classified ratio (all-time and last 5m), unclassified queue size and top clusters, top classifiers with rates, firing alarms, source health, disabled definitions and load errors. Start here.",
		inputSchema: schema({}),
		handler: (engine) => {
			return engine.stats();
		}
	},
	{
		name: "get_unclassified",
		description: "The unclassified queue: records no classifier matches, grouped into clusters by masked shape (numbers, ids, IPs, timestamps... replaced). Each cluster has count, shape, examples and a suggested_template you can refine and pass to test_classifier / define_classifier. Pass `cluster` for one cluster with more examples.",
		inputSchema: schema({
			cluster: str("Cluster id for detail view"),
			examples: num("Examples for detail view (default 20)"),
			sort: { type: "string", enum: ["count", "recent", "new"] },
			limit: num("Default 20"),
			cursor: str("Pagination cursor from previous result"),
			since: str("Only clusters seen since (ISO / relative)"),
			source: str("Only clusters seen on this source"),
			min_count: num("Minimum count"),
			envelope: str("Only clusters under this envelope classifier"),
			verbose: bool("Include sparkline, labels and full examples")
		}),
		handler: (engine, args) => {
			return engine.getUnclassified(args);
		}
	},
	{
		name: "search_unclassified",
		description: "Search raw buffered unclassified records with q/where (bare words search the raw line; envelope fields like level are available).",
		inputSchema: schema(Object.assign(pick(FILTER_PROPS, ["q", "where", "since", "until"]), { limit: num("Default 50") })),
		handler: (engine, args) => {
			return engine.queries.unclassifiedRecords(args);
		}
	},
	{
		name: "test_classifier",
		description: "Dry run a classifier definition WITHOUT saving: runs it against `lines`, one `cluster`, or the whole unclassified queue. Returns matched/would_absorb counts, extracted sample fields, field types, and near_misses with a diagnosis (matched_up_to / failed_at) showing exactly which template piece failed.",
		inputSchema: schema(Object.assign({}, CLASSIFIER_PROPS, {
			name: str("Optional for tests"),
			lines: { type: "array", items: { type: "string" }, description: "Sample lines to test against instead of the queue" },
			cluster: str("Test against one unclassified cluster"),
			limit: num("Number of sample matches to return (default 5)")
		})),
		handler: (engine, args) => {
			return engine.testClassifier(pick(args, CLASSIFIER_KEYS), { lines: args.lines, cluster: args.cluster, limit: args.limit });
		}
	},
	{
		name: "define_classifier",
		description: "Create or replace a classifier. Prefer templates with typed captures (int, duration, bytes...) over catch-all regexes: typed fields are what histograms, field_summary and threshold alarms work on. It immediately runs over the whole unclassified queue: matching records leave the queue and become events with their original timestamps (no alarms fire for them). Returns retro.absorbed and the queue before/after. Persisted for the next run.",
		mutates: true,
		inputSchema: schema(CLASSIFIER_PROPS, ["name"]),
		handler: (engine, args, ctx) => {
			return engine.defineClassifier(pick(args, CLASSIFIER_KEYS), ctx);
		}
	},
	{
		name: "remove_classifier",
		description: "Remove a classifier and its sub-classifiers. Their stored raw records are re-classified or returned to the unclassified queue.",
		mutates: true,
		inputSchema: schema({ name: str("Classifier name") }, ["name"]),
		handler: (engine, args, ctx) => {
			return engine.removeClassifier(args.name, ctx);
		}
	},
	{
		name: "list_classifiers",
		description: "Classifier definitions with counts, rates (1m/5m), stored events, children and errors.",
		inputSchema: schema({
			classifier: strOrList("Filter by name/glob"),
			with_fields: bool("Include field → type map"),
			spark: bool("Include per-minute counts for the last 60 minutes"),
			verbose: bool("Include descriptions")
		}),
		handler: (engine, args) => {
			return engine.listClassifiers(args);
		}
	},
	{
		name: "reclassify",
		description: "Re-run classification over retained raw events of a classifier subtree (or all), e.g. after changing priorities. Aggregates of affected classifiers are rebuilt from retained events.",
		mutates: true,
		inputSchema: schema({ classifier: strOrList("Name/glob; omit for all") }),
		handler: (engine, args, ctx) => {
			return engine.reclassify(args.classifier, ctx);
		}
	},
	{
		name: "ignore_cluster",
		description: "Shortcut for noise: turns a cluster's suggested template into an 'ignore.<id>' classifier with store=count. It leaves the queue but stays counted (and alarmable).",
		mutates: true,
		inputSchema: schema({ id: str("Cluster id"), scope: CLASSIFIER_PROPS.scope }, ["id"]),
		handler: (engine, args, ctx) => {
			return engine.ignoreCluster(args.id, ctx, args.scope);
		}
	},
	{
		name: "define_parser",
		description: "Define a reusable custom type. Template parser: { name: 'head', template: '^{ts:timestamp} {level:level} [{logger:word}]' } → use as {h:head} (fields h.ts, h.level...) or spread {...head} (fields ts, level...). Regex parser: { name: 'reqid', regex: 'req-[0-9a-f]{8}', convert: 'upper' } (no named groups). Classifiers using it are recompiled and the queue is re-run.",
		mutates: true,
		inputSchema: schema({
			name: str("Parser name (must not shadow a built-in type)"),
			template: str("Template (may reference other parsers)"),
			regex: str("Regex without named groups"),
			convert: strOrList("Converter chain for regex parsers: lower upper trim int float duration bytes timestamp s ms map(a=b) default(v) truncate(n)"),
			description: str("Description"),
			scope: CLASSIFIER_PROPS.scope
		}, ["name"]),
		handler: (engine, args, ctx) => {
			return engine.defineParser(args, ctx);
		}
	},
	{
		name: "remove_parser",
		description: "Remove a custom parser. Classifiers that use it become disabled with an error until fixed.",
		mutates: true,
		inputSchema: schema({ name: str("Parser name") }, ["name"]),
		handler: (engine, args, ctx) => {
			return engine.removeParser(args.name, ctx);
		}
	},
	{
		name: "list_parsers",
		description: "Custom parsers (with usage), built-in types and converter filters.",
		inputSchema: schema({}),
		handler: (engine) => {
			return engine.listParsers();
		}
	},
	{
		name: "search_events",
		description: "Search classified events (newest first) by classifier, q/where and time. Retained events only; see retained_since.",
		inputSchema: schema(Object.assign({}, FILTER_PROPS, {
			limit: num("Default 50, max 1000"),
			cursor: str("Pagination cursor"),
			order: { type: "string", enum: ["desc", "asc"] },
			fields: { type: "array", items: { type: "string" }, description: "Projection; include '$raw' for the raw line" }
		})),
		handler: (engine, args) => {
			return engine.queries.search(args);
		}
	},
	{
		name: "count",
		description: "Count matching retained events (cheap; no event payloads).",
		inputSchema: schema(FILTER_PROPS),
		handler: (engine, args) => {
			return engine.queries.count(args);
		}
	},
	{
		name: "sequences",
		description: "Ad-hoc sequence analysis: time between an event of `first` and the next event of `then` with the same `key` value (e.g. per worker/request id). Returns gap stats overall and per key, unmatched count, and recent pairs. The alarm counterpart is kind=sequence.",
		inputSchema: schema(Object.assign(pick(FILTER_PROPS, ["q", "where", "since", "until"]), {
			first: str("Classifier name/glob of the starting event"),
			then: str("Classifier name/glob of the following event"),
			key: str("Field that must match on both (omit for a single global sequence)"),
			within: str("Ignore pairs further apart than this, e.g. '5m'"),
			top: num("Keys to return (default 20)")
		}), ["first", "then"]),
		handler: (engine, args) => {
			return engine.queries.sequences(args);
		}
	},
	{
		name: "histogram",
		description: "Distribution of a field. Strings → top values with counts/%; numbers → stats (min/max/avg/p50/p90/p99) + buckets (+ value counts when low-cardinality). Without filters on a single classifier it uses all-time aggregates; with q/where/since/group_by it is exact over retained events. group_by gives one histogram per value of another field.",
		inputSchema: schema(Object.assign({}, FILTER_PROPS, {
			field: str("Field name, or $source / $labels.x / classifier"),
			buckets: num("Equal-width buckets for numeric fields (default 20)"),
			bounds: { type: "array", items: { type: "number" }, description: "Explicit bucket bounds" },
			top: num("Top values for string fields (default 20)"),
			group_by: str("Split into one histogram per value of this field"),
			group_top: num("Max groups (default 10)"),
			exact: bool("Force exact computation over retained events")
		}), ["field"]),
		handler: (engine, args) => {
			return engine.queries.histogram(args);
		}
	},
	{
		name: "timeseries",
		description: "Date histogram: count (or agg of a field) per interval, optionally split_by a field into top-N series + 'other'.",
		inputSchema: schema(Object.assign({}, FILTER_PROPS, {
			interval: str("e.g. '10s', '1m', '1h' (default: auto, ~60 buckets)"),
			agg: { type: "string", enum: ["count", "sum", "avg", "min", "max", "p50", "p90", "p99", "distinct"] },
			field: str("Field for agg"),
			split_by: str("One series per value of this field"),
			top: num("Max series (default 8)")
		})),
		handler: (engine, args) => {
			return engine.queries.timeseries(args);
		}
	},
	{
		name: "heatmap",
		description: "Distribution of a numeric field over time (time buckets × value buckets, log scale when the range is wide). E.g. latency spread per minute.",
		inputSchema: schema(Object.assign({}, FILTER_PROPS, {
			field: str("Numeric field"),
			interval: str("Time bucket"),
			buckets: num("Value buckets (default 20)"),
			scale: { type: "string", enum: ["log", "linear"] }
		}), ["field"]),
		handler: (engine, args) => {
			return engine.queries.heatmap(args);
		}
	},
	{
		name: "field_summary",
		description: "Kibana-style field overview for a result set: every field with type, presence %, and top 5 values (strings) or stats (numbers).",
		inputSchema: schema(Object.assign({}, FILTER_PROPS, {
			sample: num("Max events sampled (default 5000)"),
			top: num("Top values per field (default 5)")
		})),
		handler: (engine, args) => {
			return engine.queries.fieldSummary(args);
		}
	},
	{
		name: "fields",
		description: "Field catalogue per classifier (declared types + dynamically seen fields such as flattened json/kv).",
		inputSchema: schema({ classifier: FILTER_PROPS.classifier }),
		handler: (engine, args) => {
			return engine.queries.fields(args);
		}
	},
	{
		name: "define_alarm",
		description: "Create/replace an alarm; firings are pushed to you as notifications. Kinds/params: every {n} | rate {count, window} | absence {window} | threshold {field, agg (avg|p90|max|...), op (> >= < <=), value, window} | new_value {field} | unclassified {count, window} | source_silent {source (name, glob, or 'name:label'), window} | sequence {first, then, within, key?}. Filter with classifier + q/where. backfill=true dry-runs it over stored events first and reports what would have fired (new_value: learns existing values).",
		mutates: true,
		inputSchema: schema({
			name: str("Alarm name"),
			kind: { type: "string", enum: ["every", "rate", "absence", "threshold", "new_value", "unclassified", "source_silent", "sequence"] },
			classifier: str("Classifier name/glob (not needed for unclassified/source_silent/sequence)"),
			q: FILTER_PROPS.q,
			where: FILTER_PROPS.where,
			params: obj("Kind parameters (see description); windows like '1m', '30s'"),
			cooldown: str("Minimum gap between firings (default 1m; new_value 0)"),
			message: str("Text included in the notification"),
			enabled: bool("Default true"),
			backfill: bool("Dry-run over stored events before enabling"),
			scope: CLASSIFIER_PROPS.scope
		}, ["name", "kind"]),
		handler: (engine, args, ctx) => {
			return engine.defineAlarm(args, ctx);
		}
	},
	{
		name: "remove_alarm",
		description: "Remove an alarm.",
		mutates: true,
		inputSchema: schema({ name: str("Alarm name") }, ["name"]),
		handler: (engine, args, ctx) => {
			return engine.removeAlarm(args.name, ctx);
		}
	},
	{
		name: "list_alarms",
		description: "Alarms with state (ok/firing), fire/suppressed counts and last firing.",
		inputSchema: schema({}),
		handler: (engine) => {
			return engine.listAlarms();
		}
	},
	{
		name: "alarm_history",
		description: "Recent alarm firings, newest first, with a sample event.",
		inputSchema: schema({ alarm: str("Filter by alarm"), limit: num("Default 50") }),
		handler: (engine, args) => {
			return engine.alarmHistory(args);
		}
	},
	{
		name: "add_source",
		description: "Start reading a stream. type=command runs `sh -c` (stdout+stderr), e.g. 'ssh prod-1 journalctl -fu api -o short-iso', 'kubectl logs -f -l app=api --prefix', 'ssh host docker service logs svc -f -t --tail=0 2>&1' (demux the 'svc.1.taskid@node |' prefix per task); restarts with backoff. type=file tails -F a path. tcp/unix listen for lines. labels tag every record ($labels.x). demux splits one stream into many: { regex: '^\\\\[(?<pod>[^\\\\]]+)\\\\] ', label: 'pod', strip: true }. multiline joins stack traces: { start: '^\\\\d{4}-' } or { continue: '^\\\\s' }. Persisted (command sources resume paused next run).",
		mutates: true,
		inputSchema: schema({
			name: str("Source name"),
			type: { type: "string", enum: ["command", "file", "tcp", "unix"] },
			command: str("Shell command (type=command)"),
			path: str("File path (file) or socket path (unix)"),
			host: str("tcp bind host (default 127.0.0.1)"),
			port: num("tcp port"),
			from_start: bool("file: read from the beginning"),
			restart: bool("command: restart on exit (default true)"),
			labels: obj("Static labels added to every record"),
			demux: obj("{ regex, label, strip }"),
			multiline: obj("{ start } or { continue } regex"),
			flush_ms: num("Multiline flush delay (default 250)"),
			max_line: num("Truncate lines longer than this (default 16384)"),
			strip_ansi: bool("Strip ANSI colors (default true)"),
			scope: CLASSIFIER_PROPS.scope
		}, ["name", "type"]),
		handler: (engine, args, ctx) => {
			return engine.addSource(args, ctx);
		}
	},
	{
		name: "remove_source",
		description: "Stop and remove a source.",
		mutates: true,
		inputSchema: schema({ name: str("Source name") }, ["name"]),
		handler: (engine, args, ctx) => {
			return engine.removeSource(args.name, ctx);
		}
	},
	{
		name: "start_source",
		description: "Start a paused/stopped source (command sources saved from a previous run load paused).",
		mutates: true,
		inputSchema: schema({ name: str("Source name") }, ["name"]),
		handler: (engine, args) => {
			return engine.startSource(args.name);
		}
	},
	{
		name: "restart_source",
		description: "Restart a source.",
		mutates: true,
		inputSchema: schema({ name: str("Source name") }, ["name"]),
		handler: (engine, args) => {
			return engine.restartSource(args.name);
		}
	},
	{
		name: "list_sources",
		description: "Sources with state, line/record counts, last record time, restarts, errors, classified %, and per-demux-stream activity.",
		inputSchema: schema({}),
		handler: (engine) => {
			return engine.listSources();
		}
	},
	{
		name: "wait",
		description: "Block until something worth looking at happens, instead of `sleep`: for=any (default; a new unclassified cluster, an alarm, or a source exiting/erroring), records (N records ingested), event (N classified events, optionally of a classifier), new_cluster (N new clusters), alarm (N firings). Returns what happened plus the queue size. Use after add_source to collect a first sample, or to watch without channel notifications.",
		inputSchema: schema({
			"for": { type: "string", enum: ["any", "records", "event", "new_cluster", "alarm"] },
			count: num("How many (default 1)"),
			classifier: str("For for=event: only count this classifier (or its descendants)"),
			timeout_s: num("Give up after this many seconds (default 60, max 600)")
		}),
		handler: (engine, args) => {
			return engine.wait(args);
		}
	},
	{
		name: "ingest",
		description: "Push lines directly (pasted logs, tests). Goes through the same pipeline as live sources.",
		mutates: true,
		inputSchema: schema({
			lines: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Lines (array, or one string split on newlines)" },
			source: str("Source name (default 'ingest')"),
			labels: obj("Labels for a newly created ingest source")
		}, ["lines"]),
		handler: (engine, args) => {
			return engine.ingestLines(args.lines, args.source, args.labels);
		}
	},
	{
		name: "set_redaction",
		description: "Ingest-time redaction, applied before anything is stored or shown. On by default with builtins: bearer, basic_auth, url_credentials, secret_kv, jwt, private_key_block. Add your own regexes (patterns), choose builtins, or disable. `test` previews the effect on a sample line.",
		mutates: true,
		inputSchema: schema({
			enabled: bool("Turn redaction on/off"),
			builtin: { type: "array", items: { type: "string" }, description: "Builtin rules to use" },
			patterns: { type: "array", items: { type: "string" }, description: "Extra regexes; each whole match becomes [REDACTED]" },
			test: str("Sample text to preview")
		}),
		handler: (engine, args, ctx) => {
			return engine.setRedaction(args, ctx);
		}
	},
	{
		name: "set_notifications",
		description: "Mute/unmute notification kinds (unclassified, alarm, source, definitions) and tune the unclassified digest debounce (quiet_ms, max_wait_ms) and growth_factor (re-report a cluster when it grows by this factor).",
		mutates: true,
		inputSchema: schema({
			mute: { type: "array", items: { type: "string" } },
			unmute: { type: "array", items: { type: "string" } },
			quiet_ms: num("Digest fires after this much quiet"),
			max_wait_ms: num("…but at most this long after the first change"),
			growth_factor: num("Default 10")
		}),
		handler: (engine, args, ctx) => {
			return engine.setNotifications(args, ctx);
		}
	},
	{
		name: "define_visualization",
		description: "Save a chart for the web UI. type: bar (terms of field, optional split_by) | histogram (numeric field) | line | area (timeseries: agg/field/split_by/interval) | heatmap (numeric field over time) | metric (single agg) | table (group_by fields + agg). Uses classifier/q/where/since like queries.",
		mutates: true,
		inputSchema: schema({
			name: str("Name"),
			type: { type: "string", enum: ["bar", "histogram", "line", "area", "heatmap", "metric", "table"] },
			title: str("Display title"),
			classifier: FILTER_PROPS.classifier,
			q: FILTER_PROPS.q,
			where: FILTER_PROPS.where,
			since: FILTER_PROPS.since,
			field: str("Field"),
			agg: str("Aggregate"),
			split_by: str("Split field"),
			group_by: { type: "array", items: { type: "string" } },
			interval: str("Time bucket"),
			empty: { type: "string", enum: ["connect", "zero", "gap"], description: "line/area: buckets with no data for a statistic (avg/p90/max…): connect with a dashed line (default), draw as 0, or leave a gap. Counts/sums are always 0." },
			buckets: num("Buckets"),
			top: num("Top N"),
			scope: CLASSIFIER_PROPS.scope
		}, ["name", "type"]),
		handler: (engine, args, ctx) => {
			return engine.defineView("visualization", args, ctx);
		}
	},
	{
		name: "define_dashboard",
		description: "Save a dashboard (grid of saved visualizations sharing a query/time range) for the human in the web UI.",
		mutates: true,
		inputSchema: schema({
			name: str("Name"),
			title: str("Display title"),
			description: str("Description"),
			panels: { type: "array", items: { type: "object", properties: { visualization: { type: "string" }, w: { type: "number" }, h: { type: "number" } }, required: ["visualization"] }, description: "Panels; w = 1-12 grid columns (default 6)" },
			q: FILTER_PROPS.q,
			since: FILTER_PROPS.since,
			scope: CLASSIFIER_PROPS.scope
		}, ["name", "panels"]),
		handler: (engine, args, ctx) => {
			return engine.defineView("dashboard", args, ctx);
		}
	},
	{
		name: "remove_view",
		description: "Remove a saved visualization or dashboard.",
		mutates: true,
		inputSchema: schema({ kind: { type: "string", enum: ["visualization", "dashboard"] }, name: str("Name") }, ["kind", "name"]),
		handler: (engine, args, ctx) => {
			return engine.removeView(args.kind, args.name, ctx);
		}
	},
	{
		name: "list_views",
		description: "Saved visualizations and dashboards.",
		inputSchema: schema({}),
		handler: (engine) => {
			return { visualizations: engine.listViews("visualization"), dashboards: engine.listViews("dashboard") };
		}
	},
	{
		name: "export_definitions",
		description: "Export parsers/classifiers/alarms/views as a JSON pack (to share between projects).",
		inputSchema: schema({ scope: { type: "string", enum: ["project", "global"] }, include_sources: bool("Include sources") }),
		handler: (engine, args) => {
			return engine.definitionsExport(args);
		}
	},
	{
		name: "import_definitions",
		description: "Import a pack produced by export_definitions (sources are ignored).",
		mutates: true,
		inputSchema: schema({ pack: obj("The pack"), scope: CLASSIFIER_PROPS.scope }, ["pack"]),
		handler: (engine, args, ctx) => {
			return engine.definitionsImport(Object.assign({}, args.pack, { scope: args.scope }), ctx);
		}
	},
	{
		name: "web_ui",
		description: "Start (if needed) the web UI for the human, a Kibana-like explorer of classifiers, events, histograms and dashboards, and return its URL.",
		inputSchema: schema({ port: num("Port (default 7070, 0 = any free port)") }),
		handler: (_engine, args, ctx) => {
			if (!ctx.startWeb) {
				throw new Error("Web UI is not available in this context");
			}

			return ctx.startWeb(args.port).then((url) => {
				return { url };
			});
		}
	}
];

const byName = () => {
	const map = {};
	TOOLS.forEach((tool) => {
		map[tool.name] = tool;
	});

	return map;
};

/**
 * Run a tool by name. Always returns a Promise.
 * @param {object} engine
 * @param {string} name
 * @param {object} args
 * @param {{ origin: string, readOnly?: boolean, startWeb?: function }} ctx
 */
const call = (engine, name, args, ctx) => {
	const tool = byName()[name];

	if (!tool) {
		return Promise.reject(new Error("Unknown tool " + name));
	}

	if (tool.mutates && ctx.readOnly) {
		return Promise.reject(new Error("Read-only mode: " + name + " is disabled"));
	}

	return Promise.resolve().then(() => {
		return tool.handler(engine, args || {}, ctx);
	});
};

module.exports = {
	TOOLS,
	call,
	byName
};
