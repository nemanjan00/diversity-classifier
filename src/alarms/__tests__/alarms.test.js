const createAlarms = require("../index").createAlarms;

const setup = (overrides) => {
	const fired = [];
	const clock = { now: 1000000 };
	const alarms = createAlarms(Object.assign({
		historySize: 100,
		now: () => {
			return clock.now;
		},
		sourceActivity: () => {
			return [];
		},
		onFire: (firing) => {
			fired.push(firing);
		}
	}, overrides || {}));

	return { alarms, fired, clock };
};

let nextId = 1;
const ev = (t, fields, path) => {
	return { id: nextId++, t, source: "s", labels: {}, classifier: (path || ["http"]).slice(-1)[0], path: path || ["http"], fields: fields || {} };
};

describe("alarms", () => {
	test("every n", () => {
		const s = setup();
		s.alarms.define({ name: "a", kind: "every", classifier: "http", params: { n: 3 }, cooldown: "0s" });
		[1, 2, 3, 4, 5, 6].forEach((i) => {
			s.alarms.onEvent(ev(i * 1000));
		});
		expect(s.fired.map((firing) => {
			return firing.value;
		})).toEqual([3, 6]);
	});

	test("rate with q filter and cooldown", () => {
		const s = setup();
		s.alarms.define({ name: "r", kind: "rate", classifier: "http", q: "status >= 500", params: { count: 3, window: "10s" }, cooldown: "1m" });
		[0, 1, 2, 3, 4].forEach((i) => {
			s.alarms.onEvent(ev(1000 + i * 1000, { status: 503 }));
			s.alarms.onEvent(ev(1000 + i * 1000, { status: 200 }));
		});
		expect(s.fired.length).toBe(1);
		expect(s.fired[0].value).toBe(3);
		expect(s.alarms.list()[0].suppressed).toBe(2);
	});

	test("threshold on p90 over a window", () => {
		const s = setup();
		s.alarms.define({ name: "slow", kind: "threshold", classifier: "http", params: { field: "took", agg: "p90", op: ">", value: 1000, window: "1m" }, cooldown: "0s" });
		s.alarms.onEvent(ev(1000, { took: 100 }));
		s.alarms.onEvent(ev(2000, { took: 200 }));
		expect(s.fired.length).toBe(0);
		s.alarms.onEvent(ev(3000, { took: 5000 }));
		expect(s.fired.length).toBe(1);
	});

	test("new_value with seeded values", () => {
		const s = setup();
		s.alarms.define({ name: "nv", kind: "new_value", classifier: "http", params: { field: "client" } }, ["known"]);
		s.alarms.onEvent(ev(1, { client: "known" }));
		s.alarms.onEvent(ev(2, { client: "fresh" }));
		s.alarms.onEvent(ev(3, { client: "fresh" }));
		expect(s.fired.map((firing) => {
			return firing.value;
		})).toEqual(["fresh"]);
		expect(s.alarms.persistentState().nv.seen.sort()).toEqual(["fresh", "known"]);
	});

	test("sequence with key", () => {
		const s = setup();
		s.alarms.define({ name: "seq", kind: "sequence", params: { first: "login", then: "error", within: "5s", key: "user" }, cooldown: "0s" });
		s.alarms.onEvent(ev(1000, { user: "a" }, ["login"]));
		s.alarms.onEvent(ev(2000, { user: "b" }, ["error"]));
		expect(s.fired.length).toBe(0);
		s.alarms.onEvent(ev(3000, { user: "a" }, ["error"]));
		expect(s.fired.length).toBe(1);
		s.alarms.onEvent(ev(9000, { user: "a" }, ["login"]));
		s.alarms.onEvent(ev(20000, { user: "a" }, ["error"]));
		expect(s.fired.length).toBe(1);
	});

	test("absence and source_silent fire from the timer", () => {
		const s = setup({
			sourceActivity: () => {
				return [{ source: "api", last: 1000000, started: 990000 }];
			}
		});
		s.alarms.define({ name: "hb", kind: "absence", classifier: "heartbeat", params: { window: "30s" } });
		s.alarms.define({ name: "quiet", kind: "source_silent", params: { source: "api", window: "1m" } });
		s.clock.now += 31000;
		s.alarms.tick();
		expect(s.fired.map((firing) => {
			return firing.alarm;
		})).toEqual(["hb"]);
		s.clock.now += 60000;
		s.alarms.tick();
		expect(s.fired.map((firing) => {
			return firing.alarm;
		})).toEqual(["hb", "quiet"]);
	});

	test("unclassified rate", () => {
		const s = setup();
		s.alarms.define({ name: "u", kind: "unclassified", params: { count: 2, window: "1m" }, cooldown: "0s" });
		s.alarms.onUnclassified({ t: 1000 });
		s.alarms.onUnclassified({ t: 2000 });
		expect(s.fired.length).toBe(1);
	});

	test("backfill is a dry run", () => {
		const s = setup();
		const events = [1, 2, 3, 4].map((i) => {
			return ev(i * 1000, { status: 500 });
		});
		const result = s.alarms.backfill({ name: "b", kind: "every", classifier: "http", params: { n: 2 }, cooldown: "0s" }, events);
		expect(result.would_fire).toBe(2);
		expect(s.fired.length).toBe(0);
	});

	test("validation", () => {
		const s = setup();
		expect(() => {
			s.alarms.define({ name: "x", kind: "rate", classifier: "a", params: { count: 1 } });
		}).toThrow(/window/);
		expect(() => {
			s.alarms.define({ name: "x", kind: "nope" });
		}).toThrow(/Unknown alarm kind/);
		expect(() => {
			s.alarms.define({ name: "x", kind: "every", params: { n: 1 } });
		}).toThrow(/need a classifier/);
	});
});
