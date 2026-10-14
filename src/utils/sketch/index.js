const GAMMA = 1.04;
const LOG_GAMMA = Math.log(GAMMA);

/**
 * Log-bucket quantile sketch (DDSketch-like): ~2% relative error, memory grows
 * with log(range), not with sample count. Tracks exact count/min/max/sum.
 */
const createSketch = () => {
	const state = {
		positive: new Map(),
		negative: new Map(),
		zero: 0,
		count: 0,
		sum: 0,
		min: Infinity,
		max: -Infinity
	};

	const bucketOf = (v) => {
		return Math.ceil(Math.log(v) / LOG_GAMMA);
	};

	const valueOf = (index) => {
		return 2 * Math.pow(GAMMA, index) / (GAMMA + 1);
	};

	const sketch = {
		add: (value) => {
			if (typeof value !== "number" || !isFinite(value)) {
				return;
			}

			state.count++;
			state.sum += value;
			state.min = Math.min(state.min, value);
			state.max = Math.max(state.max, value);

			if (value > 1e-9) {
				const i = bucketOf(value);
				state.positive.set(i, (state.positive.get(i) || 0) + 1);
			} else if (value < -1e-9) {
				const i = bucketOf(-value);
				state.negative.set(i, (state.negative.get(i) || 0) + 1);
			} else {
				state.zero++;
			}
		},

		quantile: (q) => {
			if (state.count === 0) {
				return null;
			}

			const rank = q * (state.count - 1);
			const negatives = Array.from(state.negative.entries()).sort((a, b) => {
				return b[0] - a[0];
			}).map((pair) => {
				return [-valueOf(pair[0]), pair[1]];
			});
			const positives = Array.from(state.positive.entries()).sort((a, b) => {
				return a[0] - b[0];
			}).map((pair) => {
				return [valueOf(pair[0]), pair[1]];
			});
			const ordered = negatives.concat(state.zero ? [[0, state.zero]] : [], positives);

			let seen = 0;
			const found = ordered.find((pair) => {
				seen += pair[1];
				return seen > rank;
			});
			const value = found ? found[0] : state.max;

			return Math.min(state.max, Math.max(state.min, value));
		},

		summary: () => {
			if (state.count === 0) {
				return { count: 0 };
			}

			return {
				count: state.count,
				min: state.min,
				max: state.max,
				sum: state.sum,
				avg: state.sum / state.count,
				p50: sketch.quantile(0.5),
				p90: sketch.quantile(0.9),
				p99: sketch.quantile(0.99)
			};
		},

		/** Log-scale buckets as [{ from, to, count }] for histograms. */
		buckets: () => {
			const negatives = Array.from(state.negative.entries()).map((pair) => {
				return { from: -Math.pow(GAMMA, pair[0]), to: -Math.pow(GAMMA, pair[0] - 1), count: pair[1] };
			});
			const positives = Array.from(state.positive.entries()).map((pair) => {
				return { from: Math.pow(GAMMA, pair[0] - 1), to: Math.pow(GAMMA, pair[0]), count: pair[1] };
			});
			const zero = state.zero ? [{ from: 0, to: 0, count: state.zero }] : [];

			return negatives.concat(zero, positives).sort((a, b) => {
				return a.from - b.from;
			});
		}
	};

	return sketch;
};

module.exports = {
	createSketch
};
