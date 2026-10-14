/**
 * Per-second counters over a sliding window, for "last N seconds" rates.
 * @param {number} windowS
 */
const createRateCounter = (windowS) => {
	const buckets = new Map();

	const prune = (nowS) => {
		if (buckets.size <= windowS) {
			return;
		}

		buckets.forEach((_count, second) => {
			if (second <= nowS - windowS) {
				buckets.delete(second);
			}
		});
	};

	return {
		add: (t, n) => {
			const second = Math.floor(t / 1000);
			buckets.set(second, (buckets.get(second) || 0) + (n || 1));
			prune(Math.floor(Date.now() / 1000));
		},

		/** Total within the last `seconds`. */
		sum: (seconds) => {
			const cutoff = Math.floor(Date.now() / 1000) - Math.min(seconds, windowS);
			let total = 0;
			buckets.forEach((count, second) => {
				if (second > cutoff) {
					total += count;
				}
			});

			return total;
		}
	};
};

module.exports = {
	createRateCounter
};
