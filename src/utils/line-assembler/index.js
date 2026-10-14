const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g; // eslint-disable-line no-control-regex
const MAX_RECORD_LINES = 500;

/**
 * Split a byte/char stream into lines. Handles \r\n and caps runaway lines.
 * @param {function(string): void} onLine
 * @param {number} maxLine
 */
const createLineSplitter = (onLine, maxLine) => {
	const state = { carry: "" };

	return {
		push: (chunk) => {
			const text = state.carry + chunk.toString("utf8");
			const parts = text.split("\n");
			state.carry = parts.pop();

			parts.forEach((line) => {
				onLine(line.replace(/\r$/, ""));
			});

			if (state.carry.length > maxLine * 4) {
				onLine(state.carry);
				state.carry = "";
			}
		},

		end: () => {
			if (state.carry) {
				onLine(state.carry.replace(/\r$/, ""));
				state.carry = "";
			}
		}
	};
};

/**
 * Join physical lines into logical records (stack traces etc.).
 *
 * @param {{ multiline?: { start?: string, continue?: string }, flushMs?: number, maxLine?: number,
 *   stripAnsi?: boolean, onRecord: function(string): void }} options
 */
const createAssembler = (options) => {
	const multiline = options.multiline || null;
	const startRe = multiline && multiline.start ? new RegExp(multiline.start) : null;
	const continueRe = multiline && multiline.continue ? new RegExp(multiline.continue) : null;
	const maxLine = options.maxLine || 16384;
	const state = { current: null, timer: null };

	const clean = (line) => {
		const stripped = options.stripAnsi === false ? line : line.replace(ANSI_RE, "");
		return stripped.length > maxLine ? stripped.slice(0, maxLine) + "…" : stripped;
	};

	const flush = () => {
		clearTimeout(state.timer);
		state.timer = null;

		if (state.current) {
			const record = state.current.join("\n");
			state.current = null;
			options.onRecord(record.length > maxLine * 4 ? record.slice(0, maxLine * 4) + "…" : record);
		}
	};

	const schedule = () => {
		clearTimeout(state.timer);
		state.timer = setTimeout(flush, options.flushMs || 250);

		if (state.timer.unref) {
			state.timer.unref();
		}
	};

	return {
		push: (line) => {
			const text = clean(line);

			if (!startRe && !continueRe) {
				if (text.trim() !== "") {
					options.onRecord(text);
				}

				return;
			}

			const isContinuation = startRe ? !startRe.test(text) : continueRe.test(text);

			if (isContinuation && state.current && state.current.length < MAX_RECORD_LINES) {
				state.current.push(text);
				schedule();
				return;
			}

			flush();

			if (text.trim() === "") {
				return;
			}

			state.current = [text];
			schedule();
		},

		flush
	};
};

module.exports = {
	createLineSplitter,
	createAssembler,
	ANSI_RE
};
