const DEFAULT_DELAYS_MS = [500, 1500] as const;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	// Promise.withResolvers is unavailable in older Safari releases.
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal?.reason);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Retry safe requests briefly while the hub restarts. */
export async function fetchRetrying(
	input: string,
	init?: RequestInit,
	opts?: { delaysMs?: readonly number[]; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): Promise<Response> {
	const method = (init?.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") return fetch(input, init);

	const delays = opts?.delaysMs ?? DEFAULT_DELAYS_MS;
	const wait = opts?.sleep ?? sleep;
	const signal = init?.signal ?? undefined;
	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await fetch(input, init);
		} catch (error) {
			if (
				signal?.aborted ||
				!(error instanceof TypeError) ||
				error.name === "AbortError" ||
				attempt >= delays.length
			) {
				throw error;
			}
			await wait(delays[attempt], signal);
			if (signal?.aborted) throw signal.reason;
			continue;
		}
		if (
			![502, 503, 504].includes(response.status) ||
			response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json" ||
			attempt >= delays.length ||
			signal?.aborted
		) {
			return response;
		}
		try {
			void response.body?.cancel().catch(() => {});
		} catch {
			// Discarding a failed response must not prevent a retry.
		}
		await wait(delays[attempt], signal);
		if (signal?.aborted) throw signal.reason;
	}
}
