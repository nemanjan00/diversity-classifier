#!/usr/bin/env node

/*
 * Synthetic logs for a fictional web shop: HTTP access lines, a database
 * pool, background workers, payments, auth, cache stats, scheduler noise and
 * a few message kinds nobody has classified yet (including stack traces).
 *
 * Usage: node scripts/demo/generate.js [--backfill 45m] [--rate 20]
 *   --backfill  emit this much history first (timestamps in the past), then go live
 *   --rate      live lines per second (default 20)
 */

const parseDuration = require("../../src/utils/units").parseDuration;
const parseArgs = require("util").parseArgs;

const PATHS = ["/api/products", "/api/products/{id}", "/api/cart", "/api/cart/items", "/api/checkout", "/api/orders/{id}", "/api/search", "/health"];
const PATH_WEIGHTS = [20, 30, 12, 8, 4, 6, 15, 5];
const METHODS = { "/api/cart/items": "POST", "/api/checkout": "POST" };
const JOB_TYPES = ["email", "thumbnail", "invoice", "reindex"];
const DECLINE_CODES = ["card_declined", "card_declined", "insufficient_funds", "expired_card", "processing_error"];
const WORKERS = 4;

const options = parseArgs({
	args: process.argv.slice(2),
	options: {
		backfill: { type: "string" },
		rate: { type: "string" }
	}
}).values;

const state = { seed: 42, jobs: [] };

/** Small deterministic PRNG so screenshots are reproducible. */
const random = () => {
	state.seed = (state.seed * 1664525 + 1013904223) % 4294967296;
	return state.seed / 4294967296;
};

const pick = (list, weights) => {
	if (!weights) {
		return list[Math.floor(random() * list.length)];
	}

	const total = weights.reduce((a, b) => {
		return a + b;
	}, 0);
	let roll = random() * total;
	return list.find((_item, i) => {
		roll -= weights[i];
		return roll <= 0;
	}) || list[list.length - 1];
};

const hex = (n) => {
	let out = "";

	for (let i = 0; i < n; i++) {
		out += Math.floor(random() * 16).toString(16);
	}

	return out;
};

const level = (name) => {
	return name.padEnd(5, " ");
};

const line = (t, lvl, logger, msg) => {
	return new Date(t).toISOString() + " " + level(lvl) + " [" + logger + "] " + msg;
};

/** Latency drifts over time and spikes during an "incident" window. */
const latency = (t, path) => {
	const minute = t / 60000;
	const base = path === "/api/search" ? 80 : (path === "/api/checkout" ? 140 : 25);
	const wave = 1 + 0.5 * Math.sin(minute / 4);
	const incident = Math.floor(minute) % 30 >= 18 && Math.floor(minute) % 30 < 22 ? 6 : 1;
	return Math.round(base * wave * incident * (0.4 + random() * 1.4) + random() * 10);
};

const httpLine = (t) => {
	const route = pick(PATHS, PATH_WEIGHTS);
	const path = route.replace("{id}", String(Math.floor(random() * 5000)));
	const took = latency(t, route);
	const minute = Math.floor(t / 60000);
	const incident = minute % 30 >= 18 && minute % 30 < 22;
	const errorRate = incident ? 0.12 : 0.01;
	const status = random() < errorRate ? pick([500, 502, 503, 503]) : (random() < 0.04 ? 404 : (METHODS[route] ? 201 : 200));
	const bytes = Math.floor(200 + random() * 9000);
	return line(t, status >= 500 ? "ERROR" : "INFO", "http", (METHODS[route] || "GET") + " " + path + " " + status + " took=" + took + "ms bytes=" + bytes + " user=u" + Math.floor(random() * 900 + 100));
};

const stackTrace = (t) => {
	return [
		line(t, "ERROR", "api", "unhandled error: TypeError: Cannot read properties of undefined (reading 'price')"),
		"    at applyDiscount (/srv/shop/src/cart/discounts.js:" + Math.floor(40 + random() * 20) + ":17)",
		"    at Cart.total (/srv/shop/src/cart/index.js:88:12)",
		"    at async checkout (/srv/shop/src/routes/checkout.js:31:5)"
	];
};

/** Lines for one tick at time t. */
const tick = (t) => {
	const out = [];
	const minute = Math.floor(t / 60000);
	const incident = minute % 30 >= 18 && minute % 30 < 22;

	out.push(httpLine(t));

	if (random() < 0.5) {
		out.push(httpLine(t));
	}

	if (random() < 0.08) {
		const worker = 1 + Math.floor(random() * WORKERS);
		const id = "job-" + hex(6);
		const type = pick(JOB_TYPES);
		out.push(line(t, "INFO", "worker-" + worker, "job start id=" + id + " type=" + type));
		state.jobs.push({ worker, id, type, due: t + Math.floor(200 + random() * (type === "reindex" ? 9000 : 2500)) });
	}

	state.jobs = state.jobs.filter((job) => {
		if (job.due > t) {
			return true;
		}

		const took = ((job.due - t) / 1000 + (job.type === "reindex" ? 6 : 1.2) * (0.5 + random())).toFixed(2);
		out.push(line(job.due, "INFO", "worker-" + job.worker, "job done id=" + job.id + " type=" + job.type + " took=" + took + "s"));
		return false;
	});

	if (random() < (incident ? 0.15 : 0.01)) {
		out.push(line(t, "WARN", "db", "pool exhausted waiting=" + Math.floor(1 + random() * (incident ? 30 : 4)) + " max=20"));
	}

	if (random() < 0.02) {
		out.push(line(t, "ERROR", "payments", "charge failed order=ord-" + hex(8) + " amount=" + (random() * 200 + 5).toFixed(2) + " code=" + pick(DECLINE_CODES)));
	}

	if (random() < 0.015) {
		out.push(line(t, "WARN", "auth", "login failed user=u" + Math.floor(random() * 900 + 100) + " ip=203.0.113." + Math.floor(random() * 250) + " reason=" + pick(["bad_password", "bad_password", "locked", "mfa_timeout"])));
	}

	if (random() < 0.03) {
		out.push(line(t, "INFO", "cache", "stats hit_ratio=" + (incident ? 0.55 + random() * 0.2 : 0.9 + random() * 0.08).toFixed(3) + " keys=" + Math.floor(10000 + random() * 500)));
	}

	if (random() < 0.05) {
		out.push(line(t, "DEBUG", "scheduler", "tick queue=" + Math.floor(random() * 5)));
	}

	if (random() < 0.006) {
		out.push(line(t, "WARN", "gc", "pause " + Math.floor(50 + random() * 400) + "ms heap=" + Math.floor(300 + random() * 700) + "MB"));
	}

	if (random() < 0.003) {
		out.push(line(t, "WARN", "kafka", "consumer group shop-events rebalancing generation=" + Math.floor(random() * 90)));
	}

	if (random() < (incident ? 0.01 : 0.002)) {
		Array.prototype.push.apply(out, stackTrace(t));
	}

	if (random() < 0.001) {
		out.push(line(t, "WARN", "tls", "certificate for shop.example.com expires in " + Math.floor(5 + random() * 20) + " days"));
	}

	return out;
};

const write = (lines) => {
	return new Promise((resolve) => {
		if (process.stdout.write(lines.join("\n") + "\n")) {
			resolve();
			return;
		}

		process.stdout.once("drain", resolve);
	});
};

const backfillMs = options.backfill ? parseDuration(options.backfill) : 0;
const rate = Number(options.rate || 20);
const stepMs = Math.round(1000 / rate * 1.5);

const backfill = () => {
	const end = Date.now();
	let t = end - backfillMs;
	let batch = [];

	while (t < end) {
		batch = batch.concat(tick(t));
		t += stepMs;
	}

	return write(batch);
};

const live = () => {
	setInterval(() => {
		write(tick(Date.now()));
	}, stepMs);
};

process.stdout.on("error", () => {
	process.exit(0);
});

backfill().then(live);
