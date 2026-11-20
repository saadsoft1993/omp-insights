import { concreteMachine } from "../app/machine";
/**
 * Live dashboard state streamed from the server (`/api/events`): the data
 * version every query revalidates against, background ingest progress, and
 * the rollup indexing backlog.
 *
 * The state lives in a module store read through narrow selectors, so a
 * progress tick only re-renders what shows progress: `useLiveVersion()` for
 * queries (see `useQuery`), `useLiveStatus()` for the chrome.
 */

import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import * as api from "../api";
import { ALL_MACHINES, machinePath, selection, useSelectedMachine } from "../app/machine";
import { useStatsVersions } from "./fleet-query";
import type { LiveStatus, LiveSyncStatus } from "../types";

/** Ingest status shown by the chrome. */
export interface LiveStatusView {
	sync: LiveSyncStatus;
	/** Hours whose rollups are still being built; wide ranges may be incomplete. */
	indexingHours: number;
	/** The event stream is open. */
	connected: boolean;
	/** When this page last saw an open or a message on the stream, ms; null until the first one. */
	receivedAt: number | null;
	/** Why the hub refused the stream (e.g. too many dashboard tabs), while it is refused. */
	reason: string | null;
	/** Refusals in a row since the stream last opened. */
	failures: number;
	/** The raw reason of the last refusal (the hub's error text), for plain wording; null once open. */
	problem: string | null;
	/** Ask the server to ingest new session data now. */
	requestSync: () => void;
}

const IDLE_SYNC: LiveSyncStatus = {
	phase: "idle",
	current: 0,
	total: 0,
	processed: 0,
	lastSyncedAt: null,
	error: null,
};

function requestSync(): void {
	api.requestSync(concreteMachine()).catch(() => {});
}

let lastServerVersion: number | null = null;
/** Distinct server versions seen (including across server restarts). */
let seenVersions = 0;
/**
 * Client-side data version; bumps whenever the server's version changes.
 * Lags `seenVersions` by one so the first stream message doesn't refetch what
 * just loaded.
 */
let version = 0;
let status: LiveStatusView = {
	sync: IDLE_SYNC,
	indexingHours: 0,
	connected: false,
	receivedAt: null,
	reason: null,
	failures: 0,
	problem: null,
	requestSync,
};
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit(): void {
	for (const listener of listeners) listener();
}

function sameSync(a: LiveSyncStatus, b: LiveSyncStatus): boolean {
	return (
		a.phase === b.phase &&
		a.current === b.current &&
		a.total === b.total &&
		a.processed === b.processed &&
		a.lastSyncedAt === b.lastSyncedAt &&
		a.error === b.error
	);
}

function receive(next: LiveStatus): void {
	if (lastServerVersion !== next.version) {
		lastServerVersion = next.version;
		seenVersions++;
	}
	const nextVersion = Math.max(0, seenVersions - 1);
	const statusChanged = next.indexingHours !== status.indexingHours || !sameSync(next.sync, status.sync);
	if (!statusChanged && nextVersion === version) return;
	version = nextVersion;
	if (statusChanged) status = { ...status, sync: next.sync, indexingHours: next.indexingHours };
	emit();
}

type StreamPatch = Partial<Pick<LiveStatusView, "receivedAt" | "reason" | "failures" | "problem">>;

function setConnected(connected: boolean, patch: StreamPatch = {}): void {
	const next = { ...status, connected, ...patch };
	if (
		next.connected === status.connected &&
		next.receivedAt === status.receivedAt &&
		next.reason === status.reason &&
		next.failures === status.failures &&
		next.problem === status.problem
	)
		return;
	status = next;
	emit();
}

const getStatus = (): LiveStatusView => status;
const getVersion = (): number => version;
const getDisabledVersion = (): number => -1;

/**
 * A new stream (another machine, or the same one reopened) counts versions from scratch: forgetting the last
 * server version makes its first message read as a bump, so queries revalidate once against the new stream.
 */
function resetStream(): void {
	lastServerVersion = null;
	status = {
		...status,
		sync: IDLE_SYNC,
		indexingHours: 0,
		receivedAt: null,
		reason: null,
		failures: 0,
		problem: null,
	};
}

/** EventSource.CLOSED; read as a number so a test double without the static still works. */
export const CLOSED = 2;

export const TOO_MANY_STREAMS = "too many dashboard tabs open; close some tabs";

/** Hub refusing a stream for capacity: wait at least this long before asking again. */
export const TOO_MANY_STREAMS_RETRY_MS = 30_000;

/** Back-off before reopening a refused stream: 30 s for capacity, otherwise 2 s doubling up to 30 s. */
export function retryDelay(refusal: string | null, failures: number): number {
	if (refusal === "too_many_streams") return TOO_MANY_STREAMS_RETRY_MS;
	return Math.min(2_000 * 2 ** Math.max(0, failures - 1), 30_000);
}

/** A refusal probe that has not answered by then counts as an ordinary refusal. */
export const REFUSAL_PROBE_TIMEOUT_MS = 5_000;

/** The owner went away (unmount, another machine): the caller must not schedule a retry. */
export const PROBE_CANCELLED = Symbol("probe cancelled");

/**
 * Why the hub refused a stream: EventSource hides the response, so ask once with fetch and read the error code
 * of a 503 (`{"code":"too_many_streams"}`). The request is aborted as soon as the headers arrive, after 5 s
 * (null: an ordinary refusal), or when `owner` aborts ({@link PROBE_CANCELLED}).
 */
export interface StreamRefusal {
	/** The hub's error code (`too_many_streams`), if it gave one. */
	code: string | null;
	/** The hub's error text, or what went wrong asking; null when nothing is known. */
	message: string | null;
}

export async function streamRefusal(url: string, owner: AbortSignal): Promise<StreamRefusal | typeof PROBE_CANCELLED> {
	if (owner.aborted) return PROBE_CANCELLED;
	const controller = new AbortController();
	const cancel = () => controller.abort();
	owner.addEventListener("abort", cancel, { once: true });
	const { promise: deadline, resolve: expire } = Promise.withResolvers<StreamRefusal>();
	const timer = setTimeout(() => {
		controller.abort();
		expire({ code: null, message: "no answer in time" });
	}, REFUSAL_PROBE_TIMEOUT_MS);
	const probe = (async (): Promise<StreamRefusal> => {
		try {
			const response = await fetch(url, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
			if (response.ok) return { code: null, message: null };
			const body = (await response.json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
			return {
				code: typeof body?.code === "string" ? body.code : null,
				message: typeof body?.error === "string" ? body.error : `HTTP error ${response.status}`,
			};
		} catch (error) {
			return { code: null, message: error instanceof Error ? error.message : null };
		}
	})();
	try {
		const refusal = await Promise.race([probe, deadline]);
		return owner.aborted ? PROBE_CANCELLED : refusal;
	} finally {
		clearTimeout(timer);
		owner.removeEventListener("abort", cancel);
		controller.abort();
	}
}

/** Current data version, read outside render (e.g. when a fetch starts). */
export function currentLiveVersion(): number {
	return version;
}

/** Owns the `/api/events` stream of the selected machine; mount once at the app root. */
export function LiveProvider({ children }: { children: ReactNode }) {
	const machine = useSelectedMachine();
	useStatsVersions(machine === ALL_MACHINES);
	useEffect(() => {
		// A child can select a different machine while this render is committing.
		if (selection() !== machine) return;
		if (machine === ALL_MACHINES) {
			setConnected(false);
			return;
		}
		resetStream();
		const url = machinePath("/api/events", machine);
		let source: EventSource | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let failures = 0;
		let stopped = false;
		const owner = new AbortController();
		const open = () => {
			timer = null;
			const current = new EventSource(url);
			source = current;
			current.onopen = () => {
				failures = 0;
				setConnected(true, { receivedAt: Date.now(), reason: null, failures: 0, problem: null });
			};
			current.onerror = () => {
				setConnected(false);
				// A dropped connection reconnects by itself; a refused one (HTTP error) is closed for good, so
				// find out why and reopen after a back-off instead of staying dead until a reload.
				if (current.readyState !== CLOSED) return;
				current.close();
				if (source === current) source = null;
				void streamRefusal(url, owner.signal).then(refusal => {
					if (refusal === PROBE_CANCELLED || stopped || source || timer) return;
					failures++;
					setConnected(false, {
						reason: refusal.code === "too_many_streams" ? TOO_MANY_STREAMS : null,
						failures,
						problem: refusal.message,
					});
					timer = setTimeout(open, retryDelay(refusal.code, failures));
				});
			};
			current.onmessage = event => {
				setConnected(true, { receivedAt: Date.now(), reason: null, failures: 0, problem: null });
				receive(JSON.parse(event.data) as LiveStatus);
			};
		};
		open();
		return () => {
			stopped = true;
			owner.abort();
			source?.close();
			if (timer) clearTimeout(timer);
			setConnected(false);
		};
	}, [machine]);
	return children;
}

/** Ingest status for the chrome; data-version bumps alone don't re-render. */
export function useLiveStatus(): LiveStatusView {
	return useSyncExternalStore(subscribe, getStatus);
}

/**
 * Data version for queries. Disabled (hidden) consumers read a constant -1 so
 * live traffic never re-renders them.
 */
export function useLiveVersion(enabled = true): number {
	return useSyncExternalStore(subscribe, enabled ? getVersion : getDisabledVersion);
}
