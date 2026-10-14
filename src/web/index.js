const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const tools = require("../mcp/tools");
const pkg = require("../../package.json");

const PUBLIC_DIR = path.join(__dirname, "public");
const QRP_DIST = path.dirname(require.resolve("@nemanjan00/qrp"));
const SHADCDN_DIST = path.join(path.dirname(require.resolve("@nemanjan00/qrp-shadcdn/package.json")), "dist");
const MAX_BODY = 5 * 1024 * 1024;
const STATS_INTERVAL_MS = 2000;
const TAIL_MAX_PER_SECOND = 50;
const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon"
};

/*
 * Web UI server (SPEC.md §13): static UI + vendored qrp/qrp-shadcdn, REST
 * mirror of the MCP tools, and an SSE stream for live updates.
 */

const safeJoin = (root, relative) => {
	const target = path.normalize(path.join(root, relative));

	if (target !== root && target.indexOf(root + path.sep) !== 0) {
		return null;
	}

	return target;
};

const sendJson = (res, status, body) => {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
	res.end(text);
};

const sendFile = (res, file) => {
	fs.stat(file, (error, stat) => {
		if (error || !stat.isFile()) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}

		res.writeHead(200, {
			"content-type": MIME[path.extname(file)] || "application/octet-stream",
			"content-length": stat.size,
			"cache-control": "no-cache"
		});
		fs.createReadStream(file).pipe(res);
	});
};

const readBody = (req) => {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];

		req.on("data", (chunk) => {
			size += chunk.length;

			if (size > MAX_BODY) {
				reject(new Error("Request body too large"));
				req.destroy();
				return;
			}

			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");

			if (!text) {
				resolve({});
				return;
			}

			try {
				resolve(JSON.parse(text));
			} catch (e) {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
};

const tokenMatches = (expected, given) => {
	if (!given) {
		return false;
	}

	const a = Buffer.from(String(expected));
	const b = Buffer.from(String(given));
	return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * @param {object} engine
 * @param {{ settings: object, log: function(string): void }} options
 */
const createWeb = (engine, options) => {
	const settings = options.settings;
	const log = options.log;
	const state = { server: null, url: null, clients: new Set(), statsTimer: null };
	const ctx = { origin: "ui", readOnly: !!settings.READ_ONLY };

	const authorised = (req, url) => {
		if (!settings.HTTP_TOKEN) {
			return true;
		}

		const header = req.headers.authorization || "";
		const bearer = /^Bearer\s+(.+)$/i.exec(header);
		return tokenMatches(settings.HTTP_TOKEN, bearer ? bearer[1] : url.searchParams.get("token"));
	};

	const broadcast = (type, data) => {
		const payload = "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";
		state.clients.forEach((client) => {
			if (client.wants(type, data)) {
				client.res.write(payload);
			}
		});
	};

	const tailRecord = (kind, payload) => {
		state.clients.forEach((client) => {
			if (!client.tail) {
				return;
			}

			const second = Math.floor(Date.now() / 1000);

			if (client.tailSecond !== second) {
				client.tailSecond = second;
				client.tailCount = 0;
			}

			if (client.tailCount >= client.tailRate) {
				client.tailDropped++;
				return;
			}

			client.tailCount++;
			client.res.write("event: tail\ndata: " + JSON.stringify(Object.assign({ kind }, payload)) + "\n\n");
		});
	};

	engine.emitter.on("event", (event) => {
		tailRecord("event", {
			id: event.id,
			t: event.t,
			classifier: event.classifier,
			source: event.source,
			labels: event.labels,
			fields: event.fields,
			raw: event.raw
		});
	});
	engine.emitter.on("unclassified", (info) => {
		tailRecord("unclassified", { t: info.record.t, source: info.record.source, labels: info.record.labels, cluster: info.cluster, raw: info.record.raw });

		if (info.isNew) {
			broadcast("cluster", { id: info.cluster });
		}
	});
	engine.emitter.on("alarm", (firing) => {
		broadcast("alarm", firing);
	});
	engine.emitter.on("source", (change) => {
		broadcast("source", change);
	});
	engine.emitter.on("definitions", (change) => {
		broadcast("definitions", change);
	});
	engine.emitter.on("queue", (change) => {
		broadcast("queue", change);
	});
	engine.notifier.addSink((note) => {
		broadcast("note", note);
	});

	const openStream = (req, res, url) => {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no"
		});
		res.write("retry: 2000\n\n");

		const client = {
			res,
			tail: url.searchParams.get("tail") === "1",
			tailRate: Math.min(TAIL_MAX_PER_SECOND, parseInt(url.searchParams.get("rate") || "20", 10) || 20),
			tailSecond: 0,
			tailCount: 0,
			tailDropped: 0,
			wants: () => {
				return true;
			}
		};

		state.clients.add(client);
		res.write("event: hello\ndata: " + JSON.stringify({ version: pkg.version, read_only: ctx.readOnly }) + "\n\n");
		req.on("close", () => {
			state.clients.delete(client);
		});
	};

	const handleApi = (req, res, url) => {
		if (!authorised(req, url)) {
			sendJson(res, 401, { error: "unauthorised" });
			return;
		}

		const route = url.pathname.slice("/api/".length);

		if (route === "events/stream" && req.method === "GET") {
			openStream(req, res, url);
			return;
		}

		if (route === "meta" && req.method === "GET") {
			sendJson(res, 200, {
				name: pkg.name,
				version: pkg.version,
				read_only: ctx.readOnly,
				tools: tools.TOOLS.map((tool) => {
					return { name: tool.name, mutates: !!tool.mutates };
				})
			});
			return;
		}

		if (req.method !== "POST") {
			sendJson(res, 405, { error: "use POST /api/<tool>" });
			return;
		}

		if (route === "web_ui") {
			sendJson(res, 200, { url: state.url });
			return;
		}

		readBody(req)
			.then((body) => {
				return tools.call(engine, route, body, ctx);
			})
			.then((result) => {
				sendJson(res, 200, result);
			})
			.catch((error) => {
				sendJson(res, 400, { error: error.message });
			});
	};

	const handle = (req, res) => {
		const url = new URL(req.url, "http://localhost");
		const pathname = decodeURIComponent(url.pathname);

		if (pathname.indexOf("/api/") === 0) {
			handleApi(req, res, url);
			return;
		}

		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}

		if (pathname === "/" || pathname === "/index.html") {
			sendFile(res, path.join(PUBLIC_DIR, "index.html"));
			return;
		}

		const isAsset = pathname.indexOf("/vendor/") === 0 || pathname.indexOf("/app/") === 0;

		if (!isAsset) {
			// HTML5 history routes (/discover, /classifiers/<name>, ...) all serve the app shell.
			sendFile(res, path.join(PUBLIC_DIR, "index.html"));
			return;
		}

		const mounts = [
			["/vendor/qrp/", QRP_DIST],
			["/vendor/qrp-shadcdn/", SHADCDN_DIST],
			["/app/", PUBLIC_DIR]
		];
		const mount = mounts.find((entry) => {
			return pathname.indexOf(entry[0]) === 0;
		});

		if (!mount) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}

		const file = safeJoin(mount[1], pathname.slice(mount[0].length));

		if (!file) {
			res.writeHead(403);
			res.end();
			return;
		}

		sendFile(res, file);
	};

	const web = {
		/** Start listening. Resolves to the URL. */
		listen: (host, port) => {
			if (state.server) {
				return Promise.resolve(state.url);
			}

			if (LOOPBACK.indexOf(host) === -1 && !settings.HTTP_TOKEN) {
				return Promise.reject(new Error("Refusing to bind the web UI to " + host + " without --token"));
			}

			return new Promise((resolve, reject) => {
				const server = http.createServer(handle);
				server.on("error", (error) => {
					state.server = null;
					reject(error);
				});
				server.listen(port, host, () => {
					state.server = server;
					const address = server.address();
					const shownHost = host.indexOf(":") !== -1 ? "[" + host + "]" : host;
					state.url = "http://" + shownHost + ":" + address.port + "/" + (settings.HTTP_TOKEN ? "#token=" + encodeURIComponent(settings.HTTP_TOKEN) : "");
					state.statsTimer = setInterval(() => {
						if (state.clients.size) {
							broadcast("stats", engine.stats());
						}
					}, STATS_INTERVAL_MS);
					state.statsTimer.unref();
					log("web UI listening on " + state.url.replace(/#token=.*/, ""));
					resolve(state.url);
				});
			});
		},

		url: () => {
			return state.url;
		},

		close: () => {
			clearInterval(state.statsTimer);
			state.clients.forEach((client) => {
				client.res.end();
			});
			state.clients.clear();

			if (state.server) {
				state.server.close();
				state.server = null;
				state.url = null;
			}
		}
	};

	return web;
};

module.exports = {
	createWeb
};
