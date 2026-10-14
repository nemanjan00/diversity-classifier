const createPatterns = require("../index").createPatterns;

const LINE = "2026-10-14T12:00:01.123Z ERROR [net.pool] client 9B1C2D3E-1111-2222-3333-444455556666 failed to connect to db-1.internal:5432 after 1.5s (attempt 3/5)";

const setup = () => {
	const patterns = createPatterns();
	patterns.defineParser({ name: "head", template: "^{ts:timestamp} {level:level} [{logger:word}]" });
	patterns.defineParser({ name: "hostport", template: "{host:host}:{port:port}" });
	return patterns;
};

describe("template compiler", () => {
	test("typed captures, spread head and nested parser fields", () => {
		const patterns = setup();
		const compiled = patterns.compile("{...head} client {client:uuid} failed to connect to {peer:hostport} after {elapsed:duration} (attempt {n:int}/{max:int})");
		const m = compiled.match(LINE);

		expect(m.fields).toEqual({
			ts: Date.parse("2026-10-14T12:00:01.123Z"),
			level: "error",
			logger: "net.pool",
			client: "9b1c2d3e-1111-2222-3333-444455556666",
			"peer.host": "db-1.internal",
			"peer.port": 5432,
			elapsed: 1500,
			n: 3,
			max: 5
		});
		expect(compiled.fieldTypes["peer.port"]).toBe("port");
		expect(compiled.uses.sort()).toEqual(["head", "hostport"]);
	});

	test("non-spread parser prefixes fields", () => {
		const patterns = setup();
		const m = patterns.compile("{h:head} {msg:rest}").match("2026-10-14 12:00:01 warn [x] hello");
		expect(m.fields["h.level"]).toBe("warn");
		expect(m.fields.msg).toBe("hello");
	});

	test("prefilter literal is the longest required literal", () => {
		const patterns = setup();
		expect(patterns.compile("user {u:word} logged in from {ip:ip}").literal).toBe("logged");
		expect(patterns.compile("a {x?:int} somethinglong").literal).toBe("somethinglong");
	});

	test("optional capture absorbs preceding whitespace", () => {
		const patterns = createPatterns();
		const compiled = patterns.compile("done {n:int} {unit?:word}!");
		expect(compiled.match("done 5 items!").fields).toEqual({ n: 5, unit: "items" });
		expect(compiled.match("done 5!").fields).toEqual({ n: 5 });
	});

	test("filters, enum, inline regex, skip", () => {
		const patterns = createPatterns();
		const compiled = patterns.compile("{_:word} {method:enum(GET,POST)} {svc:word|lower|map(api=gateway)} id={id:/[A-Z]{3}-\\d+/} {*} took {t:word|duration}");
		const m = compiled.match("x POST API id=ABC-12 whatever here took 250ms");
		expect(m.fields).toEqual({ method: "POST", svc: "gateway", id: "ABC-12", t: 250 });
	});

	test("json and kv flatten into dotted fields", () => {
		const patterns = createPatterns();
		const json = patterns.compile("payload={data:json}").match("payload={\"a\":{\"b\":1},\"tags\":[\"x\",\"y\"]}");
		expect(json.fields).toEqual({ "data.a.b": 1, "data.tags": ["x", "y"] });

		const kv = patterns.compile("req {kv:kv}").match("req user=alice took=12 msg=\"hi there\"");
		expect(kv.fields).toEqual({ "kv.user": "alice", "kv.took": 12, "kv.msg": "hi there" });
	});

	test("conversion failure rejects the match", () => {
		const patterns = createPatterns();
		expect(patterns.compile("port {p:port}").match("port 99999")).toBeNull();
		expect(patterns.compile("data {d:json}").match("data {not json}")).toBeNull();
	});

	test("anchors and literal braces", () => {
		const patterns = createPatterns();
		expect(patterns.compile("^start {x:int}$").match("start 1")).not.toBeNull();
		expect(patterns.compile("^start {x:int}$").match("pre start 1")).toBeNull();
		expect(patterns.compile("{{literal}} {x:int}").match("{literal} 7").fields).toEqual({ x: 7 });
	});

	test("level normalises any case and short forms", () => {
		const patterns = createPatterns();
		const compiled = patterns.compile("[{l:level}]");
		expect(compiled.match("[WARNING]").fields.l).toBe("warn");
		expect(compiled.match("[Err]").fields.l).toBe("error");
		expect(compiled.match("[E]").fields.l).toBe("error");
	});

	test("diagnose points at the failing piece", () => {
		const patterns = setup();
		const compiled = patterns.compile("{...head} client {client:uuid} failed to connect to {peer:hostport} after {elapsed:duration}");
		const diagnosis = compiled.diagnose("2026-10-14T12:00:01Z ERROR [net] client 9b1c2d3e-1111-2222-3333-444455556666 failed to connect to db-1 after 1s");
		expect(diagnosis.matches).toBe(false);
		expect(diagnosis.failed_at).toBe("{peer:hostport}");
	});

	test("errors: unknown type, unknown filter, bad syntax, cycles", () => {
		const patterns = createPatterns();
		expect(() => {
			patterns.compile("{x:nope}");
		}).toThrow(/Unknown type 'nope'/);
		expect(() => {
			patterns.compile("{x:int|nope}");
		}).toThrow(/Unknown filter/);
		expect(() => {
			patterns.compile("{x:int");
		}).toThrow(/Expected }/);
		expect(() => {
			patterns.compile("a } b");
		}).toThrow(/Unmatched }/);

		patterns.defineParser({ name: "a", template: "{x:int}" });
		patterns.defineParser({ name: "b", template: "{y:a}" });
		expect(() => {
			patterns.defineParser({ name: "a", template: "{z:b}" });
		}).toThrow(/cycle/);
		expect(patterns.getParser("a").template).toBe("{x:int}");
	});

	test("regex parsers with converters, and dependents", () => {
		const patterns = createPatterns();
		patterns.defineParser({ name: "reqid", regex: "req-[0-9a-f]{4}", convert: "upper" });
		patterns.defineParser({ name: "ctx", template: "[{id:reqid}]" });
		expect(patterns.compile("{c:ctx} ok").match("[req-ab12] ok").fields).toEqual({ "c.id": "REQ-AB12" });
		expect(patterns.dependentsOf("reqid")).toEqual(["ctx"]);
		expect(() => {
			patterns.defineParser({ name: "int", regex: "x" });
		}).toThrow(/built-in/);
		expect(() => {
			patterns.defineParser({ name: "bad", regex: "(?<g>x)" });
		}).toThrow(/named groups/);
	});

	test("raw regex classifiers map __ to dots and convert types", () => {
		const patterns = createPatterns();
		const compiled = patterns.compileRegex("status=(?<http__status>\\d+) took=(?<took>\\S+)", "", { "http.status": "int", took: "duration" });
		expect(compiled.match("status=503 took=2s").fields).toEqual({ "http.status": 503, took: 2000 });
	});
});
