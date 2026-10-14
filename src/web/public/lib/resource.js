import { state, effect, batch } from "@nemanjan00/qrp-shadcdn";

/**
 * Reactive async data: re-runs `fetcher` whenever the state it reads changes
 * (it must read its dependencies synchronously, before returning the promise).
 * Stale responses are dropped. Returning null/undefined clears the data.
 *
 * @param {function(): ?Promise<*>} fetcher
 * @returns {{ data: *, error: ?string, loading: boolean }}
 */
export const resource = (fetcher) => {
	const r = state({ data: null, error: null, loading: true });
	let seq = 0;

	effect(() => {
		let promise = null;
		const mine = ++seq;

		try {
			promise = fetcher();
		} catch (e) {
			batch(() => {
				r.error = e.message;
				r.loading = false;
			});
			return;
		}

		if (!promise) {
			batch(() => {
				r.data = null;
				r.loading = false;
			});
			return;
		}

		r.loading = true;
		promise
			.then((data) => {
				if (mine !== seq) {
					return;
				}

				batch(() => {
					r.data = data;
					r.error = null;
					r.loading = false;
				});
			})
			.catch((error) => {
				if (mine !== seq) {
					return;
				}

				batch(() => {
					r.error = error.message;
					r.loading = false;
				});
			});
	});

	return r;
};
