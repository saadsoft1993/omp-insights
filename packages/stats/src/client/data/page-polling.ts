import { useSyncExternalStore } from "react";

/**
 * Which enabled queries re-ask on a timer right now. Kept-alive hidden pages disable their queries, so this
 * describes the page on screen: whether its numbers refresh by themselves, and how often.
 */
const polling = new Map<symbol, number>();
const listeners = new Set<() => void>();
let shortest: number | null = null;

function changed(): void {
	const next = polling.size ? Math.min(...polling.values()) : null;
	if (next === shortest) return;
	shortest = next;
	for (const listener of listeners) listener();
}

/** Note an enabled query polling every `ms`; the returned function removes it. */
export function registerPolling(ms: number): () => void {
	const id = Symbol("poll");
	polling.set(id, ms);
	changed();
	return () => {
		polling.delete(id);
		changed();
	};
}

/** The shortest refresh interval among the page's enabled queries, or null when nothing refreshes by itself. */
export function pagePollMs(): number | null {
	return shortest;
}

export function usePagePollMs(): number | null {
	return useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, pagePollMs);
}
