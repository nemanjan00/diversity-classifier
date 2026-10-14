#!/usr/bin/env node

const StdioServerTransport = require("@modelcontextprotocol/sdk/server/stdio.js").StdioServerTransport;

const config = require("../src/config");
const createEngine = require("../src/engine").createEngine;
const createMcpServer = require("../src/mcp").createMcpServer;
const createWeb = require("../src/web").createWeb;

const DEFAULT_WEB_PORT = 7070;

const log = (message) => {
	process.stderr.write("[diversity-classifier] " + message + "\n");
};

const main = () => {
	let resolved = null;

	try {
		resolved = config.resolve(process.argv.slice(2), process.env);
	} catch (e) {
		process.stderr.write(e.message + "\n\n" + config.USAGE);
		process.exit(2);
	}

	if (resolved.help) {
		process.stdout.write(config.USAGE);
		process.exit(0);
	}

	const settings = resolved.settings;
	const engine = createEngine({ settings, log });
	const web = createWeb(engine, { settings, log });

	/** Start the web UI on demand (web_ui tool); resolves to its URL. */
	const startWeb = (port) => {
		if (web.url()) {
			return Promise.resolve(web.url());
		}

		const fromFlag = config.parseHttp(settings.HTTP);
		const target = fromFlag || { host: "127.0.0.1", port: port !== undefined ? port : DEFAULT_WEB_PORT };

		return web.listen(target.host, target.port).catch((error) => {
			if (error.code === "EADDRINUSE" && port === undefined) {
				return web.listen(target.host, 0);
			}

			throw error;
		});
	};

	engine.start({ sources: resolved.sources });

	const server = createMcpServer(engine, { startWeb, log });
	const transport = new StdioServerTransport();

	let stopping = false;
	const shutdown = () => {
		if (stopping) {
			return;
		}

		stopping = true;
		engine.stop();
		web.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.stdin.on("end", shutdown);
	process.stdin.on("close", shutdown);

	return server.connect(transport)
		.then(() => {
			if (settings.HTTP) {
				return startWeb().then((url) => {
					log("web UI at " + url);
				});
			}

			return null;
		});
};

main().catch((error) => {
	log("fatal: " + (error.stack || error.message));
	process.exit(1);
});
