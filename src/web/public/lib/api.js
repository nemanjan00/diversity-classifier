/*
 * REST client for the tool mirror (POST /api/<tool>) and the SSE stream.
 * A token given as #token=... on first load is kept in sessionStorage.
 */

const TOKEN_KEY = "dc-token";

const readToken = () => {
	const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);

	if (m) {
		const token = decodeURIComponent(m[1]);

		try {
			sessionStorage.setItem(TOKEN_KEY, token);
		} catch (e) {
			// storage unavailable: keep it in memory only
		}

		history.replaceState(null, "", location.pathname + location.search);
		return token;
	}

	try {
		return sessionStorage.getItem(TOKEN_KEY);
	} catch (e) {
		return null;
	}
};

const token = readToken();

const headers = () => {
	const out = { "content-type": "application/json" };

	if (token) {
		out.authorization = "Bearer " + token;
	}

	return out;
};

/**
 * Call a tool. Resolves to its JSON result (frozen, so qrp state never proxies it).
 * @param {string} tool
 * @param {object} [args]
 */
export const api = (tool, args) => {
	return fetch("/api/" + tool, { method: "POST", headers: headers(), body: JSON.stringify(args || {}) })
		.then((response) => {
			return response.json().then((body) => {
				if (!response.ok) {
					throw new Error(body && body.error ? body.error : "HTTP " + response.status);
				}

				return Object.freeze(body);
			});
		});
};

export const getMeta = () => {
	return fetch("/api/meta", { headers: headers() }).then((response) => {
		if (!response.ok) {
			throw new Error("HTTP " + response.status);
		}

		return response.json();
	});
};

/**
 * Open the SSE stream.
 * @param {Object<string, function(object): void>} handlers by event name
 * @param {{ onOpen?: function(): void, onError?: function(): void }} [status]
 */
export const openStream = (handlers, status) => {
	const url = "/api/events/stream" + (token ? "?token=" + encodeURIComponent(token) : "");
	const source = new EventSource(url);

	Object.keys(handlers).forEach((name) => {
		source.addEventListener(name, (message) => {
			let data = null;

			try {
				data = JSON.parse(message.data);
			} catch (e) {
				return;
			}

			handlers[name](data);
		});
	});

	if (status && status.onOpen) {
		source.addEventListener("open", status.onOpen);
	}

	if (status && status.onError) {
		source.addEventListener("error", status.onError);
	}

	return source;
};
