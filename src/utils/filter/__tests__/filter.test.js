const compileWhere = require("../index").compileWhere;
const referencedFields = require("../index").referencedFields;

const get = (record, key) => {
	return record[key];
};

const match = (where, record, types) => {
	return compileWhere(where, { get, types })(record);
};

describe("compileWhere", () => {
	test("empty where matches everything", () => {
		expect(match({}, { a: 1 })).toBe(true);
		expect(match(null, { a: 1 })).toBe(true);
	});

	test("implicit eq and arrays as in", () => {
		expect(match({ a: 1 }, { a: 1 })).toBe(true);
		expect(match({ a: "1" }, { a: 1 })).toBe(true);
		expect(match({ a: [1, 2] }, { a: 2 })).toBe(true);
		expect(match({ a: [1, 2] }, { a: 3 })).toBe(false);
	});

	test("comparison operators coerce typed literals", () => {
		expect(match({ took: { gt: "2s" } }, { took: 2500 }, { took: "duration" })).toBe(true);
		expect(match({ took: { gt: "2s" } }, { took: 1500 }, { took: "duration" })).toBe(false);
		expect(match({ size: { gte: "1KiB" } }, { size: 1024 }, { size: "bytes" })).toBe(true);
		expect(match({ took: { lt: "1m" } }, { took: 59000 })).toBe(true);
		expect(match({ ts: { gte: "2026-01-01T00:00:00Z" } }, { ts: Date.parse("2026-02-01T00:00:00Z") }, { ts: "timestamp" })).toBe(true);
	});

	test("missing values never satisfy comparisons", () => {
		expect(match({ a: { gt: 1 } }, {})).toBe(false);
		expect(match({ a: { exists: true } }, {})).toBe(false);
		expect(match({ a: { exists: false } }, {})).toBe(true);
	});

	test("regex, glob, contains, nin", () => {
		expect(match({ p: { regex: "^/admin" } }, { p: "/admin/x" })).toBe(true);
		expect(match({ p: { glob: "/health*" } }, { p: "/healthz" })).toBe(true);
		expect(match({ p: { contains: "RESET" } }, { p: "connection reset" })).toBe(true);
		expect(match({ s: { nin: [500, 503] } }, { s: 200 })).toBe(true);
	});

	test("array values match if any element matches (classifier paths)", () => {
		expect(match({ classifier: { glob: "http.*" } }, { classifier: ["http", "http.admin"] })).toBe(true);
		expect(match({ classifier: "db" }, { classifier: ["http", "http.admin"] })).toBe(false);
	});

	test("and / or / not", () => {
		const where = { or: [{ level: "error" }, { took: { gt: 1000 } }], not: { path: "/health" } };
		expect(match(where, { level: "error", path: "/x" })).toBe(true);
		expect(match(where, { level: "info", took: 5, path: "/x" })).toBe(false);
		expect(match(where, { level: "error", path: "/health" })).toBe(false);
	});

	test("referencedFields lists fields", () => {
		expect(referencedFields({ a: 1, or: [{ b: 2 }, { not: { c: 3 } }] }).sort()).toEqual(["a", "b", "c"]);
	});
});
