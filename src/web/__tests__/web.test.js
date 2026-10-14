const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const config = require("../../config");
const createEngine = require("../../engine").createEngine;
const createWeb = require("../index").createWeb;

const start = (extra) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-web-"));
	const settings = Object.assign({}, config.DEFAULTS, { STATE_FILE: path.join(dir, "state.json"), NO_GLOBAL: true }, extra || {});
	const engine = createEngine({ settings, log: () => {} });
	engine.start({ watch: false });
	const web = createWeb(engine, { settings, log: () => {} });

	return web.listen("127.0.0.1", 0).then((url) => {
		return { engine, web, base: url.replace(/\/(#.*)?$/, "") };
	});
};

const rawGet = (base, pathname) => {
	return new Promise((resolve, reject) => {
		const req = http.get(base + pathname, (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("error", reject);
	});
};

const post = (base, tool, body, headers) => {
	return fetch(base + "/api/" + tool, {
		method: "POST",
		headers: Object.assign({ "content-type": "application/json" }, headers || {}),
		body: JSON.stringify(body || {})
	}).then((res) => {
		return res.json().then((json) => {
			return { status: res.status, json };
		});
	});
};

describe("web server", () => {
	test("REST mirrors tools; vendor files are served; traversal is blocked", () => {
		return start().then((ctx) => {
			return post(ctx.base, "ingest", { lines: ["hello 1", "hello 2"] })
				.then((res) => {
					expect(res.json).toEqual({ ingested: 2, source: "ingest" });
					return post(ctx.base, "get_unclassified", {});
				})
				.then((res) => {
					expect(res.json.queue.records).toBe(2);
					return post(ctx.base, "define_classifier", { name: "x", template: "{x:nope}" });
				})
				.then((res) => {
					expect(res.status).toBe(400);
					expect(res.json.error).toMatch(/Unknown type/);
					return fetch(ctx.base + "/vendor/qrp/qrp.js");
				})
				.then((res) => {
					expect(res.status).toBe(200);
					expect(res.headers.get("content-type")).toMatch(/javascript/);
					return fetch(ctx.base + "/vendor/qrp-shadcdn/qrp-shadcdn.js");
				})
				.then((res) => {
					expect(res.status).toBe(200);
					return rawGet(ctx.base, "/app/..%2f..%2fpackage.json");
				})
				.then((status) => {
					expect([403, 404]).toContain(status);
					ctx.web.close();
					ctx.engine.stop();
				});
		});
	});

	test("token auth and read-only mode", () => {
		return start({ HTTP_TOKEN: "s3cret", READ_ONLY: true }).then((ctx) => {
			return post(ctx.base, "stats", {})
				.then((res) => {
					expect(res.status).toBe(401);
					return post(ctx.base, "stats", {}, { authorization: "Bearer s3cret" });
				})
				.then((res) => {
					expect(res.status).toBe(200);
					return post(ctx.base, "ingest", { lines: ["x"] }, { authorization: "Bearer s3cret" });
				})
				.then((res) => {
					expect(res.status).toBe(400);
					expect(res.json.error).toMatch(/Read-only/);
					ctx.web.close();
					ctx.engine.stop();
				});
		});
	});

	test("refuses non-loopback bind without a token", () => {
		const settings = Object.assign({}, config.DEFAULTS, { NO_GLOBAL: true });
		const engine = createEngine({ settings, log: () => {} });
		const web = createWeb(engine, { settings, log: () => {} });
		return expect(web.listen("0.0.0.0", 0)).rejects.toThrow(/without --token/);
	});

	test("SSE stream sends hello and live tail", () => {
		return start().then((ctx) => {
			return new Promise((resolve, reject) => {
				const req = http.get(ctx.base + "/api/events/stream?tail=1", (res) => {
					let buffer = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						buffer += chunk;

						if (buffer.indexOf("event: hello") !== -1 && buffer.indexOf("event: tail") === -1) {
							ctx.engine.ingestLines(["streamed line"], "live");
						}

						if (buffer.indexOf("event: tail") !== -1) {
							expect(buffer).toMatch(/streamed line/);
							req.destroy();
							ctx.web.close();
							ctx.engine.stop();
							resolve();
						}
					});
				});
				req.on("error", reject);
			});
		});
	});
});
