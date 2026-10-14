/**
 * Fixed-capacity FIFO. Pushing past capacity evicts the oldest item.
 * Items can be removed out of order with `remove` (marks them, compacts lazily).
 *
 * @param {number} capacity
 * @param {{ onEvict?: function }} [options]
 */
const createRingBuffer = (capacity, options) => {
	const onEvict = (options && options.onEvict) || null;

	const state = {
		items: new Array(Math.max(1, capacity)),
		head: 0,
		size: 0,
		removed: new Set()
	};

	const at = (i) => {
		return state.items[(state.head + i) % state.items.length];
	};

	const ring = {
		capacity: () => {
			return state.items.length;
		},

		length: () => {
			return state.size - state.removed.size;
		},

		push: (item) => {
			if (state.size === state.items.length) {
				ring.shift();
			}

			state.items[(state.head + state.size) % state.items.length] = item;
			state.size++;
		},

		shift: () => {
			if (state.size === 0) {
				return undefined;
			}

			const item = state.items[state.head];
			state.items[state.head] = undefined;
			state.head = (state.head + 1) % state.items.length;
			state.size--;

			if (state.removed.has(item)) {
				state.removed.delete(item);
				return ring.shift();
			}

			if (onEvict) {
				onEvict(item);
			}

			return item;
		},

		/** Oldest live item. */
		peek: () => {
			for (let i = 0; i < state.size; i++) {
				const item = at(i);

				if (!state.removed.has(item)) {
					return item;
				}
			}

			return undefined;
		},

		remove: (item) => {
			state.removed.add(item);

			if (state.removed.size > state.size / 2) {
				ring.compact();
			}
		},

		compact: () => {
			const live = ring.toArray();
			state.items = new Array(state.items.length);
			state.head = 0;
			state.size = 0;
			state.removed = new Set();
			live.forEach((item) => {
				state.items[state.size++] = item;
			});
		},

		/** Oldest to newest. */
		toArray: () => {
			const out = [];

			for (let i = 0; i < state.size; i++) {
				const item = at(i);

				if (!state.removed.has(item)) {
					out.push(item);
				}
			}

			return out;
		},

		forEach: (fn) => {
			ring.toArray().forEach(fn);
		},

		clear: () => {
			state.items = new Array(state.items.length);
			state.head = 0;
			state.size = 0;
			state.removed = new Set();
		}
	};

	return ring;
};

module.exports = {
	createRingBuffer
};
