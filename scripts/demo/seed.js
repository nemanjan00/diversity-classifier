#!/usr/bin/env node

/*
 * Teach a running server (web UI enabled) the demo shop logs, the way an
 * agent would: a shared head, an envelope, typed classifiers, alarms,
 * visualizations and a dashboard. Some message kinds are deliberately left
 * unclassified so the queue has something in it.
 *
 * Usage: node scripts/demo/seed.js [http://127.0.0.1:7070] [--demo]
 *   --demo  also start the synthetic log generator as a source afterwards
 */

const DEFAULT_BASE = "http://127.0.0.1:7070";

const STEPS = [
	["define_parser", { name: "head", template: "^{ts:timestamp} {level:level} [{logger:word}]" }],
	["define_classifier", { name: "shop", template: "{...head} {msg:rest}", envelope: true, time_field: "ts", description: "Common line head of the shop service" }],
	["define_classifier", { name: "shop.http", parent: "shop", template: "{method:enum(GET,POST,PUT,DELETE)} {path:path} {status:int} took={took:duration} bytes={bytes:bytes} user={user:word}", description: "HTTP access log" }],
	["define_classifier", { name: "shop.db.pool_exhausted", parent: "shop", template: "pool exhausted waiting={waiting:int} max={max:int}" }],
	["define_classifier", { name: "shop.job.start", parent: "shop", template: "job start id={job:word} type={type:word}" }],
	["define_classifier", { name: "shop.job.done", parent: "shop", template: "job done id={job:word} type={type:word} took={took:duration}" }],
	["define_classifier", { name: "shop.payment.failed", parent: "shop", template: "charge failed order={order:word} amount={amount:float} code={code:word}" }],
	["define_classifier", { name: "shop.auth.failed", parent: "shop", template: "login failed user={user:word} ip={ip:ip} reason={reason:word}" }],
	["define_classifier", { name: "shop.cache.stats", parent: "shop", template: "stats hit_ratio={hit_ratio:float} keys={keys:int}" }],
	["define_classifier", { name: "ignore.scheduler", parent: "shop", template: "tick queue={queue:int}", store: "count", description: "noise" }],
	["define_alarm", { name: "http-5xx-burst", kind: "rate", classifier: "shop.http", q: "status >= 500", params: { count: 20, window: "1m" }, cooldown: "5m", message: "5xx burst" }],
	["define_alarm", { name: "slow-checkout", kind: "threshold", classifier: "shop.http", q: "path:/api/checkout", params: { field: "took", agg: "p90", op: ">", value: 800, window: "5m" }, cooldown: "10m" }],
	["define_alarm", { name: "new-decline-code", kind: "new_value", classifier: "shop.payment.failed", params: { field: "code" }, backfill: true }],
	["define_visualization", { name: "requests-by-status", type: "area", title: "Requests by status", classifier: "shop.http", split_by: "status" }],
	["define_visualization", { name: "latency-heatmap", type: "heatmap", title: "Latency distribution", classifier: "shop.http", field: "took" }],
	["define_visualization", { name: "slowest-paths", type: "table", title: "Slowest paths", classifier: "shop.http", group_by: ["path"], field: "took", agg: "p90" }],
	["define_visualization", { name: "decline-codes", type: "bar", title: "Payment decline codes", classifier: "shop.payment.failed", field: "code" }],
	["define_visualization", { name: "p90-latency", type: "metric", title: "p90 latency", classifier: "shop.http", field: "took", agg: "p90" }],
	["define_visualization", { name: "job-durations", type: "histogram", title: "Job durations", classifier: "shop.job.done", field: "took" }],
	["define_dashboard", {
		name: "shop-overview",
		title: "Shop overview",
		panels: [
			{ visualization: "p90-latency", w: 3 },
			{ visualization: "requests-by-status", w: 9 },
			{ visualization: "latency-heatmap", w: 6 },
			{ visualization: "decline-codes", w: 6 },
			{ visualization: "slowest-paths", w: 6 },
			{ visualization: "job-durations", w: 6 }
		]
	}]
];

const call = (base, tool, body) => {
	return fetch(base + "/api/" + tool, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	}).then((res) => {
		return res.json().then((json) => {
			if (res.status !== 200) {
				throw new Error(tool + " " + body.name + ": " + json.error);
			}

			return json;
		});
	});
};

/** @param {string} [baseUrl] server URL with the web UI enabled */
const run = (baseUrl) => {
	const base = (baseUrl || DEFAULT_BASE).replace(/\/$/, "");

	return STEPS.reduce((chain, step) => {
		return chain.then(() => {
			return call(base, step[0], step[1]).then((result) => {
				const absorbed = result.retro ? " (absorbed " + result.retro.absorbed + ")" : "";
				process.stdout.write(step[0] + " " + step[1].name + absorbed + "\n");
			});
		});
	}, Promise.resolve());
};

/** Start the synthetic generator as a source (after seeding, so its backfill is classified live). */
const addDemoSource = (baseUrl) => {
	const base = (baseUrl || DEFAULT_BASE).replace(/\/$/, "");
	const generator = require("path").join(__dirname, "generate.js");

	return call(base, "add_source", {
		name: "shop",
		type: "command",
		command: "exec " + JSON.stringify(process.execPath) + " " + JSON.stringify(generator) + " --backfill 30m --rate 15",
		multiline: { start: "^\\d{4}-" },
		labels: { env: "demo" }
	}).then(() => {
		process.stdout.write("add_source shop (synthetic logs, 30m backfill)\n");
	});
};

if (require.main === module) {
	const url = process.argv.slice(2).find((arg) => {
		return arg.indexOf("http") === 0;
	});

	run(url).then(() => {
		return process.argv.indexOf("--demo") !== -1 ? addDemoSource(url) : null;
	}).catch((error) => {
		process.stderr.write(error.message + "\n");
		process.exit(1);
	});
}

module.exports = {
	run,
	addDemoSource,
	STEPS
};
