const fs = require("fs");
const os = require("os");
const path = require("path");
const Client = require("@modelcontextprotocol/sdk/client/index.js").Client;
const InMemoryTransport = require("@modelcontextprotocol/sdk/inMemory.js").InMemoryTransport;
const z = require("zod");

const config = require("../../config");
const createEngine = require("../../engine").createEngine;
const createMcpServer = require("../index").createMcpServer;
const TOOLS = require("../tools").TOOLS;

const connect = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-mcp-"));
	const settings = Object.assign({}, config.DEFAULTS, { STATE_FILE: path.join(dir, "state.json"), NO_GLOBAL: true, DIGEST_QUIET_MS: 10, DIGEST_MAX_WAIT_MS: 50 });
	const engine = createEngine({ settings, log: () => {} });
	engine.start({ watch: false });
	const server = createMcpServer(engine, {});
	const client = new Client({ name: "test", version: "1" });
	const channel = [];
	client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }), (note) => {
		channel.push(note.params);
	});
	const pair = InMemoryTransport.createLinkedPair();

	return Promise.all([server.connect(pair[1]), client.connect(pair[0])]).then(() => {
		return { engine, client, channel };
	});
};

const call = (client, name, args) => {
	return client.callTool({ name, arguments: args || {} }).then((result) => {
		const text = result.content[0].text;
		return { error: result.isError ? text : null, data: result.isError ? null : JSON.parse(text) };
	});
};

const wait = (ms) => {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
};

describe("MCP server", () => {
	test("every tool has a valid schema and description", () => {
		const names = new Set();
		TOOLS.forEach((tool) => {
			expect(names.has(tool.name)).toBe(false);
			names.add(tool.name);
			expect(tool.description.length).toBeGreaterThan(10);
			expect(tool.inputSchema.type).toBe("object");
			(tool.inputSchema.required || []).forEach((key) => {
				expect(tool.inputSchema.properties[key]).toBeDefined();
			});
		});
	});

	test("full loop over MCP: ingest, cluster digest via channel, classify, query, alarm", () => {
		return connect().then((ctx) => {
			const client = ctx.client;
			expect(client.getInstructions()).toMatch(/get_unclassified/);
			expect(client.getServerCapabilities().experimental["claude/channel"]).toEqual({});

			return client.listTools()
				.then((list) => {
					expect(list.tools.length).toBe(TOOLS.length);
					return call(client, "ingest", { lines: ["user 1 logged in from 10.0.0.1", "user 2 logged in from 10.0.0.2", "disk /dev/sda1 is 91% full"], source: "auth" });
				})
				.then(() => {
					return wait(80);
				})
				.then(() => {
					expect(ctx.channel.length).toBe(1);
					expect(ctx.channel[0].meta.kind).toBe("unclassified");
					expect(ctx.channel[0].content).toMatch(/2 new/);
					return call(client, "get_unclassified", {});
				})
				.then((res) => {
					expect(res.data.queue.clusters).toBe(2);
					const login = res.data.clusters.find((cluster) => {
						return cluster.count === 2;
					});
					return call(client, "define_classifier", { name: "login", template: "user {user:int} logged in from {ip:ip}" }).then((defined) => {
						expect(defined.data.retro.absorbed).toBe(2);
						expect(defined.data.retro.from_clusters[0].id).toBe(login.id);
					});
				})
				.then(() => {
					return call(client, "define_alarm", { name: "nv", kind: "new_value", classifier: "login", params: { field: "ip" }, backfill: true });
				})
				.then((res) => {
					expect(res.data.backfill.would_fire).toBe(2);
					return call(client, "ingest", { lines: ["user 3 logged in from 10.0.0.1", "user 4 logged in from 10.9.9.9"], source: "auth" });
				})
				.then(() => {
					const alarms = ctx.channel.filter((note) => {
						return note.meta.kind === "alarm";
					});
					expect(alarms.length).toBe(1);
					expect(alarms[0].content).toMatch(/10\.9\.9\.9/);
					return call(client, "search_events", { q: "ip:10.0.0.1", fields: ["user"] });
				})
				.then((res) => {
					expect(res.data.total).toBe(2);
					return call(client, "define_classifier", { name: "bad", template: "{x:nope}" });
				})
				.then((res) => {
					expect(res.error).toMatch(/Unknown type 'nope'/);
					return client.readResource({ uri: "classifier://stats" });
				})
				.then((resource) => {
					const stats = JSON.parse(resource.contents[0].text);
					expect(stats.records.total).toBe(5);
					ctx.engine.stop();
				});
		});
	});
});
