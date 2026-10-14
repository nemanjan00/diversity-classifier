const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const createSources = require("../index").createSources;

const setup = () => {
	const records = [];
	const changes = [];
	const sources = createSources({
		allowCommands: true,
		onRecord: (record) => {
			records.push(record);
		},
		onStatus: (change) => {
			changes.push(change);
		}
	});

	return { sources, records, changes };
};

const waitFor = (predicate, timeoutMs) => {
	const started = Date.now();

	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) {
				resolve();
				return;
			}

			if (Date.now() - started > (timeoutMs || 5000)) {
				reject(new Error("timed out"));
				return;
			}

			setTimeout(check, 20);
		};

		check();
	});
};

describe("sources", () => {
	test("command source with labels and demux", () => {
		const s = setup();
		s.sources.add({
			name: "k8s",
			type: "command",
			command: "printf '[pod-a] hello 1\\n[pod-b] hello 2\\n[pod-a] hello 3\\n'",
			restart: false,
			labels: { env: "test" },
			demux: { regex: "^\\[(?<pod>[^\\]]+)\\]\\s", label: "pod" }
		});

		return waitFor(() => {
			return s.records.length === 3;
		}).then(() => {
			expect(s.records.map((record) => {
				return record.raw;
			})).toEqual(["hello 1", "hello 2", "hello 3"]);
			expect(s.records[1].labels).toEqual({ env: "test", pod: "pod-b" });
			expect(s.sources.activity("k8s:*").map((entry) => {
				return entry.source;
			}).sort()).toEqual(["k8s:pod-a", "k8s:pod-b"]);

			return waitFor(() => {
				return s.changes.some((change) => {
					return change.change === "exited";
				});
			});
		}).then(() => {
			s.sources.stopAll();
		});
	});

	test("file source tails appended lines", () => {
		const s = setup();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-src-"));
		const file = path.join(dir, "app.log");
		fs.writeFileSync(file, "old line\n");
		s.sources.add({ name: "f", type: "file", path: file });

		return new Promise((resolve) => {
			setTimeout(resolve, 300);
		}).then(() => {
			fs.appendFileSync(file, "new line 1\nnew line 2\n");
			return waitFor(() => {
				return s.records.length === 2;
			});
		}).then(() => {
			expect(s.records.map((record) => {
				return record.raw;
			})).toEqual(["new line 1", "new line 2"]);
			s.sources.stopAll();
		});
	});

	test("tcp source labels connections by peer", () => {
		const s = setup();
		s.sources.add({ name: "net", type: "tcp", port: 0 });

		return waitFor(() => {
			return s.changes.some((change) => {
				return change.change === "listening";
			});
		}).then(() => {
			const port = s.changes.find((change) => {
				return change.change === "listening";
			}).port;
			const socket = net.connect(port, "127.0.0.1", () => {
				socket.end("line one\nline two\n");
			});

			return waitFor(() => {
				return s.records.length === 2;
			});
		}).then(() => {
			expect(s.records[0].labels.peer).toMatch(/^127\.0\.0\.1:/);
			s.sources.stopAll();
		});
	});

	test("ingest and validation", () => {
		const s = setup();
		expect(s.sources.ingest(["a", "b"], "paste")).toBe(2);
		expect(s.records.length).toBe(2);
		expect(() => {
			s.sources.add({ name: "x", type: "command" });
		}).toThrow(/need a command/);
		expect(() => {
			s.sources.add({ name: "bad name!", type: "ingest" });
		}).toThrow(/name/);
	});
});
