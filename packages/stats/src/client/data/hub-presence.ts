import { useSyncExternalStore } from "react";
import { noteUnauthorized } from "./pairing";

let present = true;
let probe: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function detectHub(): Promise<void> {
	return (probe ??= (async () => {
		try {
			const response = await fetch("/api/hub/version", { signal: AbortSignal.timeout(30_000) });
			if (response.status === 401) await noteUnauthorized(response);
			if (response.status === 404) {
				present = false;
				for (const listener of listeners) listener();
			}
		} catch {
			// A transient failure is not evidence that the hub is absent.
		}
	})());
}

export function useHubPresent(): boolean {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => present,
	);
}

/** Reset module state for isolated tests. */
export function resetHubForTests(): void {
	present = true;
	probe = undefined;
	for (const listener of listeners) listener();
}
