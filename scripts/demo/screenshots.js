#!/usr/bin/env node

/*
 * Regenerate the README screenshots: start the server with the web UI, seed
 * it like an agent would, stream synthetic shop logs (with 40 minutes of
 * backfilled history), then capture pages with headless Chrome over the
 * DevTools protocol. No extra dependencies (Node >= 22 for global WebSocket).
 *
 * Usage: node scripts/demo/screenshots.js   (CHROME=/path/to/chrome to override)
 */

/* global WebSocket */

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const seed = require("./seed");

const ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "screenshots");
const PORT = 7079;
const DEBUG_PORT = 9339;
const BASE = "http://127.0.0.1:" + PORT;
const VIEWPORT = { width: 1440, height: 900 };
const CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
const MIN_RECORDS = 30000;

const SHOTS = [
	{ file: "discover.png", hash: "/discover?range=1h&stack=classifier", wait: 3500 },
	{ file: "classifier.png", hash: "/classifiers/shop.http?range=1h", wait: 4500 },
	{ file: "dashboard.png", hash: "/dashboards/shop-overview?range=1h", wait: 4500 },
	{ file: "unclassified.png", hash: "/unclassified", wait: 2500 },
	{ file: "dashboard-dark.png", hash: "/dashboards/shop-overview?range=1h", wait: 4500, dark: true }
];

const sleep = (ms) => {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
};

const log = (message) => {
	process.stdout.write(message + "\n");
};

const findChrome = () => {
	if (process.env.CHROME) {
		return process.env.CHROME;
	}

	const found = CHROME_CANDIDATES.find((name) => {
		return childProcess.spawnSync("sh", ["-c", "command -v " + name], { stdio: "ignore" }).status === 0;
	});

	if (!found) {
		throw new Error("No Chrome/Chromium found; set CHROME=/path/to/chrome");
	}

	return found;
};

/** Retry `fn` until it resolves (or the attempts run out). */
const poll = (fn, attempts, delayMs) => {
	return fn().catch((error) => {
		if (attempts <= 1) {
			throw error;
		}

		return sleep(delayMs).then(() => {
			return poll(fn, attempts - 1, delayMs);
		});
	});
};

const api = (tool, body) => {
	return fetch(BASE + "/api/" + tool, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body || {})
	}).then((res) => {
		return res.json();
	});
};

const startServer = (stateDir) => {
	const server = childProcess.spawn(process.execPath, [
		path.join(ROOT, "bin", "mcp.js"),
		"--http", String(PORT),
		"--state", path.join(stateDir, "state.json"),
		"--no-global"
	], {
		stdio: ["pipe", "ignore", "inherit"],
		env: Object.assign({}, process.env, { DC_EVENTS_PER_CLASSIFIER: "150000", DC_EVENTS_TOTAL: "300000" })
	});

	return poll(() => {
		return fetch(BASE + "/api/meta").then((res) => {
			if (!res.ok) {
				throw new Error("not ready");
			}
		});
	}, 50, 200).then(() => {
		return server;
	});
};

const waitForRecords = () => {
	return poll(() => {
		return api("stats").then((stats) => {
			log("  records: " + stats.records.total);

			if (stats.records.total < MIN_RECORDS) {
				throw new Error("not enough records yet");
			}
		});
	}, 60, 1000);
};

/** Minimal Chrome DevTools Protocol client over the browser's page target. */
const connectChrome = (chromePath, profileDir) => {
	const chrome = childProcess.spawn(chromePath, [
		"--headless=new",
		"--remote-debugging-port=" + DEBUG_PORT,
		"--no-first-run",
		"--no-default-browser-check",
		"--hide-scrollbars",
		"--user-data-dir=" + profileDir,
		"--window-size=" + VIEWPORT.width + "," + VIEWPORT.height,
		"about:blank"
	], { stdio: "ignore" });

	return poll(() => {
		return fetch("http://127.0.0.1:" + DEBUG_PORT + "/json").then((res) => {
			return res.json();
		});
	}, 50, 200).then((targets) => {
		const page = targets.find((target) => {
			return target.type === "page";
		});
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		const pending = new Map();
		const errors = [];
		let nextId = 1;

		ws.addEventListener("message", (message) => {
			const msg = JSON.parse(message.data);

			if (msg.id && pending.has(msg.id)) {
				pending.get(msg.id)(msg.result || {});
				pending.delete(msg.id);
				return;
			}

			if (msg.method === "Runtime.exceptionThrown") {
				errors.push(msg.params.exceptionDetails.text);
			}
		});

		const send = (method, params) => {
			return new Promise((resolve) => {
				const id = nextId++;
				pending.set(id, resolve);
				ws.send(JSON.stringify({ id, method, params: params || {} }));
			});
		};

		return new Promise((resolve) => {
			ws.addEventListener("open", resolve);
		}).then(() => {
			return send("Runtime.enable");
		}).then(() => {
			return send("Page.enable");
		}).then(() => {
			return send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
		}).then(() => {
			return {
				send,
				errors,
				close: () => {
					ws.close();
					chrome.kill();
				}
			};
		});
	});
};

const capture = (browser, shot) => {
	return browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: shot.dark ? "dark" : "light" }] })
		.then(() => {
			return browser.send("Page.navigate", { url: "about:blank" });
		})
		.then(() => {
			return browser.send("Page.navigate", { url: BASE + shot.hash });
		})
		.then(() => {
			return sleep(shot.wait);
		})
		.then(() => {
			return browser.send("Page.captureScreenshot", { format: "png" });
		})
		.then((result) => {
			fs.writeFileSync(path.join(OUT_DIR, shot.file), Buffer.from(result.data, "base64"));
			log("  wrote docs/screenshots/" + shot.file);
		});
};

const main = () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dc-shots-"));
	const chromePath = findChrome();
	const state = { server: null, browser: null };

	fs.mkdirSync(OUT_DIR, { recursive: true });
	log("starting server…");

	return startServer(tmp)
		.then((server) => {
			state.server = server;
			log("seeding definitions…");
			return seed.run(BASE);
		})
		.then(() => {
			log("streaming synthetic logs…");
			return api("add_source", {
				name: "shop",
				type: "command",
				command: "exec " + JSON.stringify(process.execPath) + " " + JSON.stringify(path.join(__dirname, "generate.js")) + " --backfill 45m --rate 15",
				multiline: { start: "^\\d{4}-" },
				labels: { env: "demo" }
			});
		})
		.then(waitForRecords)
		.then(() => {
			return sleep(4000);
		})
		.then(() => {
			log("capturing…");
			return connectChrome(chromePath, path.join(tmp, "chrome"));
		})
		.then((browser) => {
			state.browser = browser;
			return SHOTS.reduce((chain, shot) => {
				return chain.then(() => {
					return capture(browser, shot);
				});
			}, Promise.resolve());
		})
		.then(() => {
			if (state.browser.errors.length) {
				log("page errors:\n  " + state.browser.errors.join("\n  "));
			}
		})
		.finally(() => {
			if (state.browser) {
				state.browser.close();
			}

			if (state.server) {
				state.server.kill("SIGTERM");
			}
		});
};

main().catch((error) => {
	process.stderr.write(error.stack + "\n");
	process.exit(1);
});
