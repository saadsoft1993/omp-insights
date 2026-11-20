import { useEffect, useRef, useState } from "react";
import { detectFleet, getFleet, machineKey, useFleet } from "../app/machine";
import { usePageActive } from "./page-active";
import { registerPolling } from "./page-polling";

export interface FleetQueryMachine {
	id: string;
	name: string;
	ok: boolean;
	error: string | null;
	stale: boolean;
	/**
	 * A real out-of-date signal: the stats server lacks the endpoint (404) or reports no data version to
	 * `/api/hub/stats-versions`. Timeouts and other failures are not this.
	 */
	outdated: boolean;
	/** The hub is serving this machine's last good answer during its grace period (the fleet list's `stale`). */
	lastKnown: boolean;
}
export interface FleetQueryResult<T> {
	data: T | null;
	machines: FleetQueryMachine[];
	/**
	 * Try again: refreshes the machine list first (a machine back from unreachable is asked too), then asks every
	 * reachable machine, or only `machine` when given. Resolves once the machine-list refresh has finished, timed out
	 * or been superseded (never rejects); the machine requests it starts run on after that.
	 */
	refetch: (machine?: string) => Promise<void>;
	/** A Try again is in progress: the machine list refresh and the requests it started. */
	checking: boolean;
}

type VersionRow = { id: string; ok: boolean; version: number | null; sync?: unknown; indexingHours?: number };
const versions = new Map<string, number | null>();
/** Machines whose stats server answered `/api/status` without a data version: an older stats server. */
const versionless = new Set<string>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
const cache = new Map<string, { data: unknown; revision: number; fetchedAt: number }>();

/** Forget cached machine results between isolated tests. */
export function resetFleetQueryForTests(): void {
	cache.clear();
	versions.clear();
	revisions.clear();
	versionless.clear();
}

export function updateStatsVersions(rows: VersionRow[]): void {
	let changed = false;
	for (const row of rows) {
		const wasVersionless = versionless.has(row.id);
		if (row.ok && (row.version === null || row.version === undefined)) versionless.add(row.id);
		else if (row.ok) versionless.delete(row.id);
		// Subscribers re-read `outdated`: a stats server losing or gaining its version is news on its own.
		if (versionless.has(row.id) !== wasVersionless) changed = true;
		if (!row.ok || row.version === null) continue;
		if (versions.has(row.id) && versions.get(row.id) !== row.version) {
			revisions.set(row.id, (revisions.get(row.id) ?? 0) + 1);
			changed = true;
		}
		versions.set(row.id, row.version);
	}
	if (changed) for (const listener of listeners) listener();
}

export function useStatsVersions(enabled = true): void {
	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		const controller = new AbortController();
		const poll = async () => {
			try {
				const response = await fetch("/api/hub/stats-versions", { signal: controller.signal });
				if (!response.ok) return;
				const data = (await response.json()) as { machines: VersionRow[] };
				if (alive && Array.isArray(data.machines)) updateStatsVersions(data.machines);
			} catch {
				// Keep the last known versions until the hub responds again.
			}
		};
		void poll();
		const timer = setInterval(poll, 5000);
		return () => {
			alive = false;
			controller.abort();
			clearInterval(timer);
		};
	}, [enabled]);
}

export function useFleetQuery<T, R>(
	key: readonly unknown[],
	fetchOne: (machine: string, signal: AbortSignal) => Promise<T>,
	merge: (answers: T[]) => R,
	opts?: { enabled?: boolean; pollMs?: number },
): FleetQueryResult<R> {
	const fleet = useFleet();
	const [tick, setTick] = useState(0);
	const [states, setStates] = useState<
		Record<string, { error: string | null; stale: boolean; missingEndpoint?: boolean }>
	>({});
	const attempts = useRef(new Map<string, number>());
	const retries = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; delay: number }>());
	const retryDelays = useRef(new Map<string, number>());
	const forced = useRef(new Set<string>());
	const [checking, setChecking] = useState(false);
	const pageActive = usePageActive();
	/** Requests a Try again is waiting for; null when none is in progress. */
	const checkingKeys = useRef<Set<string> | null>(null);
	/** The Try again in progress: its machine-list refresh is aborted when the key changes or the page unmounts. */
	const retry = useRef<AbortController | null>(null);
	const cancelRetry = () => {
		retry.current?.abort();
		retry.current = null;
		checkingKeys.current = null;
		setChecking(false);
	};
	const settleChecking = (cacheKey: string) => {
		if (!checkingKeys.current?.delete(cacheKey) || checkingKeys.current.size > 0) return;
		checkingKeys.current = null;
		setChecking(false);
	};
	const active = useRef(new Map<string, { controller: AbortController; revision: number }>());
	const mounted = useRef(true);
	const fetchRef = useRef(fetchOne);
	fetchRef.current = fetchOne;
	const serialized = JSON.stringify(key);
	const machineState = JSON.stringify(fleet?.map(m => [m.id, m.ok]));
	useEffect(() => {
		const changed = () => setTick(n => n + 1);
		listeners.add(changed);
		return () => {
			listeners.delete(changed);
		};
	}, []);
	useEffect(() => {
		if (opts?.enabled === false || !opts?.pollMs) return;
		const unregister = pageActive ? registerPolling(opts.pollMs) : () => {};
		const timer = setInterval(() => setTick(n => n + 1), opts.pollMs);
		return () => {
			clearInterval(timer);
			unregister();
		};
	}, [opts?.enabled, opts?.pollMs, pageActive]);
	// A Try again belongs to the key it was pressed for: a new range or filter (or leaving the page) ends it.
	// cancelRetry only touches refs and a state setter, so it is not a dependency.
	useEffect(() => cancelRetry, [serialized, opts?.enabled]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			retry.current?.abort();
			retry.current = null;
			for (const request of active.current.values()) request.controller.abort();
			active.current.clear();
			retryDelays.current.clear();
			for (const retry of retries.current.values()) clearTimeout(retry.timer);
			retries.current.clear();
			attempts.current.clear();
		};
	}, []);
	useEffect(() => {
		const wanted = new Set(
			opts?.enabled === false
				? []
				: (fleet ?? [])
						.filter(m => m.ok)
						.map(m => JSON.stringify(machineKey(JSON.parse(serialized) as unknown[], m.id))),
		);
		for (const [id, request] of active.current)
			if (!wanted.has(id)) {
				request.controller.abort();
				active.current.delete(id);
				attempts.current.delete(id);
			}
		for (const [id, retry] of retries.current)
			if (!wanted.has(id)) {
				clearTimeout(retry.timer);
				retries.current.delete(id);
				attempts.current.delete(id);
			}
		for (const machine of fleet ?? []) {
			const cacheKey = JSON.stringify(machineKey(JSON.parse(serialized) as unknown[], machine.id));
			if (!wanted.has(cacheKey)) continue;
			const revision = revisions.get(machine.id) ?? 0;
			const pending = active.current.get(cacheKey);
			if (pending && pending.revision !== revision) {
				pending.controller.abort();
				active.current.delete(cacheKey);
			}
			if (attempts.current.has(cacheKey) && attempts.current.get(cacheKey) !== revision) {
				const retry = retries.current.get(cacheKey);
				if (retry) clearTimeout(retry.timer);
				retries.current.delete(cacheKey);
			}
			const cached = cache.get(cacheKey);
			const due =
				forced.current.has(cacheKey) ||
				(opts?.pollMs !== undefined && cached !== undefined && Date.now() - cached.fetchedAt >= opts.pollMs);
			if (active.current.has(cacheKey) || retries.current.has(cacheKey)) continue;
			if (!due && (cached?.revision === revision || attempts.current.get(cacheKey) === revision)) continue;
			forced.current.delete(cacheKey);
			attempts.current.set(cacheKey, revision);
			const controller = new AbortController();
			active.current.set(cacheKey, { controller, revision });
			const timeout = setTimeout(() => controller.abort(), FLEET_REQUEST_TIMEOUT_MS);
			const { promise: abort, reject } = Promise.withResolvers<never>();
			controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
			void Promise.race([fetchRef.current(machine.id, controller.signal), abort])
				.then(
					value => {
						if (!mounted.current || controller.signal.aborted) return;
						cache.set(cacheKey, { data: value, revision, fetchedAt: Date.now() });
						const retry = retries.current.get(cacheKey);
						if (retry) clearTimeout(retry.timer);
						retries.current.delete(cacheKey);
						retryDelays.current.delete(cacheKey);
						setStates(prev => ({ ...prev, [cacheKey]: { error: null, stale: false } }));
					},
					error => {
						if (!mounted.current || active.current.get(cacheKey)?.controller !== controller) return;
						setStates(prev => ({
							...prev,
							[cacheKey]: {
								error: error instanceof Error ? error.message : String(error),
								stale: cache.has(cacheKey),
								missingEndpoint:
									typeof error === "object" &&
									error !== null &&
									(error as { status?: unknown }).status === 404,
							},
						}));
						const delay = Math.min((retryDelays.current.get(cacheKey) ?? 2500) * 2, 60000);
						retryDelays.current.set(cacheKey, delay);
						const timer = setTimeout(() => {
							retries.current.delete(cacheKey);
							forced.current.add(cacheKey);
							attempts.current.delete(cacheKey);
							setTick(n => n + 1);
						}, delay);
						retries.current.set(cacheKey, { timer, delay });
					},
				)
				.finally(() => {
					clearTimeout(timeout);
					if (active.current.get(cacheKey)?.controller === controller) active.current.delete(cacheKey);
					if (mounted.current) settleChecking(cacheKey);
				});
		}
	}, [serialized, machineState, tick, opts?.enabled, opts?.pollMs]);
	const machines = (fleet ?? []).map(machine => {
		const cacheKey = JSON.stringify(machineKey(key, machine.id));
		const cached = cache.get(cacheKey);
		const state = states[cacheKey];
		return {
			id: machine.id,
			name: machine.name,
			ok: machine.ok && !state?.error,
			error: machine.ok ? (state?.error ?? null) : "unreachable",
			outdated: machine.ok && (versionless.has(machine.id) || (!!state?.error && !!state.missingEndpoint)),
			lastKnown: machine.ok && machine.stale === true,
			stale:
				cached !== undefined &&
				(!machine.ok ||
					machine.stale ||
					cached.revision !== (revisions.get(machine.id) ?? 0) ||
					(state?.stale ?? false)),
		};
	});
	const values = (fleet ?? []).flatMap(machine => {
		const entry = cache.get(JSON.stringify(machineKey(key, machine.id)));
		return entry === undefined ? [] : [entry.data as T];
	});
	const refetch = (machine?: string) => {
		// Handlers wired straight to onClick pass an event: only a string names a machine.
		const only = typeof machine === "string" ? machine : undefined;
		const since = Date.now();
		retry.current?.abort();
		const controller = new AbortController();
		retry.current = controller;
		checkingKeys.current = null;
		setChecking(true);
		// Unreachable machines are never asked, so refresh the list first: one that came back is asked too.
		return detectFleet(AbortSignal.any([controller.signal, AbortSignal.timeout(RETRY_LIST_MS)]))
			.then(() => {
				// Superseded by another Try again, cancelled by a key change, or the page left: nothing more to do.
				if (!mounted.current || retry.current !== controller) return;
				retry.current = null;
				const pending = new Set<string>();
				for (const machine of getFleet() ?? []) {
					if (only !== undefined && machine.id !== only) continue;
					const cacheKey = JSON.stringify(machineKey(key, machine.id));
					// The list refresh may already have asked a machine that came back: never ask it twice.
					if ((cache.get(cacheKey)?.fetchedAt ?? 0) >= since) continue;
					const inFlight = active.current.has(cacheKey);
					if (!inFlight) forced.current.add(cacheKey);
					const retry = retries.current.get(cacheKey);
					if (retry) clearTimeout(retry.timer);
					retries.current.delete(cacheKey);
					if (machine.ok && opts?.enabled !== false) pending.add(cacheKey);
				}
				checkingKeys.current = pending.size ? pending : null;
				if (!pending.size) setChecking(false);
				setTick(n => n + 1);
			})
			.catch(() => {});
	};
	return { data: values.length ? merge(values) : null, machines, refetch, checking };
}

/**
 * How long one machine's request may take before this page gives up on it. Longer than the hub's own deadline for a
 * forwarded request (FLEET_FORWARD_S, 30 s), so the hub always speaks first: a machine that is slow but answering is
 * waited for, and only the hub's own "no answer in time" (or a real error) marks it failed. With 6 s here, a busy
 * moment (several tabs loading at once) turned slow machines into "No machine's stats answered" (N7).
 */
export const FLEET_REQUEST_TIMEOUT_MS = 35_000;

/** How long a Try again waits for the machine list before asking the machines it already knows. */
const RETRY_LIST_MS = 5000;

/** What a page shows under All machines when no machine's stats answered. */
export const ALL_MACHINES_FAILED = "No machine's stats answered; numbers are unavailable.";

/** Every machine's request failed: QueryView shows {@link ALL_MACHINES_FAILED} with Try again, never a skeleton. */
export class FleetFailedError extends Error {
	/** Each machine's failure, for the reasons folded into the failed line. */
	readonly machines: FleetQueryMachine[];
	constructor(machines: FleetQueryMachine[] = []) {
		super(ALL_MACHINES_FAILED);
		this.name = "FleetFailedError";
		this.machines = machines;
	}
}

/**
 * Where a fleet query stands: "ready" once any machine's data is in (a held machine's last-known data included,
 * marked stale), "failed" when every machine has definitively failed (none loading, none held, none with data),
 * otherwise "loading".
 */
export function fleetQueryState(
	result: Pick<FleetQueryResult<unknown>, "data" | "machines">,
): "ready" | "loading" | "failed" {
	if (result.data !== null) return "ready";
	// A held machine (the hub's grace period) is reconnecting, not failed: the page waits for it.
	if (result.machines.length > 0 && result.machines.every(machine => machine.error !== null && !machine.lastKnown))
		return "failed";
	return "loading";
}

/**
 * A page's single-machine query result, swapped for the fleet's under All machines: merged data, loading only while
 * some machine may still answer, {@link FleetFailedError} once every machine failed, and the fleet's refetch.
 */
export function fleetQueryView<S extends object, R>(
	single: S,
	fleet: FleetQueryResult<R>,
): Omit<S, "data" | "error" | "loading" | "stale" | "refetch" | "refreshing" | "polling"> & {
	data: R | null;
	error: Error | null;
	loading: boolean;
	stale: boolean;
	refreshing: false;
	refetch: () => void;
	checking: boolean;
	polling: true;
} {
	const state = fleetQueryState(fleet);
	return {
		...single,
		data: fleet.data,
		error: state === "failed" ? new FleetFailedError(fleet.machines) : null,
		loading: state === "loading",
		stale: fleet.machines.some(machine => machine.stale),
		refreshing: false,
		refetch: () => fleet.refetch(),
		checking: fleet.checking,
		// A failed machine is asked again on its own (back-off).
		polling: true,
	};
}
