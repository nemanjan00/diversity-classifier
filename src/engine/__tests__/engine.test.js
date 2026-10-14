const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../../config");
const createEngine = require("../index").createEngine;

const tmpDir = () => {
	return fs.mkdtempSync(path.join(os.tmpdir(), "dc-engine-"));
};

const makeEngine = (dir, extra) => {
	const settings = Object.assign({}, config.DEFAULTS, {
		STATE_FILE: path.join(dir, "state.json"),
		NO_GLOBAL: true,
		DIGEST_QUIET_MS: 20,
		DIGEST_MAX_WAIT_MS: 100
	}, extra || {});
	const engine = createEngine({ settings, log: () => {} });
	engine.start({ watch: false });
	return engine;
};

const LINES = [];

for (let i = 0; i < 60; i++) {
	LINES.push("2026-10-14T12:00:" + String(i).padStart(2, "0") + "Z INFO [http] GET /api/items/" + i + " " + (i % 6 === 0 ? 503 : 200) + " took=" + (i * 10) + "ms");

	if (i % 10 === 0) {
		LINES.push("2026-10-14T12:00:" + String(i).padStart(2, "0") + "Z ERROR [db] pool exhausted waiting=" + i + " max=20");
	}
}

const withHead = (engine) => {
	engine.defineParser({ name: "head", template: "^{ts:timestamp} {level:level} [{logger:word}]" });
	engine.defineClassifier({ name: "app", template: "{...head} {msg:rest}", envelope: true, time_field: "ts" });
};

describe("engine", () => {
	let dir = null;
	let engine = null;

	beforeEach(() => {
		dir = tmpDir();
		engine = makeEngine(dir);
	});

	afterEach(() => {
		engine.stop();
	});

	test("unclassified records cluster; a classifier absorbs them retroactively with original times", () => {
		engine.ingestLines(LINES, "api");
		expect(engine.getUnclassified({}).queue).toMatchObject({ clusters: 2, records: 66 });

		withHead(engine);
		const result = engine.defineClassifier({ name: "app.http", parent: "app", template: "GET {path:path} {status:int} took={took:duration}" });
		expect(result.retro.absorbed).toBe(60);
		expect(result.retro.queue.after).toEqual({ clusters: 1, records: 6 });

		const events = engine.queries.search({ classifier: "app.http", order: "asc", limit: 1 });
		expect(events.events[0].t).toBe("2026-10-14T12:00:00.000Z");
	});

	test("invariant: the queue only holds records nothing matches", () => {
		withHead(engine);
		engine.defineClassifier({ name: "app.http", parent: "app", template: "GET {path:path} {status:int} took={took:duration}" });
		engine.ingestLines(LINES, "api");

		const queue = engine.getUnclassified({ verbose: true });
		expect(queue.clusters.length).toBe(1);
		expect(queue.clusters[0].shape).toBe("pool exhausted waiting=<num> max=<num>");
		expect(queue.clusters[0].envelope).toBe("app");
		expect(queue.clusters[0].suggested_template).toBe("pool exhausted waiting={waiting:int} max={max:int}");
	});

	test("removing a classifier returns its records to the queue", () => {
		withHead(engine);
		engine.defineClassifier({ name: "app.http", parent: "app", template: "GET {path:path} {status:int} took={took:duration}" });
		engine.ingestLines(LINES, "api");
		const outcome = engine.removeClassifier("app.http");
		expect(outcome.returned_to_queue).toBe(60);
		expect(engine.getUnclassified({}).queue.records).toBe(66);
	});

	test("ignore_cluster creates a count-only classifier and empties that cluster", () => {
		withHead(engine);
		engine.ingestLines(LINES, "api");
		const pool = engine.getUnclassified({}).clusters.find((cluster) => {
			return cluster.shape.indexOf("pool") === 0;
		});
		const result = engine.ignoreCluster(pool.id);
		expect(result.retro.absorbed).toBe(6);
		expect(engine.listClassifiers({ classifier: "ignore.*" }).classifiers[0]).toMatchObject({ store: "count", parent: "app", count: 6, stored: 0 });
	});

	test("queries: q with typed literals, histogram, timeseries split, field summary", () => {
		withHead(engine);
		engine.defineClassifier({ name: "app.http", parent: "app", template: "GET {path:path} {status:int} took={took:duration}" });
		engine.ingestLines(LINES, "api");

		expect(engine.queries.search({ q: "status:503 and took > 300ms" }).total).toBe(4);
		expect(engine.queries.histogram({ classifier: "app.http", field: "status" }).values).toEqual([{ value: 200, count: 50 }, { value: 503, count: 10 }]);
		const split = engine.queries.timeseries({ classifier: "app.http", split_by: "status", interval: "30s", since: "2026-10-14T12:00:00Z", until: "2026-10-14T12:00:59Z" });
		expect(split.series.map((series) => {
			return series.key;
		})).toEqual(["200", "503"]);
		expect(split.series[1].values).toEqual([5, 5]);
		const summary = engine.queries.fieldSummary({ classifier: "app.http" });
		expect(summary.fields.find((field) => {
			return field.field === "level";
		}).top[0]).toEqual({ value: "info", count: 60, pct: 100 });
	});

	test("test_classifier reports near misses with the failing piece", () => {
		withHead(engine);
		engine.ingestLines(LINES, "api");
		const result = engine.testClassifier({ parent: "app", template: "GET {path:path} {status:int} took {took:duration}" });
		expect(result.matched).toBe(0);
		expect(result.near_misses[0].failed_at).toBe("whitespace");
		expect(engine.getUnclassified({}).queue.records).toBe(66);
	});

	test("alarms fire live but not for retroactively absorbed records", () => {
		const notes = [];
		engine.notifier.addSink((note) => {
			notes.push(note);
		});
		engine.ingestLines(LINES, "api");
		withHead(engine);
		engine.defineAlarm({ name: "any", kind: "every", classifier: "app.*", params: { n: 1 }, cooldown: "0s" });
		engine.defineClassifier({ name: "app.http", parent: "app", template: "GET {path:path} {status:int} took={took:duration}" });
		expect(notes.filter((note) => {
			return note.kind === "alarm";
		}).length).toBe(0);

		engine.ingestLines(["2026-10-14T12:01:00Z INFO [http] GET /x 200 took=1ms"], "api");
		expect(notes.filter((note) => {
			return note.kind === "alarm";
		}).length).toBe(1);
	});

	test("digest reports new clusters once", () => {
		const notes = [];
		engine.notifier.addSink((note) => {
			notes.push(note);
		});
		engine.ingestLines(["hello 1", "hello 2"], "api");
		engine.flush();
		engine.ingestLines(["hello 3"], "api");
		engine.flush();
		const digests = notes.filter((note) => {
			return note.kind === "unclassified";
		});
		expect(digests.length).toBe(1);
		expect(digests[0].content).toMatch(/1 new/);
	});

	test("definitions persist and reload; broken ones load disabled", () => {
		withHead(engine);
		engine.defineClassifier({ name: "app.http", parent: "app", template: "GET {path:path} {status:int} took={took:duration}" });
		engine.defineAlarm({ name: "nv", kind: "new_value", classifier: "app.http", params: { field: "path" } });
		engine.ingestLines(LINES, "api");
		engine.stop();

		const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
		expect(saved.classifiers.map((def) => {
			return def.name;
		})).toEqual(["app", "app.http"]);
		expect(saved.alarm_state.nv.seen.length).toBe(60);

		saved.classifiers.push({ name: "broken", template: "{x:nope}" });
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(saved));

		engine = makeEngine(dir);
		const list = engine.listClassifiers({}).classifiers;
		expect(list.map((def) => {
			return def.name;
		}).sort()).toEqual(["app", "app.http", "broken"]);
		expect(list.find((def) => {
			return def.name === "broken";
		}).error).toMatch(/Unknown type/);

		engine.ingestLines(["2026-10-14T12:00:00Z INFO [http] GET /new 200 took=1ms"], "api");
		expect(engine.alarmHistory({}).firings.map((firing) => {
			return firing.value;
		})).toEqual(["/new"]);
	});

	test("persisted command sources load paused", () => {
		engine.addSource({ name: "gen", type: "command", command: "echo hi; sleep 5" });
		engine.stop();

		engine = makeEngine(dir);
		const source = engine.listSources().sources.find((entry) => {
			return entry.name === "gen";
		});
		expect(source.state).toBe("paused");
		engine.removeSource("gen");
	});

	test("--no-commands blocks command sources from tools", () => {
		engine.stop();
		engine = makeEngine(dir, { NO_COMMANDS: true });
		expect(() => {
			engine.addSource({ name: "x", type: "command", command: "true" });
		}).toThrow(/no-commands/);
	});

	test("export and import packs", () => {
		withHead(engine);
		engine.defineClassifier({ name: "app.http", parent: "app", template: "GET {path:path} {status:int} took={took:duration}" });
		const pack = engine.definitionsExport({});
		engine.stop();

		const otherDir = tmpDir();
		engine = makeEngine(otherDir);
		engine.ingestLines(LINES, "api");
		const result = engine.definitionsImport(pack);
		expect(result.errors).toEqual([]);
		expect(result.imported).toEqual({ parsers: 1, classifiers: 2 });
		expect(result.retro.absorbed).toBe(60);
	});
});

describe("engine.wait", () => {
	test("resolves on records, new clusters and timeout", () => {
		const dir = tmpDir();
		const engine = makeEngine(dir);
		const records = engine.wait({ for: "records", count: 3, timeout_s: 5 });
		engine.ingestLines(["a 1", "a 2", "b x"], "w");

		return records.then((result) => {
			expect(result.reason).toBe("records");
			expect(result.records).toBe(3);
			expect(result.new_clusters.length).toBe(2);

			const any = engine.wait({ timeout_s: 5 });
			engine.ingestLines(["a 3"], "w");
			engine.ingestLines(["brand new"], "w");
			return any;
		}).then((result) => {
			expect(result.reason).toBe("new_cluster");
			expect(result.new_clusters[0].shape).toBe("brand new");

			return engine.wait({ for: "alarm", timeout_s: 1 });
		}).then((result) => {
			expect(result.reason).toBe("timeout");
			engine.stop();
		});
	});
});

describe("envelope multiline, redaction, sequences", () => {
	let engine = null;

	beforeEach(() => {
		engine = makeEngine(tmpDir());
		engine.defineClassifier({
			name: "w",
			template: "^[{worker:word}] {msg:rest}",
			envelope: true,
			multiline: { continue: "^\\s+at |^\\s*\\}", group_by: ["worker"] }
		});
	});

	afterEach(() => {
		engine.stop();
	});

	test("continuation bodies join per worker even when streams interleave", () => {
		engine.defineClassifier({ name: "w.err", parent: "w", template: "^Error: {message:text}\n{stack:rest}" });
		engine.ingestLines([
			"[a] Error: boom",
			"[b] Error: bang",
			"[a]     at one()",
			"[b]     at uno()",
			"[a]     at two()",
			"[a] next message"
		], "app");

		const events = engine.queries.search({ classifier: "w.err", order: "asc" }).events;
		expect(events.length).toBe(2);
		expect(events[0].fields).toMatchObject({ worker: "a", message: "boom" });
		expect(events[0].fields.stack).toBe("    at one()\n    at two()");
		expect(events[0].raw.split("\n").length).toBe(3);
		expect(events[1].fields.stack).toBe("    at uno()");

		const queue = engine.getUnclassified({});
		expect(queue.clusters.map((cluster) => {
			return cluster.shape;
		})).toEqual(["next message"]);
	});

	test("assembled records stay assembled through retro classification", () => {
		engine.ingestLines(["[a] Error: late", "[a]     at deep()", "[a] other"], "app");
		expect(engine.getUnclassified({}).queue.records).toBe(2);

		const result = engine.defineClassifier({ name: "w.err", parent: "w", template: "^Error: {message:text}\n{stack:rest}" });
		expect(result.retro.absorbed).toBe(1);
		expect(engine.queries.search({ classifier: "w.err" }).events[0].fields.stack).toBe("    at deep()");
	});

	test("ingest-time redaction and per-field redaction", () => {
		engine.defineClassifier({ name: "w.req", parent: "w", template: "GET {url:url} user={user:word}", redact: ["user"] });
		engine.ingestLines([
			"[a] GET https://bob:hunter2@example.com/x user=alice",
			"[a] auth header Authorization: Bearer abcdefghijklmnop token=s3cr3t"
		], "app");

		const event = engine.queries.search({ classifier: "w.req" }).events[0];
		expect(event.raw).toBe("[a] GET https://[REDACTED]@example.com/x user=[REDACTED]");
		expect(event.fields.user).toBe("[REDACTED]");

		const queued = engine.queries.unclassifiedRecords({}).records[0].raw;
		expect(queued).toBe("[a] auth header Authorization: Bearer [REDACTED] token=[REDACTED]");

		const preview = engine.setRedaction({ patterns: ["acct-\\d+"], test: "id acct-123" });
		expect(preview.test).toBe("id [REDACTED]");
	});

	test("sequences measure per-key gaps", () => {
		engine.defineClassifier({ name: "w.start", parent: "w", template: "job start" });
		engine.defineClassifier({ name: "w.done", parent: "w", template: "job done" });
		engine.ingestLines(["[a] job start", "[b] job start", "[a] job done", "[b] job done", "[a] job start"], "app");

		const result = engine.queries.sequences({ first: "w.start", then: "w.done", key: "worker" });
		expect(result.pairs).toBe(2);
		expect(result.first_without_then).toBe(1);
		expect(result.by_key.map((entry) => {
			return entry.key;
		}).sort()).toEqual(["a", "b"]);
	});

	test("count-only classifiers still chart from aggregate counters", () => {
		engine.defineClassifier({ name: "w.noise", parent: "w", template: "tick", store: "count" });
		engine.ingestLines(["[a] tick", "[a] tick", "[b] tick"], "app");

		expect(engine.queries.search({ classifier: "w.noise" }).total).toBe(0);
		const series = engine.queries.timeseries({ classifier: "w.noise", since: "-5m" });
		expect(series.source).toMatch(/aggregate/);
		expect(series.series[0].values.reduce((a, b) => {
			return a + b;
		}, 0)).toBe(3);
	});
});

describe("regressions", () => {
	test("children see the envelope body without leading whitespace", () => {
		const engine = makeEngine(tmpDir());
		engine.defineClassifier({ name: "p", template: "^[{worker:word}] | {msg:rest}", envelope: true });
		engine.defineClassifier({ name: "p.ok", parent: "p", regex: "^done (?<n>\\d+)$", types: { n: "int" } });
		engine.ingestLines(["[a] |   done 7"], "app");

		const event = engine.queries.search({ classifier: "p.ok" }).events[0];
		expect(event.fields.n).toBe(7);
		expect(event.fields.msg).toBe("  done 7");
		expect(engine.testClassifier({ parent: "p", regex: "^done (?<n>\\d+)$" }, { lines: ["[a] |   done 8"] }).matched).toBe(1);
		engine.stop();
	});

	test("new_value history is saved when it changes, not only on definition changes", () => {
		const dir = tmpDir();
		const engine = makeEngine(dir);
		engine.defineClassifier({ name: "login", template: "login user={user:word}" });
		engine.defineAlarm({ name: "nv", kind: "new_value", classifier: "login", params: { field: "user" } });
		engine.ingestLines(["login user=alice", "login user=bob"], "app");

		return new Promise((resolve) => {
			setTimeout(resolve, 400);
		}).then(() => {
			const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
			expect(saved.alarm_state.nv.seen.sort()).toEqual(["alice", "bob"]);
			engine.stop();
		});
	});
});

describe("shadowed top-level classifiers", () => {
	test("define_classifier warns when an envelope claims the lines first", () => {
		const engine = makeEngine(tmpDir());
		engine.defineClassifier({ name: "env", template: "^[{w:word}] {msg:rest}", envelope: true });
		engine.ingestLines(["[a] disk full on /data", "[b] disk full on /var"], "app");

		const top = engine.defineClassifier({ name: "disk", template: "disk full on {mount:path}" });
		expect(top.retro.absorbed).toBe(0);
		expect(top.warning).toMatch(/claimed first by envelope 'env'/);

		const child = engine.defineClassifier({ name: "env.disk", parent: "env", template: "disk full on {mount:path}" });
		expect(child.retro.absorbed).toBe(2);
		expect(child.warning).toBeUndefined();
		engine.stop();
	});
});

describe("routes as sub-classifiers", () => {
	test("route children match the parent's path field; unmatched paths stay on the parent", () => {
		const engine = makeEngine(tmpDir());
		engine.defineClassifier({ name: "http", template: "{method:word} {path:pathname}{q?:qs} {status:int}" });
		engine.defineClassifier({ name: "http.product", parent: "http", on: "path", template: "^/api/products/{id:int}$" });
		engine.defineClassifier({ name: "http.search", parent: "http", on: "path", template: "^/api/search$" });
		engine.ingestLines(["GET /api/products/42 200", "GET /api/search?q=shoes&page=3 200", "GET /about 200"], "web");

		expect(engine.queries.search({ classifier: "http.product" }).events[0].fields.id).toBe(42);
		expect(engine.queries.search({ q: "q.page >= 2" }).events[0].classifier).toBe("http.search");
		expect(engine.queries.histogram({ classifier: "http", field: "classifier", exact: true }).values.map((v) => {
			return v.value;
		}).sort()).toEqual(["http", "http.product", "http.search"]);
		engine.stop();
	});
});
