const path = require("path");
const os = require("os");
const parseArgs = require("util").parseArgs;

const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");

const DEFAULTS = {
	EVENTS_PER_CLASSIFIER: 20000,
	EVENTS_TOTAL: 200000,
	UNCLASSIFIED_BUFFER: 20000,
	MAX_CLUSTERS: 2000,
	CLUSTER_EXAMPLES: 5,
	TOPK_VALUES: 100,
	DIGEST_QUIET_MS: 5000,
	DIGEST_MAX_WAIT_MS: 60000,
	DIGEST_GROWTH_FACTOR: 10,
	ALARM_HISTORY: 500,
	STATE_FILE: ".diversity-classifier.json",
	GLOBAL_STATE_FILE: path.join(xdgConfig, "diversity-classifier", "global.json"),
	HTTP: null,
	HTTP_TOKEN: null,
	READ_ONLY: false,
	NO_COMMANDS: false,
	NO_GLOBAL: false,
	RESUME_SOURCES: false
};

const NUMERIC = ["EVENTS_PER_CLASSIFIER", "EVENTS_TOTAL", "UNCLASSIFIED_BUFFER", "MAX_CLUSTERS", "CLUSTER_EXAMPLES",
	"TOPK_VALUES", "DIGEST_QUIET_MS", "DIGEST_MAX_WAIT_MS", "DIGEST_GROWTH_FACTOR", "ALARM_HISTORY"];
const BOOLEAN = ["READ_ONLY", "NO_COMMANDS", "NO_GLOBAL", "RESUME_SOURCES"];
const ENV_PREFIX = "DC_";

const USAGE = `diversity-classifier: MCP server for AI log watching

Usage: diversity-classifier [options]

Sources (repeatable):
  --cmd "[name=]command"     run a command and read stdout+stderr (e.g. "api=ssh prod journalctl -fu api")
  --file "[name=]path"       tail -F a file
  --tcp "[name=][host:]port" listen for lines on TCP
  --unix "[name=]path"       listen for lines on a Unix socket

State:
  --state <path>             project state file (default ./.diversity-classifier.json)
  --global-state <path>      global state file (default $XDG_CONFIG_HOME/diversity-classifier/global.json)
  --no-global                do not load or write the global layer

Web UI:
  --http [host:]port         serve the web UI + REST API (default bind 127.0.0.1)
  --token <secret>           bearer token (required for non-loopback binds)
  --read-only                disable mutating endpoints in the web UI / REST API

Safety:
  --no-commands              forbid adding command sources through tools / UI
  --resume-sources           auto-start command sources saved in state files
                             (default: they load paused; the agent resumes them with start_source)

Tuning: any setting can be given as env var DC_<NAME>, e.g. DC_EVENTS_TOTAL=500000
  ${NUMERIC.join(", ")}
`;

/**
 * Resolve settings: CLI flags > env vars (DC_*) > defaults.
 * @returns {{ settings: object, sources: Array<object>, help: boolean }}
 */
const resolve = (argv, env) => {
	const parsed = parseArgs({
		args: argv || [],
		options: {
			cmd: { type: "string", multiple: true },
			file: { type: "string", multiple: true },
			tcp: { type: "string", multiple: true },
			unix: { type: "string", multiple: true },
			state: { type: "string" },
			"global-state": { type: "string" },
			"no-global": { type: "boolean" },
			http: { type: "string" },
			token: { type: "string" },
			"read-only": { type: "boolean" },
			"no-commands": { type: "boolean" },
			"resume-sources": { type: "boolean" },
			help: { type: "boolean", short: "h" }
		},
		allowPositionals: false,
		strict: true
	});
	const values = parsed.values;
	const environment = env || {};
	const settings = Object.assign({}, DEFAULTS);

	Object.keys(DEFAULTS).forEach((key) => {
		const raw = environment[ENV_PREFIX + key];

		if (raw === undefined || raw === "") {
			return;
		}

		if (NUMERIC.indexOf(key) !== -1) {
			const n = Number(raw);

			if (!isFinite(n)) {
				throw new Error(ENV_PREFIX + key + " must be a number");
			}

			settings[key] = n;
		} else if (BOOLEAN.indexOf(key) !== -1) {
			settings[key] = ["1", "true", "yes", "on"].indexOf(String(raw).toLowerCase()) !== -1;
		} else {
			settings[key] = raw;
		}
	});

	if (values.state) {
		settings.STATE_FILE = values.state;
	}

	if (values["global-state"]) {
		settings.GLOBAL_STATE_FILE = values["global-state"];
	}

	if (values["no-global"]) {
		settings.NO_GLOBAL = true;
	}

	if (values.http) {
		settings.HTTP = values.http;
	}

	if (values.token) {
		settings.HTTP_TOKEN = values.token;
	}

	if (values["read-only"]) {
		settings.READ_ONLY = true;
	}

	if (values["no-commands"]) {
		settings.NO_COMMANDS = true;
	}

	if (values["resume-sources"]) {
		settings.RESUME_SOURCES = true;
	}

	const named = (raw, fallbackPrefix, index) => {
		const m = /^([A-Za-z0-9_][\w.-]*)=(.+)$/.exec(raw);

		if (m) {
			return { name: m[1], value: m[2] };
		}

		return { name: fallbackPrefix + (index === 0 ? "" : "-" + (index + 1)), value: raw };
	};

	const sources = [];
	(values.cmd || []).forEach((raw, i) => {
		const n = named(raw, "cmd", i);
		sources.push({ name: n.name, type: "command", command: n.value, origin: "cli" });
	});
	(values.file || []).forEach((raw, i) => {
		const n = named(raw, "file", i);
		sources.push({ name: n.name, type: "file", path: n.value, origin: "cli" });
	});
	(values.tcp || []).forEach((raw, i) => {
		const n = named(raw, "tcp", i);
		const hp = /^(?:(.+):)?(\d+)$/.exec(n.value);

		if (!hp) {
			throw new Error("--tcp expects [name=][host:]port");
		}

		sources.push({ name: n.name, type: "tcp", host: hp[1] || "127.0.0.1", port: parseInt(hp[2], 10), origin: "cli" });
	});
	(values.unix || []).forEach((raw, i) => {
		const n = named(raw, "unix", i);
		sources.push({ name: n.name, type: "unix", path: n.value, origin: "cli" });
	});

	return { settings, sources, help: !!values.help };
};

/** Parse "[host:]port" for the web server. */
const parseHttp = (value) => {
	if (!value) {
		return null;
	}

	const m = /^(?:(.+):)?(\d+)$/.exec(String(value));

	if (!m) {
		throw new Error("--http expects [host:]port");
	}

	return { host: m[1] || "127.0.0.1", port: parseInt(m[2], 10) };
};

module.exports = {
	DEFAULTS,
	USAGE,
	resolve,
	parseHttp
};
