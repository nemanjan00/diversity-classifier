/*
 * Ingest-time redaction (SPEC.md §10.2). Applied to every record before
 * classification, so secrets never reach clusters, events, examples,
 * notifications or the web UI.
 */

const MASK = "[REDACTED]";

const BUILTINS = {
	bearer: {
		description: "Bearer/Token credentials (Authorization headers, curl -H)",
		re: /(\b(?:Bearer|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
		replace: "$1" + MASK
	},
	basic_auth: {
		description: "Basic auth header values",
		re: /(\bBasic\s+)[A-Za-z0-9+/=]{8,}/g,
		replace: "$1" + MASK
	},
	url_credentials: {
		description: "user:password@ in URLs",
		re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
		replace: "$1" + MASK + "@"
	},
	secret_kv: {
		description: "password=…, secret: …, token=…, api_key=…, access_key=… pairs",
		re: /(\b(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}]+)/gi,
		replace: "$1" + MASK
	},
	jwt: {
		description: "JSON Web Tokens",
		re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g,
		replace: MASK
	},
	private_key_block: {
		description: "PEM private key blocks",
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replace: MASK
	}
};

const createRedaction = () => {
	const state = {
		enabled: true,
		builtin: Object.keys(BUILTINS),
		patterns: [],
		compiled: [],
		redacted: 0
	};

	const compile = () => {
		const builtins = state.builtin.map((name) => {
			return BUILTINS[name];
		});
		const custom = state.patterns.map((source) => {
			return { re: new RegExp(source, "g"), replace: MASK };
		});
		state.compiled = builtins.concat(custom);
	};

	compile();

	const redaction = {
		/** Redact a text. Returns the same string when nothing matched. */
		apply: (text) => {
			if (!state.enabled || !state.compiled.length || typeof text !== "string") {
				return text;
			}

			const out = state.compiled.reduce((acc, rule) => {
				rule.re.lastIndex = 0;
				return acc.replace(rule.re, rule.replace);
			}, text);

			if (out !== text) {
				state.redacted++;
			}

			return out;
		},

		/**
		 * @param {{ enabled?: boolean, builtin?: string[], patterns?: string[] }} change
		 */
		configure: (change) => {
			const c = change || {};

			if (c.builtin !== undefined) {
				const unknown = [].concat(c.builtin).filter((name) => {
					return !BUILTINS[name];
				});

				if (unknown.length) {
					throw new Error("Unknown builtin redaction(s): " + unknown.join(", ") + ". Known: " + Object.keys(BUILTINS).join(", "));
				}

				state.builtin = [].concat(c.builtin);
			}

			if (c.patterns !== undefined) {
				[].concat(c.patterns).forEach((source) => {
					try {
						new RegExp(source, "g");
					} catch (e) {
						throw new Error("Invalid redaction pattern " + source + ": " + e.message);
					}
				});
				state.patterns = [].concat(c.patterns);
			}

			if (c.enabled !== undefined) {
				state.enabled = !!c.enabled;
			}

			compile();
			return redaction.settings();
		},

		settings: () => {
			return {
				enabled: state.enabled,
				builtin: state.builtin.slice(),
				patterns: state.patterns.slice(),
				records_redacted: state.redacted
			};
		},

		/** Persistable form; null when everything is default. */
		persistent: () => {
			const isDefault = state.enabled && state.patterns.length === 0 &&
				state.builtin.length === Object.keys(BUILTINS).length;
			return isDefault ? null : { enabled: state.enabled, builtin: state.builtin.slice(), patterns: state.patterns.slice() };
		},

		reset: () => {
			state.enabled = true;
			state.builtin = Object.keys(BUILTINS);
			state.patterns = [];
			compile();
		},

		BUILTINS
	};

	return redaction;
};

/** Replace each value's occurrences in `text` with the mask. */
const maskValues = (text, values) => {
	return values.reduce((acc, value) => {
		const needle = String(value);

		if (!needle || needle === MASK) {
			return acc;
		}

		return acc.split(needle).join(MASK);
	}, text);
};

module.exports = {
	createRedaction,
	maskValues,
	BUILTINS,
	MASK
};
