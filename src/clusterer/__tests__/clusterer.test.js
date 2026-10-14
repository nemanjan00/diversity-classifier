const mask = require("../mask").mask;
const suggestTemplate = require("../mask").suggestTemplate;
const createClusterer = require("../index").createClusterer;
const createPatterns = require("../../patterns").createPatterns;

const record = (raw, extra) => {
	return Object.assign({ raw, t: Date.now(), source: "s", labels: {} }, extra || {});
};

describe("mask", () => {
	test("collapses variable tokens", () => {
		expect(mask("GET /api/users/42 200 took=12.5ms from 10.0.0.1:443 req=9b1c2d3e-1111-2222-3333-444455556666").shape)
			.toBe("GET <path> <num> took=<dur> from <ip>:<num> req=<uuid>");
		expect(mask("pause 1500ms heap=1000MB session a1b2c3d4e5f6 \"quoted text\"").shape)
			.toBe("pause <dur> heap=<bytes> session <hex> <str>");
	});

	test("keeps meaningful words", () => {
		expect(mask("code=ECONNRESET v2 http2").shape).toBe("code=ECONNRESET v2 http2");
	});

	test("suggested templates match their examples", () => {
		const patterns = createPatterns();
		const lines = [
			"2026-10-14T12:00:01Z GET /api/users/42 200 took=12.5ms ip=10.0.0.1:443",
			"Oct 14 12:00:01 host sshd[1234]: Accepted publickey for root from 1.2.3.4 port 5555 ssh2",
			"error: \"connection reset\" code=ECONNRESET {weird} payload 0xdeadbeef"
		];

		lines.forEach((line) => {
			const template = suggestTemplate(mask(line).shape, [line]);
			expect(patterns.compile(template).match(line)).not.toBeNull();
		});
	});

	test("names fields from key= prefixes", () => {
		expect(suggestTemplate("took=<dur> user=<id>", [])).toBe("took={took:duration} user={user:word}");
	});
});

describe("clusterer", () => {
	test("groups by shape and counts sources", () => {
		const clusterer = createClusterer({ bufferSize: 100, maxClusters: 10, examples: 5 });
		clusterer.add(record("user 1 logged in"));
		clusterer.add(record("user 2 logged in", { source: "b" }));
		clusterer.add(record("disk full"));

		const list = clusterer.list({});
		expect(list.length).toBe(2);
		expect(list[0].count).toBe(2);
		expect(list[0].sources).toEqual({ s: 1, b: 1 });
		expect(clusterer.describe(list[0]).suggested_template).toBe("user {num_1:int} logged in");
	});

	test("absorb removes records; fully absorbed clusters are deleted with backlog", () => {
		const clusterer = createClusterer({ bufferSize: 3, maxClusters: 10, examples: 5 });
		[1, 2, 3, 4, 5].forEach((n) => {
			clusterer.add(record("job " + n + " done"));
		});

		const cluster = clusterer.list({})[0];
		expect(cluster.count).toBe(5);
		expect(cluster.buffered).toBe(3);

		const summary = clusterer.absorb(clusterer.records());
		expect(summary[0]).toMatchObject({ matched: 3, deleted: true, backlog: 2 });
		expect(clusterer.all().length).toBe(0);
		expect(clusterer.records().length).toBe(0);
	});

	test("envelope records cluster by body", () => {
		const clusterer = createClusterer({ bufferSize: 10, maxClusters: 10, examples: 5 });
		const envelope = { name: "app", path: ["app"], fields: {} };
		clusterer.add(record("2026-10-14 12:00:01 INFO hello 1", { envelope, body: "hello 1" }));
		clusterer.add(record("2026-10-15 13:00:01 INFO hello 2", { envelope, body: "hello 2" }));
		const list = clusterer.list({});
		expect(list.length).toBe(1);
		expect(list[0].shape).toBe("hello <num>");
		expect(list[0].envelope).toBe("app");
	});

	test("cluster cap evicts least recently seen clusters and their records", () => {
		const clusterer = createClusterer({ bufferSize: 100, maxClusters: 2, examples: 5 });
		clusterer.add(record("alpha"));
		clusterer.add(record("beta"));
		clusterer.add(record("gamma"));
		expect(clusterer.all().map((cluster) => {
			return cluster.shape;
		})).toEqual(["beta", "gamma"]);
		expect(clusterer.records().length).toBe(2);
		expect(clusterer.stats().evicted_clusters).toBe(1);
	});
});
