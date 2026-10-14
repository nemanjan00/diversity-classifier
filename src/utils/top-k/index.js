/**
 * Space-Saving top-K counter: bounded memory, approximate counts for heavy
 * hitters. `error` is the max overcount of an entry.
 */
const createTopK = (k) => {
	const state = {
		counts: new Map(),
		total: 0,
		distinct: 0
	};

	const topK = {
		add: (value, n) => {
			const key = String(value);
			const by = n || 1;
			state.total += by;
			const entry = state.counts.get(key);

			if (entry) {
				entry.count += by;
				return;
			}

			state.distinct++;

			if (state.counts.size < k) {
				state.counts.set(key, { count: by, error: 0 });
				return;
			}

			let minKey = null;
			let minEntry = null;

			state.counts.forEach((candidate, candidateKey) => {
				if (!minEntry || candidate.count < minEntry.count) {
					minEntry = candidate;
					minKey = candidateKey;
				}
			});

			state.counts.delete(minKey);
			state.counts.set(key, { count: minEntry.count + by, error: minEntry.count });
		},

		top: (limit) => {
			return Array.from(state.counts.entries())
				.map((pair) => {
					return { value: pair[0], count: pair[1].count, error: pair[1].error };
				})
				.sort((a, b) => {
					return b.count - a.count;
				})
				.slice(0, limit || k);
		},

		has: (value) => {
			return state.counts.has(String(value));
		},

		total: () => {
			return state.total;
		},

		/** Upper bound: counts every first sighting, including evicted ones seen again. */
		distinct: () => {
			return state.distinct;
		}
	};

	return topK;
};

module.exports = {
	createTopK
};
