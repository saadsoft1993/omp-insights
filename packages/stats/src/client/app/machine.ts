import { useEffect, useState, useSyncExternalStore } from "react";
import { noteUnauthorized } from "../data/pairing";
import { detectHub } from "../data/hub-presence";

/**
 * Fleet mode. The hub in front of this page may front several machines (`GET /api/hub/machines` answers a
 * list); every per-machine request then goes through the path prefix `/m/<id>`. Without a fleet (404, error,
 * anything but a list) the prefix is empty and the dashboard behaves as a single-machine one.
 */

/** One entry of `GET /api/hub/machines`. */
export interface FleetMachine {
	id: string;
	name: string;
	self: boolean;
	ok: boolean;
	/**
	 * Reachable in name only: the hub has not heard from it recently and is serving its last good answer
	 * (the hub's 60 s grace). Shown as "last known": neither live nor unreachable.
	 */
	stale?: boolean;
	/** When the hub started holding this machine's last good answer (ms); the "last known as of" time. */
	staleSince?: number | null;
	latencyMs: number | null;
	version: string | null;
	lastOkAt: number | null;
	/** Where to pair this browser with that machine's own hub. */
	dashboardUrl: string | null;
}

const MACHINE_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const SELECTED_MACHINE_STORAGE_KEY = "omp.machine";
export const ALL_MACHINES = "*";

function optionalNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An absolute https: URL, else null: the value ends up in an href, so nothing else may through. */
export function httpsUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

/** The hub reports `{commit, dirty, startedAt}`; a plain string is accepted too. */
function versionText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null || !("commit" in value)) return null;
	const { commit, dirty } = value as { commit?: unknown; dirty?: unknown };
	return typeof commit === "string" && commit ? `${commit.slice(0, 8)}${dirty === true ? "+" : ""}` : null;
}

/** The machines the hub reports, or null when the body is not a usable fleet list (single-machine mode). */
export function parseMachines(body: unknown): FleetMachine[] | null {
	const list = Array.isArray(body)
		? body
		: typeof body === "object" && body !== null && "machines" in body && Array.isArray(body.machines)
			? body.machines
			: null;
	if (!list || list.length === 0) return null;
	const machines: FleetMachine[] = [];
	for (const item of list as unknown[]) {
		if (typeof item !== "object" || item === null) return null;
		const m = item as Record<string, unknown>;
		if (typeof m.id !== "string" || !MACHINE_ID.test(m.id)) return null;
		machines.push({
			id: m.id,
			name: typeof m.name === "string" && m.name ? m.name : m.id,
			self: m.self === true,
			ok: m.ok !== false,
			// An unreachable machine also reports stale for a while; only a reachable one is "last known".
			stale: m.ok !== false && m.stale === true,
			staleSince: m.ok !== false && m.stale === true ? optionalNumber(m.staleSince) : null,
			latencyMs: optionalNumber(m.latencyMs),
			version: versionText(m.version),
			lastOkAt: optionalNumber(m.lastOkAt),
			dashboardUrl: httpsUrl(m.dashboardUrl),
		});
	}
	return machines.some(m => m.self) ? machines : null;
}

let fleet: FleetMachine[] | null = null;
let storedSelection: string | null = readStoredSelection();
const listeners = new Set<() => void>();

function readStoredSelection(): string | null {
	try {
		return globalThis.localStorage?.getItem(SELECTED_MACHINE_STORAGE_KEY) ?? null;
	} catch {
		return null;
	}
}

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function sameFleet(a: FleetMachine[] | null, b: FleetMachine[] | null): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((m, i) => JSON.stringify(m) === JSON.stringify(b[i]));
}

/** Replace the known fleet (null: single-machine mode). */
export function setFleet(next: FleetMachine[] | null): void {
	if (sameFleet(fleet, next)) return;
	fleet = next;
	emit();
}

export function getFleet(): FleetMachine[] | null {
	return fleet;
}

/** The stored selection, defaulting to all machines for a multi-machine fleet. */
export function selection(): string | undefined {
	if (!fleet) return undefined;
	if (storedSelection === ALL_MACHINES || (storedSelection && fleet.some(m => m.id === storedSelection)))
		return storedSelection;
	return fleet.length > 1 ? ALL_MACHINES : fleet[0].id;
}

export function concreteMachine(): string | undefined {
	const selected = selection();
	return selected === ALL_MACHINES ? undefined : selected;
}

export function isAllMachines(): boolean {
	return selection() === ALL_MACHINES;
}

export function fleetIds(): string[] {
	return fleet?.map(m => m.id) ?? [];
}

export function selectMachine(id: string): void {
	if (id === storedSelection) return;
	storedSelection = id;
	try {
		globalThis.localStorage?.setItem(SELECTED_MACHINE_STORAGE_KEY, id);
	} catch {
		// Private mode: the choice just lasts for this page.
	}
	emit();
}

/** Re-read the stored choice (tests, and other tabs through the `storage` event). */
export function reloadSelection(): void {
	storedSelection = readStoredSelection();
	emit();
}

/** `""` without a fleet or machine, else `/m/<id>`. */
export function machinePrefix(id?: string): string {
	return fleet && id ? `/m/${id}` : "";
}

/** Path for the selected machine's per-machine API (`/api/stats/...`, `/api/events`, quota, jobs, ...). */
export function machinePath(path: string, id: string | undefined): string {
	if (isAllMachines() && !id) throw new Error("Pick a machine");
	return machinePrefix(id) + path;
}

/**
 * Cache key of a per-machine query: the machine id is appended, so one machine's data never answers for
 * another. Appended (not prepended) because the query store routes some keys to buckets by their first element.
 */
export function machineKey(key: readonly unknown[], machine: string | undefined): readonly unknown[] {
	return machine === undefined ? key : [...key, { machine }];
}

export function useFleet(): FleetMachine[] | null {
	return useSyncExternalStore(subscribe, getFleet);
}

/** The selected machine id, or undefined in single-machine mode. */
export function useSelectedMachine(): string | undefined {
	return useSyncExternalStore(subscribe, selection);
}

/** Why the last machine-list refresh didn't update the fleet (the last known one is kept), or null. */
let listProblem: string | null = null;

export function fleetListProblem(): string | null {
	return listProblem;
}

export function useFleetListProblem(): string | null {
	return useSyncExternalStore(subscribe, fleetListProblem);
}

function noteListProblem(problem: string | null): void {
	if (problem === listProblem) return;
	listProblem = problem;
	emit();
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
	const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
	return signal?.aborted === true || name === "AbortError" || name === "TimeoutError";
}

/**
 * Ask the hub which machines it fronts. Only a complete, valid answer changes the fleet: a list makes it, a 404 or a
 * JSON body that is not a list means single-machine mode. An aborted or timed-out request never changes anything; a
 * network error or an unreadable body keeps the last known fleet and notes why ({@link useFleetListProblem}).
 */
export async function detectFleet(signal?: AbortSignal): Promise<FleetMachine[] | null> {
	try {
		const res = await fetch("/api/hub/machines", { signal });
		if (res.ok) {
			let body: unknown;
			try {
				body = await res.json();
			} catch (error) {
				// A body cut off by an abort or timeout is not an answer; nor is one that is not JSON.
				if (!isAbort(error, signal)) noteListProblem("the machine list came back unreadable");
				return fleet;
			}
			if (signal?.aborted) return fleet;
			noteListProblem(null);
			setFleet(parseMachines(body));
		} else if (res.status === 401) {
			await noteUnauthorized(res);
		} else if (res.status === 404) {
			noteListProblem(null);
			setFleet(null);
		} else if (fleet) {
			noteListProblem(`the machine list answered ${res.status}`);
		}
	} catch (error) {
		// Hub briefly unreachable, or the request was cancelled: keep the last known fleet.
		if (!isAbort(error, signal) && fleet) noteListProblem("the hub didn't answer the machine list");
	}
	return fleet;
}

const FLEET_POLL_MS = 30_000;
/**
 * How long the first machine-list answer is waited for before the page starts in single-machine mode. A fleet hub
 * that is merely slow (several tabs loading at once took over 5 s) must not be mistaken for a single-machine one:
 * that sent every request without its machine prefix (N7). A single-machine hub answers at once (404 or an empty
 * list), so only a hub that is down waits this long.
 */
export const FLEET_FIRST_ANSWER_MS = 30_000;

/**
 * Detects fleet mode once before the app opens any per-machine request (so none goes out unprefixed and is
 * repeated), then keeps the machine list fresh. Returns false until the first answer; a silent hub is given
 * FLEET_FIRST_ANSWER_MS, then the app starts in single-machine mode.
 */
export function useFleetReady(): boolean {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		let alive = true;
		Promise.all([detectFleet(AbortSignal.timeout(FLEET_FIRST_ANSWER_MS)), detectHub()]).finally(() => {
			if (alive) setReady(true);
		});
		const timer = setInterval(() => {
			if (!document.hidden) void detectFleet();
		}, FLEET_POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, []);
	return ready;
}

/** Tests only: forget everything. */
export function resetFleetForTests(): void {
	fleet = null;
	storedSelection = null;
	listProblem = null;
	emit();
}

/** Which Mac this dashboard belongs to: the name the hub reports and the accent colour derived from it. */

/** Hue buckets: 12 steps of 30° keep two machines visibly apart instead of two near-identical hues. */
const HUE_STEP = 30;

/** Stable hue (FNV-1a over the lower-cased name) so a machine keeps its colour across reloads and Macs. */
export function machineHue(name: string): number {
	let hash = 0x811c9dc5;
	for (const ch of name.trim().toLowerCase()) {
		hash ^= ch.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return (hash % (360 / HUE_STEP)) * HUE_STEP;
}

export interface MachineView {
	name: string;
	/** Mid-lightness accent: at least 3:1 against both the dark (#000) and light (#fff) page for strokes and dots. */
	accent: string;
	scope: string;
	/** Accessible name, spelling out what the chip means. */
	label: string;
}

/** Banner content for the hub's answer, or null when there is no usable name (older hub, hub down). */
export function machineView(name: string | null | undefined): MachineView | null {
	const trimmed = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
	if (!trimmed) return null;
	const scope = "sessions on this Mac only";
	return {
		name: trimmed,
		accent: `oklch(0.62 0.17 ${machineHue(trimmed)})`,
		scope,
		label: `${trimmed}: ${scope}`,
	};
}

/** Remove a common leading word only when the whole fleet shares one. */
export function shortMachineName(name: string): string {
	if (!fleet || fleet.length < 2) return name;
	const parts = fleet.map(machine => machine.name.trim().split(/\s+/));
	const prefix = parts[0][0].toLowerCase();
	if (!parts.every(words => words.length >= 2 && words[0].toLowerCase() === prefix)) return name;
	const words = name.trim().split(/\s+/);
	return words.length >= 2 && words[0].toLowerCase() === prefix ? words.slice(1).join(" ") : name;
}
