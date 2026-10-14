const createRingBuffer = require("../index").createRingBuffer;

describe("ring buffer", () => {
	test("evicts oldest past capacity and reports it", () => {
		const evicted = [];
		const ring = createRingBuffer(3, {
			onEvict: (item) => {
				evicted.push(item);
			}
		});
		[1, 2, 3, 4, 5].forEach((n) => {
			ring.push({ n });
		});

		expect(ring.toArray().map((item) => {
			return item.n;
		})).toEqual([3, 4, 5]);
		expect(evicted.map((item) => {
			return item.n;
		})).toEqual([1, 2]);
	});

	test("remove takes items out of the middle; removed items are not reported as evicted", () => {
		const evicted = [];
		const ring = createRingBuffer(4, {
			onEvict: (item) => {
				evicted.push(item.n);
			}
		});
		const items = [1, 2, 3, 4].map((n) => {
			return { n };
		});
		items.forEach(ring.push);
		ring.remove(items[0]);
		ring.remove(items[2]);

		expect(ring.length()).toBe(2);
		expect(ring.peek().n).toBe(2);
		ring.push({ n: 5 });
		ring.push({ n: 6 });
		ring.push({ n: 7 });
		expect(ring.toArray().map((item) => {
			return item.n;
		})).toEqual([4, 5, 6, 7]);
		expect(evicted).toEqual([2]);
	});
});
