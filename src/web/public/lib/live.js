import { state, toast } from "@nemanjan00/qrp-shadcdn";
import { openStream, getMeta } from "./api.js";
import { refresh, go } from "./view.js";

/*
 * Live server state from SSE: stats every 2s, toasts for alarms and source
 * failures, and a definitions revision that pages read to refetch.
 */

export const live = state({
	connected: false,
	stats: null,
	readOnly: false,
	version: "",
	defRev: 0,
	queueRev: 0
});

const DEF_REFRESH_DEBOUNCE_MS = 300;

export const startLive = () => {
	getMeta().then((meta) => {
		live.readOnly = !!meta.read_only;
		live.version = meta.version;
	}).catch(() => {});

	let defTimer = null;
	const bumpDefinitions = () => {
		clearTimeout(defTimer);
		defTimer = setTimeout(() => {
			live.defRev++;
			refresh();
		}, DEF_REFRESH_DEBOUNCE_MS);
	};

	openStream({
		hello: (data) => {
			live.connected = true;
			live.readOnly = !!data.read_only;
		},
		stats: (data) => {
			live.stats = Object.freeze(data);
		},
		alarm: (firing) => {
			toast.warning("Alarm " + firing.alarm, {
				description: firing.text + (firing.message ? " (" + firing.message + ")" : ""),
				duration: 10000,
				action: {
					label: "View",
					onClick: () => {
						const t = Date.parse(firing.t);
						go("discover", "", { c: firing.classifier || "", from: t - 300000, to: t + 60000, refresh: 0 });
					}
				}
			});
		},
		source: (change) => {
			if (change.change === "exited" || change.change === "error") {
				toast.error("Source " + change.source + " " + change.change, { description: change.error || change.stderr_tail || "" });
			}
		},
		definitions: bumpDefinitions,
		queue: () => {
			live.queueRev++;
		},
		cluster: () => {
			live.queueRev++;
		}
	}, {
		onOpen: () => {
			live.connected = true;
		},
		onError: () => {
			live.connected = false;
		}
	});
};
