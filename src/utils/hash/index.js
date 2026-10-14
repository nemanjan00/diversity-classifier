/** FNV-1a 32-bit → 8 hex chars. Stable short ids for clusters. */
const shortHash = (text) => {
	let h = 0x811c9dc5;

	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}

	return (h >>> 0).toString(16).padStart(8, "0");
};

module.exports = {
	shortHash
};
