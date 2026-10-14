const debounce = require("../utils/debounce").debounce;
const createRingBuffer = require("../utils/ring-buffer").createRingBuffer;

const KINDS = ["unclassified", "alarm", "source", "definitions"];
const HISTORY = 200;

/*
 * Notification delivery (SPEC.md §9). Sinks (MCP channel + logging, web SSE)
 * receive every non-muted note. Unclassified digests are debounced; alarms
 * and source/definition changes go out immediately.
 */

/**
 * @param {{ quietMs: number, maxWaitMs: number, growthFactor?: number }} options
 */
const createNotifier = (options) => {
	const sinks = new Set();
	const history = createRingBuffer(HISTORY);
	const settings = {
		muted: new Set(),
		quietMs: options.quietMs,
		maxWaitMs: options.maxWaitMs,
		growthFactor: options.growthFactor || 10
	};
	const state = { digestBuilder: null };

	const deliver = (note) => {
		history.push(note);
		sinks.forEach((sink) => {
			try {
				sink(note);
			} catch (e) {
				process.stderr.write("[notifier] sink failed: " + e.message + "\n");
			}
		});
	};

	const digest = debounce(() => {
		if (!state.digestBuilder || settings.muted.has("unclassified")) {
			return;
		}

		const note = state.digestBuilder(settings);

		if (note) {
			deliver(Object.assign({ t: new Date().toISOString() }, note));
		}
	}, { quietMs: settings.quietMs, maxWaitMs: settings.maxWaitMs });

	const notifier = {
		addSink: (sink) => {
			sinks.add(sink);
			return () => {
				sinks.delete(sink);
			};
		},

		/** @param {{ kind: string, level: string, content: string, meta?: object }} note */
		notify: (note) => {
			if (settings.muted.has(note.kind)) {
				return;
			}

			deliver(Object.assign({ t: new Date().toISOString() }, note));
		},

		/** Register the function that builds the digest note when the debounce fires. */
		setDigestBuilder: (builder) => {
			state.digestBuilder = builder;
		},

		/** Something happened in the unclassified queue. */
		touchDigest: () => {
			if (!settings.muted.has("unclassified")) {
				digest();
			}
		},

		flushDigest: () => {
			digest.flush();
		},

		/**
		 * @param {{ mute?: string[], unmute?: string[], quiet_ms?: number, max_wait_ms?: number, growth_factor?: number }} change
		 */
		configure: (change) => {
			[].concat(change.mute || []).forEach((kind) => {
				if (KINDS.indexOf(kind) === -1) {
					throw new Error("Unknown notification kind '" + kind + "'. Kinds: " + KINDS.join(", "));
				}

				settings.muted.add(kind);
			});
			[].concat(change.unmute || []).forEach((kind) => {
				settings.muted.delete(kind);
			});

			if (change.quiet_ms !== undefined) {
				settings.quietMs = change.quiet_ms;
			}

			if (change.max_wait_ms !== undefined) {
				settings.maxWaitMs = change.max_wait_ms;
			}

			if (change.growth_factor !== undefined) {
				settings.growthFactor = Math.max(1.1, change.growth_factor);
			}

			digest.configure({ quietMs: settings.quietMs, maxWaitMs: settings.maxWaitMs });
			return notifier.settings();
		},

		settings: () => {
			return {
				muted: Array.from(settings.muted),
				quiet_ms: settings.quietMs,
				max_wait_ms: settings.maxWaitMs,
				growth_factor: settings.growthFactor
			};
		},

		history: (limit) => {
			return history.toArray().slice(-(limit || 50)).reverse();
		},

		stop: () => {
			digest.cancel();
		},

		KINDS
	};

	return notifier;
};

module.exports = {
	createNotifier,
	KINDS
};
