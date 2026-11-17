/**
 * Pairing with the omp hub that fronts this dashboard. The hub answers 401 to every API call from a
 * browser it hasn't paired; the first such answer switches the app to the Pair screen.
 */
import { useSyncExternalStore } from "react";

let unpaired = false;
let autoPair = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Called on any 401 from the hub; `auto` is the hub's `autoPair` flag: it pairs owner page navigations itself. */
export function markUnpaired(auto = false): void {
	const changed = auto && !autoPair;
	autoPair ||= auto;
	if (unpaired && !changed) return;
	unpaired = true;
	for (const listener of listeners) listener();
}

/** A hub 401: mark this browser unpaired, remembering whether the hub auto-pairs (its body says `autoPair`). */
export async function noteUnauthorized(res: Response): Promise<void> {
	let auto = false;
	try {
		const body = (await res.clone().json()) as unknown;
		auto = typeof body === "object" && body !== null && "autoPair" in body && body.autoPair === true;
	} catch {
		// Not JSON (or an unclonable response): treated as a hub that does not auto-pair.
	}
	markUnpaired(auto);
}

export function useUnpaired(): boolean {
	return useSyncExternalStore(subscribe, () => unpaired);
}

/** True when the hub auto-pairs: the Pair screen then says to open the app from its icon or home link. */
export function useAutoPair(): boolean {
	return useSyncExternalStore(subscribe, () => autoPair);
}

let pairingError: string | null = null;

/** Message of the last failed pairing attempt, shown on the Pair screen (never reloads the page). */
export function usePairingError(): string | null {
	return useSyncExternalStore(subscribe, () => pairingError);
}

function setPairingError(message: string): void {
	pairingError = message;
	for (const listener of listeners) listener();
}

const PAIR_HASH = /^#pair=([A-Za-z0-9_-]+)$/;

/**
 * The pairing link is `https://<mac>.<tailnet>:8794/#pair=<single-use token>`. Trade the token for the
 * hub's HttpOnly cookie, drop it from the address bar, and reload only once the hub accepted it, so every
 * page and the event stream start over with the cookie. A refused token never reloads: the page would
 * navigate to itself from its own origin, which a hub that auto-pairs would answer with a cookie, so a
 * crafted cross-site link could enrol this browser. The failure is kept for the Pair screen and `onFailure`
 * runs so the app can render in place. Returns false when the location holds no token.
 */
export function redeemPairingLink(onFailure?: () => void): boolean {
	const match = PAIR_HASH.exec(window.location.hash);
	if (!match) return false;
	history.replaceState(null, "", `${window.location.pathname}#/sessions`);
	fetch("/api/hub/pair", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Omp-Hub": "1" },
		body: JSON.stringify({ token: match[1] }),
	})
		.then(async res => {
			if (res.ok) {
				window.location.reload();
				return;
			}
			const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
			throw new Error(typeof body?.error === "string" ? body.error : `HTTP error ${res.status}`);
		})
		.catch((error: unknown) => {
			setPairingError(error instanceof Error ? error.message : String(error));
			onFailure?.();
		});
	return true;
}
