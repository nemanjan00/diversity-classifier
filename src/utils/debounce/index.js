/**
 * Debounce with a maximum wait: fires `quietMs` after the last trigger, but no
 * later than `maxWaitMs` after the first trigger of a burst.
 *
 * @param {function} fn
 * @param {{ quietMs: number, maxWaitMs?: number }} options
 */
const debounce = (fn, options) => {
	const state = {
		quietTimer: null,
		maxTimer: null,
		quietMs: options.quietMs,
		maxWaitMs: options.maxWaitMs || 0
	};

	const fire = () => {
		clearTimeout(state.quietTimer);
		clearTimeout(state.maxTimer);
		state.quietTimer = null;
		state.maxTimer = null;
		fn();
	};

	const trigger = () => {
		clearTimeout(state.quietTimer);
		state.quietTimer = setTimeout(fire, state.quietMs);

		if (state.quietTimer.unref) {
			state.quietTimer.unref();
		}

		if (state.maxWaitMs && !state.maxTimer) {
			state.maxTimer = setTimeout(fire, state.maxWaitMs);

			if (state.maxTimer.unref) {
				state.maxTimer.unref();
			}
		}
	};

	trigger.flush = () => {
		if (state.quietTimer || state.maxTimer) {
			fire();
		}
	};

	trigger.cancel = () => {
		clearTimeout(state.quietTimer);
		clearTimeout(state.maxTimer);
		state.quietTimer = null;
		state.maxTimer = null;
	};

	trigger.configure = (next) => {
		if (next.quietMs !== undefined) {
			state.quietMs = next.quietMs;
		}

		if (next.maxWaitMs !== undefined) {
			state.maxWaitMs = next.maxWaitMs;
		}
	};

	return trigger;
};

module.exports = {
	debounce
};
