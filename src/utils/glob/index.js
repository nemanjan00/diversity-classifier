const escapeRegex = (text) => {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
};

const cache = new Map();

/** Glob ("api-*", "http.?") → anchored RegExp. Cached. */
const globToRegex = (pattern, flags) => {
	const key = pattern + "\u0000" + (flags || "");

	if (!cache.has(key)) {
		const source = pattern.split("").map((ch) => {
			if (ch === "*") {
				return ".*";
			}

			if (ch === "?") {
				return ".";
			}

			return escapeRegex(ch);
		}).join("");

		if (cache.size > 1000) {
			cache.clear();
		}

		cache.set(key, new RegExp("^" + source + "$", flags || ""));
	}

	return cache.get(key);
};

const isGlob = (pattern) => {
	return typeof pattern === "string" && /[*?]/.test(pattern);
};

const globMatch = (pattern, value) => {
	if (!isGlob(pattern)) {
		return pattern === value;
	}

	return globToRegex(pattern).test(value);
};

module.exports = {
	escapeRegex,
	globToRegex,
	globMatch,
	isGlob
};
