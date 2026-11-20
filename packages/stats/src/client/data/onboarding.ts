import { ApiError } from "../api";
import { fetchRetrying } from "./restart-retry";

const BASE = "/api/hub/onboarding";
const ACTION_HEADERS = { "Content-Type": "application/json", "X-Omp-Hub": "1" };

export type OnboardingBank = "work" | "client" | "tools" | "skip";
export type OnboardingStatus =
	| "new"
	| "imported"
	| "changed"
	| "unchanged"
	| "removed"
	| "unreadable"
	| "denied"
	| "partial"
	| "needs-bank";

export interface OnboardingSource {
	id: string;
	kind: string;
	name: string;
	location: string;
	items: number;
	unit: string;
	sizeBytes: number;
	lastChanged: string | null;
	bank: OnboardingBank | null;
	rememberedBank: boolean;
	lockedBank: boolean;
	estimatedTokens: number | null;
	status: OnboardingStatus | string;
	note: string | null;
	root: string | null;
	reason: string | null;
	target: string | null;
	statusOnly: boolean;
	added: boolean;
	transcript: boolean;
}

export type OnboardingScanStats = Record<string, number | boolean>;

export interface OnboardingInventory {
	sources: OnboardingSource[];
	suggestions: { text: string; createdAt: string }[];
	scan?: {
		status: string;
		progress?: { kind: string; status: string; found?: number; message?: string }[];
		stats?: OnboardingScanStats;
	};
	memoryReady?: boolean;
}

export interface OnboardingPreview {
	digest: string;
	estimatedTokens: number;
	counts: Record<string, number>;
	perSource: Record<string, number>;
	samples: { sourceId: string; text: string }[];
	held: { item: string; kinds: string[] }[];
	model: Record<string, string | null>;
	scanStats: OnboardingScanStats;
}

export interface OnboardingProgress {
	runId: string;
	status: string;
	total: number;
	queued: number;
	sent: number;
	accepted: number;
	completed: number;
	failed: number;
	processing: number;
	tokensUsed: number | null;
	held: { item: string; kinds: string[] }[];
	banks: Record<string, Partial<OnboardingProgress>>;
	error: string | null;
}

export interface OnboardingSummary extends OnboardingProgress {
	documents: {
		documentId: string;
		item: string;
		bank: string;
		state: string;
		error: string | null;
		facts: string;
	}[];
}

export interface OnboardingUndo {
	runId: string;
	invalidated: string[];
	failed: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const endpoint = `${BASE}/${path}`;
	const response = await fetchRetrying(endpoint, init);
	const body = (await response.json().catch(() => null)) as T | { error?: string } | null;
	if (!response.ok)
		throw new ApiError(response.status, endpoint, (body as { error?: string } | null)?.error ?? response.statusText);
	return body as T;
}

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
	return request<T>(path, { method: "POST", headers: ACTION_HEADERS, body: JSON.stringify(body) });
}

function inventoryOf(raw: {
	sources: Array<{
		id: string;
		kind: string;
		name: string;
		path?: string;
		root?: string;
		reason?: string;
		target?: string;
		statusOnly?: boolean;
		items: number;
		unit: string;
		size: number;
		changedAt: string | null;
		bank?: OnboardingBank | null;
		bankRemembered?: boolean;
		bankLocked?: boolean;
		status: string;
		note?: string | null;
		added?: boolean;
	}>;
	suggestions?: { text: string; createdAt: string }[];
	scan?: OnboardingInventory["scan"];
	memoryReady?: boolean;
}): OnboardingInventory {
	return {
		sources: raw.sources.map(source => ({
			id: source.id,
			kind: source.kind,
			name: source.name,
			location: source.path ?? source.root ?? "—",
			items: source.items,
			unit: source.unit,
			sizeBytes: source.size,
			lastChanged: source.changedAt,
			bank: source.bank ?? null,
			rememberedBank: source.bankRemembered === true,
			lockedBank: source.bankLocked === true,
			estimatedTokens: source.size > 0 ? Math.ceil(source.size / 4) : null,
			status: source.status,
			note: source.note ?? null,
			root: source.root ?? null,
			reason: source.reason ?? null,
			target: source.target ?? null,
			statusOnly: source.statusOnly === true,
			added: source.added === true,
			transcript:
				source.kind.includes("transcript") || source.kind.includes("session") || source.kind.includes("chat"),
		})),
		suggestions: raw.suggestions ?? [],
		scan: raw.scan,
		memoryReady: raw.memoryReady,
	};
}

function previewOf(raw: {
	digest: string;
	tokens: number;
	counts: Record<string, number>;
	samples?: Record<string, { text: string }[]>;
	perSource?: Record<string, number>;
	model?: Record<string, string | null>;
	held?: { item: string; kinds: string[] }[];
	scanStats?: OnboardingScanStats;
}): OnboardingPreview {
	const samples = Object.entries(raw.samples ?? {}).flatMap(([sourceId, entries]) =>
		entries.map(entry => ({ sourceId, text: entry.text })),
	);
	return {
		digest: raw.digest,
		estimatedTokens: raw.tokens,
		counts: raw.counts,
		perSource: raw.perSource ?? {},
		samples,
		held: raw.held ?? [],
		model: raw.model ?? {},
		scanStats: raw.scanStats ?? {},
	};
}

function progressOf(raw: {
	runId: string;
	state: string;
	byState: Record<string, number>;
	byBank: Record<string, Record<string, number>>;
	tokensSent?: number;
	held?: { item: string; kinds: string[] }[];
}): OnboardingProgress {
	const count = (state: string) => raw.byState[state] ?? 0;
	return {
		runId: raw.runId,
		status: raw.state,
		total: Object.values(raw.byState).reduce((sum, value) => sum + value, 0),
		queued: count("queued"),
		sent: count("sent"),
		accepted: count("accepted"),
		completed: count("completed"),
		failed: count("failed"),
		processing: count("unresolved"),
		tokensUsed: raw.tokensSent ?? null,
		held: raw.held ?? [],
		banks: Object.fromEntries(
			Object.entries(raw.byBank).map(([bank, states]) => [
				bank,
				{
					queued: states.queued ?? 0,
					sent: states.sent ?? 0,
					accepted: states.accepted ?? 0,
					completed: states.completed ?? 0,
					failed: states.failed ?? 0,
					processing: states.unresolved ?? 0,
					total: Object.values(states).reduce((sum, value) => sum + value, 0),
				},
			]),
		),
		error: null,
	};
}

export async function getOnboardingInventory(signal?: AbortSignal): Promise<OnboardingInventory> {
	const endpoint = `${BASE}/inventory`;
	const response = await fetchRetrying(endpoint, { signal });
	const raw = (await response.json().catch(() => null)) as
		| (Parameters<typeof inventoryOf>[0] & { scanning?: boolean; error?: string })
		| null;
	if (!response.ok) throw new ApiError(response.status, endpoint, raw?.error ?? response.statusText);
	const inventory = inventoryOf(raw as Parameters<typeof inventoryOf>[0]);
	return response.status === 202 || raw?.scanning === true
		? { ...inventory, scan: { status: "scanning", progress: [] } }
		: inventory;
}

interface RawScan {
	scanState: string;
	scanKind: string | null;
	sources: Parameters<typeof inventoryOf>[0]["sources"];
	partial: boolean;
	scanStats?: OnboardingScanStats;
}

function scanOf(raw: RawScan): OnboardingInventory {
	const inventory = inventoryOf({ sources: raw.sources });
	return {
		...inventory,
		scan: {
			status: raw.scanState,
			progress: raw.scanKind ? [{ kind: raw.scanKind, status: raw.partial ? "partial" : raw.scanState }] : [],
			stats: raw.scanStats ?? {},
		},
	};
}

export const startOnboardingScan = () => request<RawScan>("scan").then(scanOf);
export const getOnboardingScanProgress = () => request<RawScan>("scan-progress").then(scanOf);
export const cancelOnboardingScan = () => post<RawScan>("cancel-scan", {}).then(scanOf);

export async function addOnboardingSource(
	kind: "file" | "folder" | "url",
	value: string,
): Promise<OnboardingInventory> {
	return inventoryOf(await post("add-source", { kind, value }));
}

export async function setOnboardingBank(sourceId: string, bank: OnboardingBank): Promise<OnboardingInventory> {
	await post("set-bank", { sourceId, bank });
	return getOnboardingInventory();
}

export async function previewOnboarding(
	sourceIds: readonly string[],
	windowDays: number,
	includeSubagents: boolean,
): Promise<OnboardingPreview> {
	return previewOf(await post("preview", { sourceIds, windowDays, includeSubagents }));
}

export const confirmOnboardingEstimate = (digest: string, cap: number | undefined, acknowledgeUnknownModel: boolean) =>
	post("estimate-confirm", { digest, ...(cap === undefined ? {} : { cap }), acknowledgeUnknownModel });

export const startOnboarding = (digest: string, cap: number | undefined, acknowledgeUnknownModel: boolean) =>
	post<{ runId: string }>("start", { digest, ...(cap === undefined ? {} : { cap }), acknowledgeUnknownModel });

export async function onboardingRunAction(
	action: "pause" | "resume" | "stop",
	runId: string,
): Promise<OnboardingProgress> {
	await post<{ runId: string }>(action, { runId });
	return getOnboardingProgress(runId);
}

export async function getOnboardingProgress(runId: string, signal?: AbortSignal): Promise<OnboardingProgress> {
	return progressOf(await request(`progress?runId=${encodeURIComponent(runId)}`, { signal }));
}

export interface OnboardingRun {
	runId: string;
	state: string;
	updatedAt: string;
}

export const getOnboardingRuns = (signal?: AbortSignal) => request<{ runs: OnboardingRun[] }>("runs", { signal });

export async function getOnboardingSummary(runId: string, signal?: AbortSignal): Promise<OnboardingSummary> {
	const raw = await request<{ documents: OnboardingSummary["documents"] } & Parameters<typeof progressOf>[0]>(
		`summary?runId=${encodeURIComponent(runId)}`,
		{ signal },
	);
	return { ...progressOf(raw), documents: raw.documents };
}

export const undoOnboarding = (runId: string) => post<OnboardingUndo>("undo", { runId });
export async function rerunOnboarding(
	sourceIds: readonly string[],
	windowDays: number,
	includeSubagents: boolean,
): Promise<OnboardingPreview> {
	return previewOf(await post("re-run", { sourceIds, windowDays, includeSubagents }));
}

/** Suggestions never leave the hub. */
export async function addOnboardingSuggestion(text: string): Promise<OnboardingInventory> {
	await post("suggestions", { text });
	return getOnboardingInventory();
}
