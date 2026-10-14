const units = require("../index");

describe("units", () => {
	test("parseDuration", () => {
		expect(units.parseDuration("250ms")).toBe(250);
		expect(units.parseDuration("1.5s")).toBe(1500);
		expect(units.parseDuration("1h30m")).toBe(5400000);
		expect(units.parseDuration("15us")).toBeCloseTo(0.015);
		expect(units.parseDuration("42")).toBe(42);
		expect(units.parseDuration("abc")).toBeUndefined();
		expect(units.parseDuration("5mx")).toBeUndefined();
	});

	test("parseBytes", () => {
		expect(units.parseBytes("512")).toBe(512);
		expect(units.parseBytes("12KB")).toBe(12000);
		expect(units.parseBytes("1KiB")).toBe(1024);
		expect(units.parseBytes("3.5MiB")).toBe(3.5 * 1024 * 1024);
		expect(units.parseBytes("1G")).toBe(1e9);
		expect(units.parseBytes("lots")).toBeUndefined();
	});

	test("parseTimestamp formats", () => {
		expect(units.parseTimestamp("2026-10-14T12:00:01.123Z")).toBe(Date.parse("2026-10-14T12:00:01.123Z"));
		expect(units.parseTimestamp("2026-10-14 12:00:01,5+0200")).toBe(Date.parse("2026-10-14T12:00:01.500+02:00"));
		expect(units.parseTimestamp("14/Oct/2026:12:00:01 +0000")).toBe(Date.parse("2026-10-14T12:00:01Z"));
		expect(units.parseTimestamp("1791979201")).toBe(1791979201000);
		expect(units.parseTimestamp("1791979201123")).toBe(1791979201123);
		expect(typeof units.parseTimestamp("Oct 14 12:00:01")).toBe("number");
		expect(units.parseTimestamp("not a time")).toBeUndefined();
	});

	test("parseTime relative", () => {
		const now = 1000000000;
		expect(units.parseTime("now", now)).toBe(now);
		expect(units.parseTime("-15m", now)).toBe(now - 900000);
		expect(units.parseTime("2h", now)).toBe(now - 7200000);
		expect(units.parseTime("2026-10-14T00:00:00Z", now)).toBe(Date.parse("2026-10-14T00:00:00Z"));
	});

	test("autoInterval picks nice intervals", () => {
		expect(units.autoInterval(3600000, 60)).toBe(60000);
		expect(units.autoInterval(60000, 60)).toBe(1000);
	});
});
