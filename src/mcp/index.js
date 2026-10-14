const Server = require("@modelcontextprotocol/sdk/server/index.js").Server;
const types = require("@modelcontextprotocol/sdk/types.js");

const tools = require("./tools");
const debounce = require("../utils/debounce").debounce;
const pkg = require("../../package.json");

const SERVER_NAME = "diversity-classifier";
const RESOURCE_DEBOUNCE_MS = 2000;
const PRE_INIT_QUEUE = 50;

const INSTRUCTIONS = `diversity-classifier watches log streams for you so you never read raw logs line by line.

Loop:
1. add_source (e.g. command "ssh host journalctl -fu svc -o short-iso"), or ingest pasted lines. Saved command sources from a previous run load paused: list_sources, then start_source. To collect a first sample, call wait {for:"records", count:200, timeout_s:60} — never shell sleep.
2. get_unclassified → biggest clusters first. Each has a suggested_template.
3. If lines share a head (timestamp, level, logger), define_parser {name:"head", template:"^{ts:timestamp} {level:level} ..."} and an envelope classifier {template:"{...head} {msg:rest}", envelope:true}; then classify bodies as children (parent: envelope).
4. test_classifier with a refined template (rename fields, fix types: duration→ms, bytes, int...). Read near_misses.failed_at to fix templates. Then define_classifier; it absorbs matching queued records immediately. Use store:"count" or ignore_cluster for pure noise.
5. Ask questions with search_events / histogram / timeseries / field_summary (q like 'status >= 500 and took > 2s').
6. define_alarm for what matters (rate, threshold, new_value, absence, sequence, source_silent).
7. Then stop polling: with channels enabled, digests of new unclassified clusters and alarm firings are pushed to you. Without channels, call wait {for:"any"} — it returns as soon as a new cluster, alarm or source failure happens.
Everything you define persists for the next run. web_ui gives the human a Kibana-like explorer; define_dashboard builds them a view.

Where you can get hurt (tread carefully):
- Absence is not health. No events can mean "nothing happened" or "the thing that would log is stuck". Before calling a quiet period stabilisation, check list_sources and the related classifiers' last_seen, and look for the events that should accompany the silence.
- Empty results may be your filter. Re-run without q/where/classifier (or widen the time range) before claiming a gap.
- Only retained events are queryable (see retained_since); older data survives only as counts/aggregates.
- A restart/reconnect drops events, the queue and metrics (definitions and new_value history persist). Write down evidence before reconnecting.
- Catch-all classifiers hide structure and swallow new message shapes; prefer one typed template per message kind.
- The first matching top-level classifier wins: once an envelope matches a line, a new top-level classifier for it never runs. Attach it with parent: <envelope> (define_classifier warns when this happens).
- store:"count" classifiers keep no events; retro-absorbed records never fire alarms.
- Multi-line records are only joined if you configure multiline (envelope multiline for prefixed streams); fragments otherwise show up as separate clusters.
- Zone-less timestamps are read as local time unless the type says otherwise ({ts:timestamp(utc)}).
- Redaction is pattern-based, not a guarantee.`;

/**
 * Create the MCP server bound to an engine.
 * @param {object} engine
 * @param {{ startWeb?: function(number=): Promise<string>, log?: function(string): void }} options
 */
const createMcpServer = (engine, options) => {
	const opts = options || {};
	const server = new Server(
		{ name: SERVER_NAME, version: pkg.version },
		{
			capabilities: {
				tools: {},
				resources: { subscribe: true },
				logging: {},
				experimental: { "claude/channel": {} }
			},
			instructions: INSTRUCTIONS
		}
	);
	const state = { ready: false, queue: [], subscriptions: new Set() };
	const ctx = { origin: "mcp", startWeb: opts.startWeb };

	server.setRequestHandler(types.ListToolsRequestSchema, () => {
		return {
			tools: tools.TOOLS.map((tool) => {
				return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
			})
		};
	});

	server.setRequestHandler(types.CallToolRequestSchema, (request) => {
		return tools.call(engine, request.params.name, request.params.arguments, ctx)
			.then((result) => {
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			})
			.catch((error) => {
				return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
			});
	});

	const RESOURCES = {
		"classifier://stats": {
			name: "stats",
			description: "Overview (same as the stats tool)",
			read: () => {
				return engine.stats();
			}
		},
		"classifier://unclassified": {
			name: "unclassified",
			description: "Unclassified clusters (top 50 by count)",
			read: () => {
				return engine.getUnclassified({ limit: 50 });
			}
		},
		"classifier://alarms": {
			name: "alarms",
			description: "Alarm states and recent firings",
			read: () => {
				return { alarms: engine.listAlarms().alarms, recent: engine.alarmHistory({ limit: 20 }).firings };
			}
		}
	};

	server.setRequestHandler(types.ListResourcesRequestSchema, () => {
		return {
			resources: Object.keys(RESOURCES).map((uri) => {
				return { uri, name: RESOURCES[uri].name, description: RESOURCES[uri].description, mimeType: "application/json" };
			})
		};
	});

	server.setRequestHandler(types.ReadResourceRequestSchema, (request) => {
		const resource = RESOURCES[request.params.uri];

		if (!resource) {
			throw new Error("Unknown resource " + request.params.uri);
		}

		return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(resource.read()) }] };
	});

	server.setRequestHandler(types.SubscribeRequestSchema, (request) => {
		state.subscriptions.add(request.params.uri);
		return {};
	});

	server.setRequestHandler(types.UnsubscribeRequestSchema, (request) => {
		state.subscriptions.delete(request.params.uri);
		return {};
	});

	const resourceChanged = {};
	Object.keys(RESOURCES).forEach((uri) => {
		resourceChanged[uri] = debounce(() => {
			if (state.ready && state.subscriptions.has(uri)) {
				server.sendResourceUpdated({ uri }).catch(() => {});
			}
		}, { quietMs: RESOURCE_DEBOUNCE_MS, maxWaitMs: RESOURCE_DEBOUNCE_MS * 5 });
	});

	engine.emitter.on("unclassified", () => {
		resourceChanged["classifier://unclassified"]();
		resourceChanged["classifier://stats"]();
	});
	engine.emitter.on("event", () => {
		resourceChanged["classifier://stats"]();
	});
	engine.emitter.on("alarm", () => {
		resourceChanged["classifier://alarms"]();
	});
	engine.emitter.on("definitions", () => {
		resourceChanged["classifier://stats"]();
		resourceChanged["classifier://unclassified"]();
	});

	const send = (note) => {
		const meta = Object.assign({ ts: note.t }, note.meta || {});
		Object.keys(meta).forEach((key) => {
			meta[key] = meta[key] === undefined || meta[key] === null ? "" : String(meta[key]);
		});

		server.notification({
			method: "notifications/claude/channel",
			params: { content: note.content, meta }
		}).catch(() => {});

		server.sendLoggingMessage({
			level: note.level === "warning" ? "warning" : "info",
			logger: SERVER_NAME,
			data: note.content
		}).catch(() => {});
	};

	engine.notifier.addSink((note) => {
		if (!state.ready) {
			state.queue.push(note);

			if (state.queue.length > PRE_INIT_QUEUE) {
				state.queue.shift();
			}

			return;
		}

		send(note);
	});

	server.oninitialized = () => {
		state.ready = true;
		const queued = state.queue;
		state.queue = [];
		queued.forEach(send);
	};

	return server;
};

module.exports = {
	createMcpServer,
	INSTRUCTIONS,
	SERVER_NAME
};
