import { el } from "@nemanjan00/qrp-shadcdn";
import { formatNumber, formatTime } from "./view.js";

/*
 * Small inline-SVG chart kit: time bars/lines with brush-zoom, terms bars and
 * numeric histograms with click-to-filter, heatmap, sparkline. Bars are drawn
 * in a 1000-wide viewBox stretched to the container; labels are HTML so they
 * do not distort.
 */

const W = 1000;
const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)",
	"oklch(65% .15 200)", "oklch(60% .2 330)", "oklch(70% .12 120)", "oklch(55% .05 250)"];

export const colorFor = (index) => {
	return PALETTE[index % PALETTE.length];
};

const svg = (height, children, extra) => {
	return el("svg", Object.assign({
		viewBox: "0 0 " + W + " " + height,
		preserveAspectRatio: "none",
		class: "dc-svg",
		style: "height:" + height + "px"
	}, extra || {}), ...children);
};

const fraction = (event, node) => {
	const rect = node.getBoundingClientRect();
	return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
};

/**
 * Time chart (stacked bars, lines or areas) with tooltip and drag-to-zoom.
 * @param {{ times: number[], interval: number, series: Array<{ key: string, values: number[] }>,
 *   from?: number, to?: number, retainedSince?: ?string, type?: "bar"|"line"|"area", height?: number,
 *   onBrush?: function(number, number): void, onSeries?: function(string): void }} opts
 */
export const timeChart = (opts) => {
	const height = opts.height || 140;
	const type = opts.type || "bar";
	const times = opts.times || [];
	const series = opts.series || [];
	const interval = opts.interval || 60000;
	const from = opts.from !== undefined ? opts.from : (times[0] || Date.now() - 3600000);
	const to = opts.to !== undefined ? Math.max(opts.to, from + interval) : (times.length ? times[times.length - 1] + interval : Date.now());
	const span = Math.max(1, to - from);
	const xOf = (t) => {
		return (t - from) / span * W;
	};
	const totals = times.map((_t, i) => {
		return series.reduce((acc, s) => {
			return acc + (s.values[i] || 0);
		}, 0);
	});
	const maxY = Math.max(1, type === "bar" ? Math.max.apply(null, totals.concat([0])) : Math.max.apply(null, series.reduce((acc, s) => {
		return acc.concat(s.values.map((v) => {
			return v || 0;
		}));
	}, [0])));
	const yOf = (v) => {
		return height - (v / maxY) * (height - 6);
	};

	const shapes = [];
	const retained = opts.retainedSince ? Date.parse(opts.retainedSince) : null;

	if (retained && retained > from) {
		shapes.push(el("rect", { x: 0, y: 0, width: Math.min(W, xOf(retained)), height, class: "dc-shade" }));
	}

	if (type === "bar") {
		const barW = Math.max(1, interval / span * W * 0.85);
		times.forEach((t, i) => {
			let base = 0;
			series.forEach((s, si) => {
				const v = s.values[i] || 0;

				if (!v) {
					return;
				}

				const y0 = yOf(base);
				const y1 = yOf(base + v);
				shapes.push(el("rect", { x: xOf(t), y: y1, width: barW, height: Math.max(0.5, y0 - y1), fill: colorFor(si) }));
				base += v;
			});
		});
	} else {
		series.forEach((s, si) => {
			const segments = times.reduce((acc, t, i) => {
				const v = s.values[i];

				if (v === null || v === undefined) {
					if (acc[acc.length - 1].length) {
						acc.push([]);
					}

					return acc;
				}

				acc[acc.length - 1].push((xOf(t + interval / 2)).toFixed(1) + "," + yOf(v).toFixed(1));
				return acc;
			}, [[]]).filter((segment) => {
				return segment.length;
			});

			segments.forEach((points) => {
				if (type === "area") {
					const first = points[0].split(",")[0];
					const last = points[points.length - 1].split(",")[0];
					shapes.push(el("polygon", { points: first + "," + height + " " + points.join(" ") + " " + last + "," + height, fill: colorFor(si), "fill-opacity": "0.25" }));
				}

				if (points.length === 1) {
					const xy = points[0].split(",");
					shapes.push(el("circle", { cx: xy[0], cy: xy[1], r: "3", fill: colorFor(si) }));
					return;
				}

				shapes.push(el("polyline", { points: points.join(" "), fill: "none", stroke: colorFor(si), "stroke-width": "2", "vector-effect": "non-scaling-stroke" }));
			});
		});
	}

	const tooltip = el("div", { class: "dc-tooltip", style: "display:none" });
	const brush = el("div", { class: "dc-brush", style: "display:none" });
	const plot = el("div", { class: "dc-plot" }, svg(height, shapes), brush, tooltip);
	const drag = { start: null };

	const indexAt = (f) => {
		const t = from + f * span;
		return times.findIndex((bucket) => {
			return t >= bucket && t < bucket + interval;
		});
	};

	plot.addEventListener("pointermove", (event) => {
		const f = fraction(event, plot);

		if (drag.start !== null) {
			const a = Math.min(drag.start, f);
			const b = Math.max(drag.start, f);
			brush.style.display = "block";
			brush.style.left = (a * 100) + "%";
			brush.style.width = ((b - a) * 100) + "%";
		}

		const i = indexAt(f);

		if (i === -1) {
			tooltip.style.display = "none";
			return;
		}

		const rows = series.filter((s) => {
			return s.values[i];
		}).map((s) => {
			const si = series.indexOf(s);
			return el("div", { class: "dc-tooltip-row" },
				el("span", { class: "dc-swatch", style: "background:" + colorFor(si) }),
				el("span", { class: "dc-tooltip-key" }, s.key),
				el("b", {}, formatNumber(s.values[i])));
		});
		tooltip.replaceChildren(el("div", { class: "dc-tooltip-title" }, formatTime(times[i]) + (type === "bar" && series.length > 1 ? "  Σ " + formatNumber(totals[i]) : "")), ...rows);
		tooltip.style.display = "block";
		tooltip.style.left = Math.min(f * 100, 75) + "%";
	});

	plot.addEventListener("pointerleave", () => {
		tooltip.style.display = "none";
	});

	if (opts.onBrush) {
		plot.classList.add("dc-brushable");
		plot.addEventListener("pointerdown", (event) => {
			drag.start = fraction(event, plot);
			plot.setPointerCapture(event.pointerId);
			event.preventDefault();
		});
		plot.addEventListener("pointerup", (event) => {
			if (drag.start === null) {
				return;
			}

			const end = fraction(event, plot);
			const a = Math.min(drag.start, end);
			const b = Math.max(drag.start, end);
			drag.start = null;
			brush.style.display = "none";

			if (b - a > 0.01) {
				opts.onBrush(from + a * span, from + b * span);
			}
		});
	}

	const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
		return el("span", { class: "dc-tick", style: "left:" + (f * 100) + "%" }, formatTime(from + f * span));
	});

	const legend = series.length > 1 ? el("div", { class: "dc-legend" }, ...series.map((s, si) => {
		return el("button", {
			class: "dc-legend-item",
			type: "button",
			title: opts.onSeries ? "Filter to " + s.key : s.key,
			onclick: () => {
				if (opts.onSeries) {
					opts.onSeries(s.key);
				}
			}
		}, el("span", { class: "dc-swatch", style: "background:" + colorFor(si) }), s.key);
	})) : null;

	return el("div", { class: "dc-chart" },
		el("div", { class: "dc-ymax" }, formatNumber(maxY)),
		plot,
		el("div", { class: "dc-axis" }, ...ticks),
		retained && retained > from ? el("div", { class: "dc-shade-note" }, "shaded: older than retained events (aggregates only)") : null,
		legend);
};

/**
 * Horizontal terms bars with +/− filter buttons.
 * @param {{ values: Array<{ value: *, count: number, pct?: number }>, onFilter?: function(*, boolean): void,
 *   colorIndex?: number }} opts
 */
export const termsBars = (opts) => {
	const values = opts.values || [];
	const max = Math.max(1, Math.max.apply(null, values.map((v) => {
		return v.count;
	}).concat([0])));

	return el("div", { class: "dc-terms" }, ...values.map((entry) => {
		const label = entry.value === "" ? "(empty)" : String(entry.value);
		return el("div", { class: "dc-term", title: label },
			el("button", {
				type: "button",
				class: "dc-term-main",
				onclick: () => {
					if (opts.onFilter) {
						opts.onFilter(entry.value, false);
					}
				}
			},
			el("span", { class: "dc-term-bar", style: "width:" + (entry.count / max * 100) + "%;background:" + colorFor(opts.colorIndex || 0) }),
			el("span", { class: "dc-term-label" }, label),
			el("span", { class: "dc-term-count" }, formatNumber(entry.count) + (entry.pct !== undefined ? " · " + entry.pct + "%" : ""))),
			opts.onFilter ? el("span", { class: "dc-term-actions" },
				el("button", { type: "button", class: "dc-mini", title: "Filter for value", onclick: () => {
					opts.onFilter(entry.value, false);
				} }, "+"),
				el("button", { type: "button", class: "dc-mini", title: "Filter out value", onclick: () => {
					opts.onFilter(entry.value, true);
				} }, "−")) : null);
	}));
};

/**
 * Numeric histogram; clicking a bucket filters to its range.
 * @param {{ buckets: Array<{ from: number, to: number, count: number }>, onRange?: function(number, number): void,
 *   height?: number }} opts
 */
export const numericBars = (opts) => {
	const buckets = (opts.buckets || []).filter((b) => {
		return b.count > 0 || (opts.buckets || []).length <= 40;
	});
	const height = opts.height || 100;

	if (!buckets.length) {
		return el("div", { class: "dc-empty-chart" }, "no data");
	}

	const max = Math.max.apply(null, buckets.map((b) => {
		return b.count;
	}));
	const barW = W / buckets.length;
	const tooltip = el("div", { class: "dc-tooltip", style: "display:none" });
	const rects = buckets.map((b, i) => {
		const h = b.count / max * (height - 4);
		const rect = el("rect", {
			x: i * barW + barW * 0.08,
			y: height - h,
			width: barW * 0.84,
			height: Math.max(h, b.count ? 1 : 0),
			fill: colorFor(0),
			class: opts.onRange ? "dc-clickable" : ""
		});

		rect.addEventListener("mouseenter", () => {
			tooltip.replaceChildren("[" + formatNumber(b.from) + ", " + formatNumber(b.to) + ")  " + formatNumber(b.count));
			tooltip.style.display = "block";
			tooltip.style.left = Math.min(i / buckets.length * 100, 70) + "%";
		});

		if (opts.onRange) {
			rect.addEventListener("click", () => {
				opts.onRange(b.from, b.to);
			});
		}

		return rect;
	});

	const plot = el("div", { class: "dc-plot" }, svg(height, rects), tooltip);
	plot.addEventListener("mouseleave", () => {
		tooltip.style.display = "none";
	});

	return el("div", { class: "dc-chart" },
		plot,
		el("div", { class: "dc-axis dc-axis-ends" },
			el("span", {}, formatNumber(buckets[0].from)),
			el("span", {}, formatNumber(buckets[buckets.length - 1].to))));
};

/**
 * Heatmap of a numeric field over time.
 * @param {{ times: number[], bounds: number[], cells: Array<number[]>, interval: number, height?: number }} opts
 */
export const heatmapChart = (opts) => {
	const times = opts.times || [];
	const bounds = opts.bounds || [];
	const rows = Math.max(1, bounds.length - 1);
	const height = opts.height || 120;

	if (!times.length || !opts.cells || !opts.cells.length) {
		return el("div", { class: "dc-empty-chart" }, "no numeric data");
	}

	const max = Math.max.apply(null, opts.cells.map((cell) => {
		return cell[2];
	}));
	const cw = W / times.length;
	const ch = height / rows;
	const rects = opts.cells.map((cell) => {
		return el("rect", {
			x: cell[0] * cw,
			y: height - (cell[1] + 1) * ch,
			width: cw,
			height: ch,
			fill: colorFor(0),
			"fill-opacity": String(0.15 + 0.85 * (cell[2] / max))
		});
	});

	return el("div", { class: "dc-chart" },
		el("div", { class: "dc-ymax" }, formatNumber(bounds[bounds.length - 1])),
		el("div", { class: "dc-plot" }, svg(height, rects)),
		el("div", { class: "dc-axis dc-axis-ends" },
			el("span", {}, formatTime(times[0])),
			el("span", {}, "min " + formatNumber(bounds[0]) + (opts.scale === "log" ? " · log scale" : "")),
			el("span", {}, formatTime(times[times.length - 1]))));
};

/** Tiny sparkline. */
export const sparkline = (values, opts) => {
	const o = opts || {};
	const width = o.width || 100;
	const height = o.height || 22;
	const data = values && values.length ? values : [0];
	const max = Math.max(1, Math.max.apply(null, data));
	const step = data.length > 1 ? width / (data.length - 1) : width;
	const points = data.map((v, i) => {
		return (i * step).toFixed(1) + "," + (height - 1 - (v / max) * (height - 2)).toFixed(1);
	}).join(" ");

	return el("svg", { viewBox: "0 0 " + width + " " + height, class: "dc-spark", style: "width:" + width + "px;height:" + height + "px" },
		el("polyline", { points, fill: "none", stroke: colorFor(o.color || 0), "stroke-width": "1.5" }));
};
