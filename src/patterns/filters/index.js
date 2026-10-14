const units = require("../../utils/units");

/*
 * Converter pipeline steps, applied after a capture matched and its type
 * converted it: {status:word|int}, {svc:word|lower|map(a=api,b=auth)}.
 * Returning undefined rejects the match.
 */

const filters = {
	lower: () => {
		return (value) => {
			return typeof value === "string" ? value.toLowerCase() : value;
		};
	},
	upper: () => {
		return (value) => {
			return typeof value === "string" ? value.toUpperCase() : value;
		};
	},
	trim: () => {
		return (value) => {
			return typeof value === "string" ? value.trim() : value;
		};
	},
	int: () => {
		return (value) => {
			const n = parseInt(value, 10);
			return isNaN(n) ? undefined : n;
		};
	},
	float: () => {
		return (value) => {
			const n = parseFloat(value);
			return isNaN(n) ? undefined : n;
		};
	},
	duration: () => {
		return (value) => {
			return units.parseDuration(value);
		};
	},
	bytes: () => {
		return (value) => {
			return units.parseBytes(value);
		};
	},
	timestamp: () => {
		return (value) => {
			return units.parseTimestamp(value);
		};
	},
	/** ms → seconds (for a value already in ms) */
	s: () => {
		return (value) => {
			return typeof value === "number" ? value / 1000 : value;
		};
	},
	/** seconds → ms */
	ms: () => {
		return (value) => {
			return typeof value === "number" ? value * 1000 : value;
		};
	},
	map: (args) => {
		const table = {};
		args.forEach((pair) => {
			const eq = pair.indexOf("=");

			if (eq === -1) {
				throw new Error("map() entries must be key=value, got: " + pair);
			}

			table[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
		});

		return (value) => {
			const key = String(value);
			return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : value;
		};
	},
	default: (args) => {
		return (value) => {
			if (value === undefined || value === null || value === "") {
				return args[0];
			}

			return value;
		};
	},
	truncate: (args) => {
		const n = parseInt(args[0], 10);

		if (isNaN(n)) {
			throw new Error("truncate() needs a length");
		}

		return (value) => {
			return typeof value === "string" ? value.slice(0, n) : value;
		};
	}
};

const NUMERIC_FILTERS = ["int", "float", "duration", "bytes", "timestamp", "s", "ms"];

module.exports = {
	filters,
	NUMERIC_FILTERS
};
