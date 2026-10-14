const createSketch = require("../index").createSketch;
const createTopK = require("../../top-k").createTopK;

describe("sketch", () => {
	test("quantiles within ~5% relative error", () => {
		const sketch = createSketch();

		for (let i = 1; i <= 10000; i++) {
			sketch.add(i);
		}

		const summary = sketch.summary();
		expect(summary.count).toBe(10000);
		expect(summary.min).toBe(1);
		expect(summary.max).toBe(10000);
		expect(Math.abs(summary.p50 - 5000) / 5000).toBeLessThan(0.05);
		expect(Math.abs(summary.p99 - 9900) / 9900).toBeLessThan(0.05);
	});

	test("handles zero and negatives", () => {
		const sketch = createSketch();
		[-10, -1, 0, 0, 1, 10].forEach(sketch.add);
		expect(sketch.summary().min).toBe(-10);
		expect(sketch.quantile(0.5)).toBe(0);
		expect(sketch.buckets().length).toBeGreaterThan(2);
	});
});

describe("top-k", () => {
	test("keeps heavy hitters exactly when they dominate", () => {
		const topK = createTopK(3);

		for (let i = 0; i < 100; i++) {
			topK.add("a");
		}

		for (let i = 0; i < 50; i++) {
			topK.add("b");
		}

		for (let i = 0; i < 20; i++) {
			topK.add("noise-" + i);
		}

		const top = topK.top(2);
		expect(top[0].value).toBe("a");
		expect(top[0].count).toBe(100);
		expect(top[1].value).toBe("b");
		expect(topK.total()).toBe(170);
	});
});
