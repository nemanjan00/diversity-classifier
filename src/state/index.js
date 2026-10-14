const fs = require("fs");
const path = require("path");
const debounce = require("../utils/debounce").debounce;

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 200;
const WATCH_DEBOUNCE_MS = 300;
const SECTIONS = ["parsers", "classifiers", "alarms", "sources", "visualizations", "dashboards"];

/*
 * Layered persistence (SPEC.md §12): a global file (shared parsers / heads)
 * and a project file, later layer overriding earlier by name. Writes are
 * debounced and atomic; external edits are picked up through fs.watch.
 */

const empty = () => {
	return {
		version: VERSION,
		parsers: [],
		classifiers: [],
		alarms: [],
		sources: [],
		visualizations: [],
		dashboards: [],
		notifications: null,
		redaction: null,
		alarm_state: {}
	};
};

const readFile = (file) => {
	let text = null;

	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (e.code === "ENOENT") {
			return { data: null, text: null };
		}

		throw e;
	}

	if (text.trim() === "") {
		return { data: null, text };
	}

	const data = JSON.parse(text);

	if (data.version && data.version > VERSION) {
		throw new Error(file + " was written by a newer version (" + data.version + ")");
	}

	return { data: Object.assign(empty(), data), text };
};

const writeAtomic = (file, text) => {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	const tmp = file + ".tmp-" + process.pid;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
};

/**
 * @param {{ projectFile: string, globalFile: ?string, onExternalChange: function(): void, log?: function(string): void }} options
 */
const createState = (options) => {
	const files = { project: options.projectFile, global: options.globalFile || null };
	const written = { project: null, global: null };
	const log = options.log || (() => {});
	const state = { snapshot: null, watchers: [], pendingWatch: new Set(), watching: false, broken: new Set() };

	const store = {
		files,

		/**
		 * Load both layers.
		 * @returns {{ layers: Array<{ scope: string, data: object }>, errors: string[] }}
		 */
		load: () => {
			const layers = [];
			const errors = [];
			const broken = [];

			["global", "project"].forEach((scope) => {
				if (!files[scope]) {
					return;
				}

				try {
					const read = readFile(files[scope]);
					written[scope] = read.text;

					if (read.data) {
						layers.push({ scope, data: read.data });
					}
				} catch (e) {
					errors.push(scope + " state (" + files[scope] + "): " + e.message);
					broken.push(scope);
				}
			});

			// A file that does not parse is never overwritten: the user (or an agent)
			// is mid-edit, and the content is theirs. Writes resume once it parses.
			state.broken = new Set(broken);
			return { layers, errors, broken };
		},

		/** Provide a function that returns { project: data, global: data } for saving. */
		setSnapshot: (fn) => {
			state.snapshot = fn;
		},

		save: debounce(() => {
			store.saveNow();
		}, { quietMs: SAVE_DEBOUNCE_MS, maxWaitMs: 2000 }),

		saveNow: () => {
			if (!state.snapshot) {
				return;
			}

			const snapshot = state.snapshot();

			["project", "global"].forEach((scope) => {
				if (!files[scope] || !snapshot[scope]) {
					return;
				}

				if (state.broken.has(scope)) {
					log("not writing " + scope + " state " + files[scope] + ": it does not parse; fix the file and it will be reloaded");
					return;
				}

				const data = snapshot[scope];
				const hasContent = SECTIONS.some((section) => {
					return data[section] && data[section].length;
				}) || (data.notifications && Object.keys(data.notifications).length) || data.redaction || Object.keys(data.alarm_state || {}).length;

				if (!hasContent && written[scope] === null) {
					return;
				}

				const text = JSON.stringify(Object.assign({ version: VERSION }, data), null, "\t") + "\n";

				if (text === written[scope]) {
					return;
				}

				try {
					writeAtomic(files[scope], text);
					written[scope] = text;

					if (state.watching && state.pendingWatch.has(scope)) {
						state.pendingWatch.delete(scope);
						store.watchScopes([scope]);
					}
				} catch (e) {
					log("failed to write " + scope + " state " + files[scope] + ": " + e.message);
				}
			});
		},

		/** Scopes whose file currently fails to parse (writes are suspended). */
		broken: () => {
			return Array.from(state.broken);
		},

		watch: () => {
			state.watching = true;
			store.watchScopes(["project", "global"]);
		},

		/** Watch the directories of the given scopes' files (skips missing directories until first write). */
		watchScopes: (scopes) => {
			const onChange = state.onChange || debounce(() => {
				const changed = ["project", "global"].some((scope) => {
					if (!files[scope]) {
						return false;
					}

					let text = null;

					try {
						text = fs.readFileSync(files[scope], "utf8");
					} catch (e) {
						text = null;
					}

					return text !== null && text !== written[scope];
				});

				if (changed) {
					options.onExternalChange();
				}
			}, { quietMs: WATCH_DEBOUNCE_MS });
			state.onChange = onChange;

			scopes.forEach((scope) => {
				if (!files[scope]) {
					return;
				}

				const dir = path.dirname(path.resolve(files[scope]));
				const base = path.basename(files[scope]);

				if (!fs.existsSync(dir)) {
					state.pendingWatch.add(scope);
					return;
				}

				try {
					const watcher = fs.watch(dir, (_event, name) => {
						if (name === base) {
							onChange();
						}
					});
					watcher.unref();
					state.watchers.push(watcher);
				} catch (e) {
					log("cannot watch " + files[scope] + ": " + e.message);
				}
			});
		},

		close: () => {
			store.save.flush();
			state.watchers.forEach((watcher) => {
				watcher.close();
			});
			state.watchers = [];
		}
	};

	return store;
};

module.exports = {
	createState,
	empty,
	SECTIONS,
	VERSION
};
