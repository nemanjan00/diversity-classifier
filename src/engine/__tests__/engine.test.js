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
