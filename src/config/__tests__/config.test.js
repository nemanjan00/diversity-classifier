const config = require("../index");

describe("config", () => {
	test("defaults", () => {
		const resolved = config.resolve([], {});
		expect(resolved.settings.EVENTS_TOTAL).toBe(200000);
		expect(resolved.sources).toEqual([]);
	});

	test("env overrides defaults, flags override env", () => {
		const resolved = config.resolve(["--state", "flag.json"], { DC_EVENTS_TOTAL: "5", DC_STATE_FILE: "env.json", DC_READ_ONLY: "true" });
		expect(resolved.settings.EVENTS_TOTAL).toBe(5);
		expect(resolved.settings.STATE_FILE).toBe("flag.json");
		expect(resolved.settings.READ_ONLY).toBe(true);
	});

	test("source flags with optional names", () => {
		const resolved = config.resolve([
			"--cmd", "api=ssh prod journalctl -fu api",
			"--cmd", "kubectl logs -f x",
			"--file", "/var/log/syslog",
			"--tcp", "net=0.0.0.0:5170"
		], {});

		expect(resolved.sources).toEqual([
			{ name: "api", type: "command", command: "ssh prod journalctl -fu api", origin: "cli" },
			{ name: "cmd-2", type: "command", command: "kubectl logs -f x", origin: "cli" },
			{ name: "file", type: "file", path: "/var/log/syslog", origin: "cli" },
			{ name: "net", type: "tcp", host: "0.0.0.0", port: 5170, origin: "cli" }
		]);
	});

	test("bad input", () => {
		expect(() => {
			config.resolve(["--nope"], {});
		}).toThrow();
		expect(() => {
			config.resolve([], { DC_EVENTS_TOTAL: "lots" });
		}).toThrow(/number/);
		expect(config.parseHttp("7070")).toEqual({ host: "127.0.0.1", port: 7070 });
		expect(config.parseHttp("0.0.0.0:80")).toEqual({ host: "0.0.0.0", port: 80 });
	});
});

describe("state file default", () => {
	test("defaults to .claude/ unless a legacy root file exists", () => {
		const fs = require("fs");
		const os = require("os");
		const path = require("path");
		const cwd = process.cwd();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-cfg-"));
		process.chdir(dir);

		try {
			expect(config.resolve([], {}).settings.STATE_FILE).toBe(path.join(".claude", "diversity-classifier.json"));
			fs.writeFileSync(".diversity-classifier.json", "{}");
			expect(config.resolve([], {}).settings.STATE_FILE).toBe(".diversity-classifier.json");
		} finally {
			process.chdir(cwd);
		}
	});
});
