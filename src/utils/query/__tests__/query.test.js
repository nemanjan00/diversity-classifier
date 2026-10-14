const parseQuery = require("../index").parseQuery;
const combine = require("../index").combine;

describe("parseQuery", () => {
	test("empty query is an empty tree", () => {
		expect(parseQuery("")).toEqual({});
		expect(parseQuery("   ")).toEqual({});
	});

	test("field:value equality with typed literals", () => {
		expect(parseQuery("status:503")).toEqual({ status: 503 });
		expect(parseQuery("ok:true")).toEqual({ ok: true });
		expect(parseQuery("level:error")).toEqual({ level: "error" });
	});

	test("quoted values stay strings and allow spaces", () => {
		expect(parseQuery("msg:\"connection reset\"")).toEqual({ msg: "connection reset" });
		expect(parseQuery("code:\"503\"")).toEqual({ code: "503" });
	});

	test("comparisons", () => {
		expect(parseQuery("took > 2s")).toEqual({ took: { gt: "2s" } });
		expect(parseQuery("status>=500")).toEqual({ status: { gte: 500 } });
		expect(parseQuery("size <= 1MB")).toEqual({ size: { lte: "1MB" } });
	});

	test("globs, regex, sets, exists", () => {
		expect(parseQuery("path:/health*")).toEqual({ path: { glob: "/health*" } });
		expect(parseQuery("host:/^db-\\d+$/i")).toEqual({ host: { regex: { source: "^db-\\d+$", flags: "i" } } });
		expect(parseQuery("level:(error or fatal)")).toEqual({ or: [{ level: "error" }, { level: "fatal" }] });
		expect(parseQuery("exists:err.code")).toEqual({ "err.code": { exists: true } });
	});

	test("boolean logic with precedence and implicit and", () => {
		expect(parseQuery("a:1 b:2 or c:3")).toEqual({ or: [{ and: [{ a: 1 }, { b: 2 }] }, { c: 3 }] });
		expect(parseQuery("a:1 and (b:2 or c:3)")).toEqual({ and: [{ a: 1 }, { or: [{ b: 2 }, { c: 3 }] }] });
		expect(parseQuery("not a:1")).toEqual({ not: { a: 1 } });
	});

	test("special fields and colon-containing values", () => {
		expect(parseQuery("$source:api and $labels.pod:api-7f*")).toEqual({ and: [{ $source: "api" }, { "$labels.pod": { glob: "api-7f*" } }] });
		expect(parseQuery("ts:12:30:01")).toEqual({ ts: "12:30:01" });
		expect(parseQuery("classifier:http.*")).toEqual({ classifier: { glob: "http.*" } });
	});

	test("bare words search the raw line", () => {
		expect(parseQuery("timeout")).toEqual({ $raw: { contains: "timeout" } });
		expect(parseQuery("\"pool exhausted\"")).toEqual({ $raw: { contains: "pool exhausted" } });
	});

	test("errors carry a position", () => {
		expect(() => {
			parseQuery("(a:1");
		}).toThrow(/Expected \)/);

		try {
			parseQuery("a:\"open");
		} catch (e) {
			expect(e.position).toBe(2);
		}
	});

	test("combine ANDs q and where", () => {
		expect(combine("a:1", { b: 2 })).toEqual({ and: [{ a: 1 }, { b: 2 }] });
		expect(combine(null, { b: 2 })).toEqual({ b: 2 });
		expect(combine("", null)).toEqual({});
	});
});
