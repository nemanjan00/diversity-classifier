const childProcess = require("child_process");
const net = require("net");
const fs = require("fs");

const createLineSplitter = require("../utils/line-assembler").createLineSplitter;
const createAssembler = require("../utils/line-assembler").createAssembler;
const globMatch = require("../utils/glob").globMatch;

const NAME_RE = /^[A-Za-z0-9_][\w.-]*$/;
const TYPES = ["file", "command", "tcp", "unix", "ingest"];
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const STABLE_RUN_MS = 60000;
const LABELS_CAP = 500;
const STDERR_TAIL = 2000;

/*
 * Sources (SPEC.md §10): file (tail -F), command (sh -c, auto-restart),
 * tcp / unix listeners, and the ingest tool. Each stream (and each demuxed
 * label) has its own line assembler so multiline records never interleave.
 */

const normalise = (def) => {
	if (!def || !NAME_RE.test(def.name || "")) {
		throw new Error("Source name must match " + NAME_RE);
	}

	if (TYPES.indexOf(def.type) === -1) {
		throw new Error("Source type must be one of " + TYPES.join(", "));
	}

	if (def.type === "file" && !def.path) {
		throw new Error("file sources need a path");
	}

	if (def.type === "command" && !def.command) {
		throw new Error("command sources need a command");
	}

	if (def.type === "tcp" && !(def.port > 0)) {
		throw new Error("tcp sources need a port");
	}

	if (def.type === "unix" && !def.path) {
		throw new Error("unix sources need a path");
	}

	if (def.multiline) {
		if (!def.multiline.start && !def.multiline.continue) {
			throw new Error("multiline needs start or continue regex");
		}

		new RegExp(def.multiline.start || def.multiline.continue);
	}

	if (def.demux) {
		if (!def.demux.regex) {
			throw new Error("demux needs a regex with one capture group (named or not)");
		}

		new RegExp(def.demux.regex);
	}

	return {
		name: def.name,
		type: def.type,
		path: def.path,
		command: def.command,
		host: def.host,
		port: def.port,
		from_start: !!def.from_start,
		restart: def.restart !== undefined ? !!def.restart : def.type === "command",
		labels: def.labels || {},
		multiline: def.multiline || null,
		flush_ms: def.flush_ms || 250,
		max_line: def.max_line || 16384,
		strip_ansi: def.strip_ansi !== false,
		demux: def.demux ? { regex: def.demux.regex, label: def.demux.label || "stream", strip: def.demux.strip !== false } : null,
		scope: def.scope || "project",
		origin: def.origin || "tool"
	};
};

const serialise = (def) => {
	const out = { name: def.name, type: def.type };
	["path", "command", "host", "port", "multiline", "demux"].forEach((key) => {
		if (def[key] !== undefined && def[key] !== null) {
			out[key] = def[key];
		}
	});

	if (def.from_start) {
		out.from_start = true;
	}

	if (def.restart !== (def.type === "command")) {
		out.restart = def.restart;
	}

	if (Object.keys(def.labels).length) {
		out.labels = def.labels;
	}

	if (def.flush_ms !== 250) {
		out.flush_ms = def.flush_ms;
	}

	if (def.max_line !== 16384) {
		out.max_line = def.max_line;
	}

	if (!def.strip_ansi) {
		out.strip_ansi = false;
	}

	return out;
};

/**
 * @param {{ onRecord: function(object): void, onStatus: function(object): void,
 *   allowCommands: boolean, now?: function(): number }} options
 */
const createSources = (options) => {
	const sources = new Map();
	const now = options.now || Date.now;

	const status = (entry, change, detail) => {
		options.onStatus(Object.assign({ source: entry.def.name, change }, detail || {}));
	};

	const makeStream = (entry, connectionLabels) => {
		const def = entry.def;
		const demuxRe = def.demux ? new RegExp(def.demux.regex) : null;
		const assemblers = new Map();

		const emit = (raw, demuxValue) => {
			const t = now();
			entry.stats.records++;
			entry.stats.last = t;
			const labels = Object.assign({}, def.labels, connectionLabels || {});

			if (demuxValue !== undefined) {
				labels[def.demux.label] = demuxValue;
				const labelStats = entry.stats.labels.get(demuxValue);

				if (labelStats) {
					labelStats.records++;
					labelStats.last = t;
				} else if (entry.stats.labels.size < LABELS_CAP) {
					entry.stats.labels.set(demuxValue, { records: 1, last: t, first: t });
				}
			}

			options.onRecord({ raw, t, source: def.name, labels });
		};

		const assemblerFor = (key) => {
			if (!assemblers.has(key)) {
				assemblers.set(key, createAssembler({
					multiline: def.multiline,
					flushMs: def.flush_ms,
					maxLine: def.max_line,
					stripAnsi: def.strip_ansi,
					onRecord: (raw) => {
						emit(raw, key === "" ? undefined : key);
					}
				}));
			}

			return assemblers.get(key);
		};

		const onLine = (line) => {
			entry.stats.lines++;

			if (!demuxRe) {
				assemblerFor("").push(line);
				return;
			}

			const m = demuxRe.exec(line);

			if (!m) {
				assemblerFor("").push(line);
				return;
			}

			const value = m.groups ? Object.values(m.groups)[0] : (m[1] !== undefined ? m[1] : m[0]);
			const rest = def.demux.strip ? line.slice(0, m.index) + line.slice(m.index + m[0].length) : line;
			assemblerFor(String(value)).push(rest);
		};

		const splitter = createLineSplitter((line) => {
			onLine(line);
		}, def.max_line);

		return {
			push: (chunk) => {
				entry.stats.bytes += chunk.length;
				splitter.push(chunk);
			},
			pushLine: onLine,
			end: () => {
				splitter.end();
				assemblers.forEach((assembler) => {
					assembler.flush();
				});
			}
		};
	};

	const killTree = (child) => {
		if (!child || child.exitCode !== null) {
			return;
		}

		try {
			process.kill(-child.pid, "SIGTERM");
		} catch (e) {
			try {
				child.kill("SIGTERM");
			} catch (e2) {
				// already gone
			}
		}
	};

	const startProcess = (entry, command) => {
		const stream = makeStream(entry);
		const child = childProcess.spawn("sh", ["-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true
		});

		entry.child = child;
		entry.state = "running";
		entry.startedAt = now();
		entry.pid = child.pid;
		entry.stderrTail = "";

		child.stdout.on("data", stream.push);
		child.stderr.on("data", (chunk) => {
			entry.stderrTail = (entry.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
			stream.push(chunk);
		});

		child.on("error", (error) => {
			entry.state = "error";
			entry.error = error.message;
			status(entry, "error", { error: error.message });
		});

		child.on("exit", (code, signal) => {
			stream.end();
			entry.child = null;

			if (entry.stopping) {
				entry.state = "stopped";
				return;
			}

			entry.state = "exited";
			entry.exitCode = code;
			entry.error = code ? "exit code " + code + (entry.stderrTail ? ": " + entry.stderrTail.trim().split("\n").slice(-3).join(" | ") : "") : null;
			status(entry, "exited", { code, signal, ran_ms: now() - entry.startedAt, stderr_tail: entry.stderrTail.trim().split("\n").slice(-5).join("\n") || undefined });

			if (entry.def.restart) {
				const ranLong = now() - entry.startedAt > STABLE_RUN_MS;
				entry.backoff = ranLong ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, (entry.backoff || BACKOFF_MIN_MS / 2) * 2);
				entry.restartTimer = setTimeout(() => {
					entry.restarts++;
					status(entry, "restarting", { restarts: entry.restarts });
					startProcess(entry, command);
				}, entry.backoff);
				entry.restartTimer.unref();
			}
		});
	};

	const startListener = (entry) => {
		const def = entry.def;
		const server = net.createServer((socket) => {
			entry.connections++;
			const peer = socket.remoteAddress ? socket.remoteAddress + ":" + socket.remotePort : "local#" + entry.connections;
			const stream = makeStream(entry, { peer });
			socket.on("data", stream.push);
			socket.on("end", stream.end);
			socket.on("error", () => {
				stream.end();
			});
		});

		server.on("error", (error) => {
			entry.state = "error";
			entry.error = error.message;
			status(entry, "error", { error: error.message });
		});

		if (def.type === "unix") {
			try {
				if (fs.statSync(def.path).isSocket()) {
					fs.unlinkSync(def.path);
				}
			} catch (e) {
				// no stale socket
			}

			server.listen(def.path, () => {
				entry.state = "running";
				status(entry, "listening", { path: def.path });
			});
		} else {
			server.listen(def.port, def.host || "127.0.0.1", () => {
				entry.state = "running";
				status(entry, "listening", { port: server.address().port });
			});
		}

		entry.server = server;
		entry.startedAt = now();
	};

	const shellQuote = (text) => {
		return "'" + String(text).replace(/'/g, "'\\''") + "'";
	};

	const start = (entry) => {
		const def = entry.def;
		entry.stopping = false;

		if (def.type === "command") {
			startProcess(entry, def.command);
		} else if (def.type === "file") {
			startProcess(entry, "exec tail -F -n " + (def.from_start ? "+1" : "0") + " " + shellQuote(def.path));
		} else if (def.type === "tcp" || def.type === "unix") {
			startListener(entry);
		} else {
			entry.state = "running";
			entry.startedAt = now();
			entry.ingestStream = makeStream(entry);
		}
	};

	const stop = (entry) => {
		entry.stopping = true;
		clearTimeout(entry.restartTimer);
		killTree(entry.child);

		if (entry.server) {
			entry.server.close();
			entry.server = null;

			if (entry.def.type === "unix") {
				try {
					fs.unlinkSync(entry.def.path);
				} catch (e) {
					// already gone
				}
			}
		}

		if (entry.ingestStream) {
			entry.ingestStream.end();
		}

		entry.state = "stopped";
	};

	const manager = {
		/**
		 * Add and start a source.
		 * @param {object} input source definition
		 * @param {{ viaTool?: boolean }} [context] viaTool: added by the agent/UI (subject to --no-commands)
		 */
		add: (input, context) => {
			const def = normalise(input);
			const viaTool = context && context.viaTool;

			if (viaTool && !options.allowCommands && def.type === "command") {
				throw new Error("Adding command sources through tools is disabled (--no-commands)");
			}

			if (sources.has(def.name)) {
				manager.remove(def.name);
			}

			const entry = {
				def,
				state: "starting",
				restarts: 0,
				connections: 0,
				error: null,
				stats: { lines: 0, records: 0, bytes: 0, last: null, labels: new Map() }
			};

			sources.set(def.name, entry);

			if (context && context.paused) {
				entry.state = "paused";
				status(entry, "paused", { type: def.type });
				return def;
			}

			start(entry);
			status(entry, "added", { type: def.type });
			return def;
		},

		remove: (name) => {
			const entry = sources.get(name);

			if (!entry) {
				return false;
			}

			stop(entry);
			sources.delete(name);
			return true;
		},

		restart: (name) => {
			const entry = sources.get(name);

			if (!entry) {
				throw new Error("No source named " + name);
			}

			stop(entry);
			entry.restarts++;
			start(entry);
			return true;
		},

		/** Start a paused source (persisted command sources load paused). */
		resume: (name) => {
			const entry = sources.get(name);

			if (!entry) {
				throw new Error("No source named " + name);
			}

			if (entry.state !== "paused" && entry.state !== "stopped" && entry.state !== "exited") {
				return false;
			}

			start(entry);
			status(entry, "started", { type: entry.def.type });
			return true;
		},

		has: (name) => {
			return sources.has(name);
		},

		get: (name) => {
			return sources.get(name) || null;
		},

		/** Push lines (the ingest tool). Creates an ingest source on demand. */
		ingest: (lines, sourceName, labels) => {
			const name = sourceName || "ingest";
			let entry = sources.get(name);

			if (!entry) {
				manager.add({ name, type: "ingest", labels: labels || {}, origin: "runtime" });
				entry = sources.get(name);
			}

			if (!entry.ingestStream) {
				throw new Error("Source " + name + " is a " + entry.def.type + " source; ingest only pushes into ingest sources");
			}

			const list = Array.isArray(lines) ? lines : String(lines).split("\n");
			list.forEach((line) => {
				entry.stats.bytes += line.length + 1;
				entry.ingestStream.pushLine(line);
			});
			entry.ingestStream.end();
			return list.length;
		},

		defs: () => {
			return Array.from(sources.values()).map((entry) => {
				return entry.def;
			});
		},

		list: () => {
			return Array.from(sources.values()).map((entry) => {
				const out = {
					name: entry.def.name,
					type: entry.def.type,
					state: entry.state,
					origin: entry.def.origin,
					lines: entry.stats.lines,
					records: entry.stats.records,
					bytes: entry.stats.bytes,
					last_record: entry.stats.last ? new Date(entry.stats.last).toISOString() : null,
					restarts: entry.restarts,
					error: entry.error || undefined,
					pid: entry.child ? entry.child.pid : undefined,
					target: entry.def.command || entry.def.path || (entry.def.port ? (entry.def.host || "127.0.0.1") + ":" + entry.def.port : undefined)
				};

				if (entry.stats.labels.size) {
					out.streams = Array.from(entry.stats.labels.entries()).map((pair) => {
						return { label: pair[0], records: pair[1].records, last_record: new Date(pair[1].last).toISOString() };
					}).sort((a, b) => {
						return b.records - a.records;
					}).slice(0, 50);
					out.stream_count = entry.stats.labels.size;
				}

				return out;
			});
		},

		/**
		 * Activity per source and per demuxed stream ("name" and "name:label"),
		 * filtered by a glob. Used by source_silent alarms.
		 */
		activity: (pattern) => {
			const out = [];
			sources.forEach((entry, name) => {
				if (entry.def.type === "ingest") {
					return;
				}

				if (globMatch(pattern, name)) {
					out.push({ source: name, last: entry.stats.last, started: entry.startedAt || null });
				}

				entry.stats.labels.forEach((labelStats, label) => {
					const key = name + ":" + label;

					if (globMatch(pattern, key)) {
						out.push({ source: key, last: labelStats.last, started: labelStats.first });
					}
				});
			});

			return out;
		},

		stopAll: () => {
			sources.forEach((entry) => {
				stop(entry);
			});
		}
	};

	return manager;
};

module.exports = {
	createSources,
	normalise,
	serialise,
	TYPES
};
