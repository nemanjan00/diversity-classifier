const units = require("../units");
const glob = require("../glob");

const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "regex", "glob", "exists", "contains"];
const LOGICAL = ["and", "or", "not"];

const isOpObject = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => {
		return OPS.indexOf(key) !== -1;
	});
};

/**
 * Convert a literal from a query to the representation of the field it is
 * compared with: "2s" against a duration field becomes 2000, "1MB" against
 * bytes becomes 1e6, ISO strings against timestamps become epoch ms.
 */
const coerceNumeric = (operand, type) => {
	if (typeof operand === "number") {
		return operand;
	}

	if (typeof operand === "boolean") {
		return operand ? 1 : 0;
	}

	const text = String(operand);

	if (type === "duration") {
		return units.parseDuration(text);
	}

	if (type === "bytes") {
		return units.parseBytes(text);
	}

	if (type === "timestamp" || type === "iso8601" || type === "time") {
		return units.parseTime(text);
	}

	if (/^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(text)) {
		return parseFloat(text);
	}

	const asDuration = units.parseDuration(text);

	if (asDuration !== undefined) {
		return asDuration;
	}

	const asBytes = units.parseBytes(text);

	if (asBytes !== undefined) {
		return asBytes;
	}

	return units.parseTime(text);
};

const looseEqual = (value, operand, type) => {
	if (value === undefined || value === null) {
		return operand === null || operand === undefined;
	}

	if (typeof value === "number") {
		return coerceNumeric(operand, type) === value;
	}

	if (typeof value === "boolean") {
		return String(value) === String(operand).toLowerCase();
	}

	return String(value) === String(operand);
};

const compare = (value, operand, type) => {
	if (value === undefined || value === null) {
		return null;
	}

	if (typeof value === "number") {
		const right = coerceNumeric(operand, type);

		if (right === undefined || isNaN(right)) {
			return null;
		}

		return value - right;
	}

	const left = String(value);
	const right = String(operand);

	if (left < right) {
		return -1;
	}

	return left > right ? 1 : 0;
};

const toRegex = (operand) => {
	if (operand instanceof RegExp) {
		return operand;
	}

	if (operand && typeof operand === "object") {
		return new RegExp(operand.source, operand.flags || "");
	}

	const text = String(operand);
	const literal = /^\/(.*)\/([a-z]*)$/s.exec(text);

	if (literal) {
		return new RegExp(literal[1], literal[2]);
	}

	return new RegExp(text);
};

/** Values may be arrays (e.g. classifier path): the predicate holds if any element matches. */
const anyOf = (value, test) => {
	if (Array.isArray(value)) {
		return value.some(test);
	}

	return test(value);
};

const compileOp = (op, operand, type) => {
	switch (op) {
		case "eq":
			return (value) => {
				return anyOf(value, (v) => {
					return looseEqual(v, operand, type);
				});
			};
		case "ne":
			return (value) => {
				return !anyOf(value, (v) => {
					return looseEqual(v, operand, type);
				});
			};
		case "gt":
			return (value) => {
				const c = compare(value, operand, type);
				return c !== null && c > 0;
			};
		case "gte":
			return (value) => {
				const c = compare(value, operand, type);
				return c !== null && c >= 0;
			};
		case "lt":
			return (value) => {
				const c = compare(value, operand, type);
				return c !== null && c < 0;
			};
		case "lte":
			return (value) => {
				const c = compare(value, operand, type);
				return c !== null && c <= 0;
			};
		case "in": {
			const list = [].concat(operand);
			return (value) => {
				return anyOf(value, (v) => {
					return list.some((item) => {
						return looseEqual(v, item, type);
					});
				});
			};
		}
		case "nin": {
			const list = [].concat(operand);
			return (value) => {
				return !anyOf(value, (v) => {
					return list.some((item) => {
						return looseEqual(v, item, type);
					});
				});
			};
		}
		case "regex": {
			const re = toRegex(operand);
			return (value) => {
				return value !== undefined && value !== null && anyOf(value, (v) => {
					return re.test(String(v));
				});
			};
		}
		case "glob": {
			const re = glob.globToRegex(String(operand), "i");
			return (value) => {
				return value !== undefined && value !== null && anyOf(value, (v) => {
					return re.test(String(v));
				});
			};
		}
		case "contains": {
			const needle = String(operand).toLowerCase();
			return (value) => {
				return value !== undefined && value !== null && anyOf(value, (v) => {
					return String(v).toLowerCase().indexOf(needle) !== -1;
				});
			};
		}
		case "exists":
			return (value) => {
				const present = value !== undefined && value !== null;
				return operand === false ? !present : present;
			};
		default:
			throw new Error("Unknown operator: " + op);
	}
};

/**
 * Compile a Mongo-style `where` tree into a predicate.
 *
 * @param {object} where e.g. { status: { gte: 500 }, or: [{ level: "error" }, { took: { gt: "1s" } }] }
 * @param {{ get: function(object, string): *, types?: object }} options
 *   get   - field accessor (record, fieldName) → value
 *   types - fieldName → declared type, used to coerce literals ("2s" → 2000 for durations)
 * @returns {function(object): boolean}
 */
const compileWhere = (where, options) => {
	const get = options.get;
	const types = options.types || {};

	if (!where || (typeof where === "object" && Object.keys(where).length === 0)) {
		return () => {
			return true;
		};
	}

	if (Array.isArray(where)) {
		return compileWhere({ and: where }, options);
	}

	const parts = Object.keys(where).map((key) => {
		const value = where[key];

		if (key === "and") {
			const subs = [].concat(value).map((sub) => {
				return compileWhere(sub, options);
			});
			return (record) => {
				return subs.every((sub) => {
					return sub(record);
				});
			};
		}

		if (key === "or") {
			const subs = [].concat(value).map((sub) => {
				return compileWhere(sub, options);
			});
			return (record) => {
				return subs.some((sub) => {
					return sub(record);
				});
			};
		}

		if (key === "not") {
			const sub = compileWhere(value, options);
			return (record) => {
				return !sub(record);
			};
		}

		const type = types[key];

		if (isOpObject(value)) {
			const tests = Object.keys(value).map((op) => {
				return compileOp(op, value[op], type);
			});
			return (record) => {
				const fieldValue = get(record, key);
				return tests.every((test) => {
					return test(fieldValue);
				});
			};
		}

		const test = compileOp(Array.isArray(value) ? "in" : "eq", value, type);
		return (record) => {
			return test(get(record, key));
		};
	});

	return (record) => {
		return parts.every((part) => {
			return part(record);
		});
	};
};

/** Field names a where tree refers to (for validation / autocomplete). */
const referencedFields = (where) => {
	if (!where || typeof where !== "object") {
		return [];
	}

	if (Array.isArray(where)) {
		return where.reduce((acc, sub) => {
			return acc.concat(referencedFields(sub));
		}, []);
	}

	return Object.keys(where).reduce((acc, key) => {
		if (LOGICAL.indexOf(key) !== -1) {
			return acc.concat(referencedFields(where[key]));
		}

		return acc.concat([key]);
	}, []);
};

module.exports = {
	compileWhere,
	referencedFields,
	coerceNumeric,
	OPS
};
