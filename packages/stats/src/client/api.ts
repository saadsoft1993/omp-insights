import { machinePath } from "./app/machine";
import { noteUnauthorized } from "./data/pairing";
import { fetchRetrying } from "./data/restart-retry";
import type {
	AccountDashboardStats,
	AccountFlowStats,
	CostDashboardStats,
	FolderStats,
	FrustrationDashboardStats,
	FrustrationEstimate,
	FrustrationJobStatus,
	GainDashboardStats,
	LiveStatus,
	LiveTrafficStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	ProviderDashboardStats,
	ProviderWindowStats,
	RequestDetails,
	SessionSummary,
	SessionTrace,
	SessionTraceTrackResponse,
	SpotlightAgentScope,
	SpotlightDashboardStats,
	SpotlightSessionContext,
	TimeRange,
	ToolDashboardStats,
} from "./types";

/** The hub's own routes that are never forwarded to another machine (closing the dashboard). */
const LOCAL_API_BASE = "/api";

export class ApiError extends Error {
	status: number;
	endpoint: string;
	/** The server's machine-readable `code` (the hub sends one with its 4xx/5xx), when the body had one. */
	code: string | null;

	constructor(status: number, endpoint: string, message: string, code: string | null = null) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.endpoint = endpoint;
		this.code = code;
	}
}

/** Prefer the server's `{ error }` body over a bare status line. */
async function readErrorMessage(res: Response, endpoint: string): Promise<string> {
	try {
		const body: unknown = await res.json();
		if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
			return body.error;
		}
	} catch {
		// Non-JSON error body: fall through to the status line.
	}
	return `HTTP error ${res.status} on ${endpoint}`;
}

/**
 * Response validators keyed by the parsed body they describe. Revalidating a
 * body sends its ETag; the entry dies with the body when callers drop it.
 */
const validators = new WeakMap<object, string>();

/**
 * Fetch `endpoint` as JSON, revalidating `previous` when it came from an
 * ETag-bearing response: a 304 resolves to `previous` itself (same reference,
 * no re-parse).
 */
async function fetchJson<T>(endpoint: string, options?: RequestInit, previous?: T): Promise<T> {
	const etag = typeof previous === "object" && previous !== null ? validators.get(previous) : undefined;
	let init = options;
	if (etag) {
		const headers = new Headers(options?.headers);
		headers.set("If-None-Match", etag);
		init = { ...options, headers };
	}
	const res = await fetchRetrying(endpoint, init);
	if (res.status === 304 && etag) return previous as T;
	if (!res.ok) {
		// The hub fronting this dashboard answers 401 until the browser is paired.
		if (res.status === 401) await noteUnauthorized(res);
		throw new ApiError(res.status, endpoint, await readErrorMessage(res, endpoint));
	}
	const data = (await res.json()) as T;
	const nextEtag = res.headers.get("ETag");
	if (nextEtag && typeof data === "object" && data !== null) validators.set(data, nextEtag);
	return data;
}

/**
 * Spend-incurring actions carry this custom header. It forces a CORS preflight
 * the server never approves, so a cross-site page cannot trigger them.
 */
const ACTION_HEADERS = { "X-Omp-Stats-Action": "1" };

export async function getOverviewStats(
	range: TimeRange = "24h",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<OverviewStats> {
	return fetchJson<OverviewStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/overview?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

export async function getModelDashboardStats(
	range: TimeRange = "24h",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<ModelDashboardStats> {
	return fetchJson<ModelDashboardStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/model-dashboard?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

export async function getCostDashboardStats(
	range: TimeRange = "24h",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<CostDashboardStats> {
	return fetchJson<CostDashboardStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/costs?range=${encodeURIComponent(range)}`,
		{ signal },
	);
}

export async function getRecentRequests(
	limit = 50,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(`${machinePath(LOCAL_API_BASE, machine)}/stats/recent?limit=${limit}`, { signal });
}

export async function getRecentErrors(
	range: TimeRange = "24h",
	limit = 50,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<MessageStats[]> {
	return fetchJson<MessageStats[]>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/errors?range=${encodeURIComponent(range)}&limit=${limit}`,
		{
			signal,
		},
	);
}

export async function getRequestDetails(
	id: number,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<RequestDetails> {
	return fetchJson<RequestDetails>(`${machinePath(LOCAL_API_BASE, machine)}/request/${id}`, { signal });
}

/** Whether the page may close the dashboard (`omp stats` shown in place of a Tern block). */
export async function getClosable(signal?: AbortSignal): Promise<boolean> {
	const { closable } = await fetchJson<{ closable: boolean }>(`${LOCAL_API_BASE}/close`, { signal });
	return closable;
}

/** Close the dashboard: its host takes the page away and stops serving it. */
export async function closeDashboard(): Promise<void> {
	const endpoint = `${LOCAL_API_BASE}/close`;
	const res = await fetch(endpoint, { method: "POST", headers: ACTION_HEADERS });
	if (!res.ok) throw new ApiError(res.status, endpoint, await readErrorMessage(res, endpoint));
}

/**
 * Ask the server to start a background sync; progress arrives on the `/api/events` stream. Like the
 * spend-incurring actions it carries the custom header, so the hub in front can refuse cross-site posts.
 */
export async function requestSync(machine: string | undefined): Promise<LiveStatus> {
	return fetchJson<LiveStatus>(`${machinePath(LOCAL_API_BASE, machine)}/sync`, {
		method: "POST",
		headers: ACTION_HEADERS,
	});
}

export async function getFrustrationDashboardStats(
	range: TimeRange = "24h",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<FrustrationDashboardStats> {
	return fetchJson<FrustrationDashboardStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/frustration?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

/** Pre-run cost quote for judging every unjudged message in `range`. */
export async function getFrustrationEstimate(
	range: TimeRange,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<FrustrationEstimate> {
	return fetchJson<FrustrationEstimate>(
		`${machinePath(LOCAL_API_BASE, machine)}/frustration/estimate?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

/** Start the judge run over the unjudged messages in `range`. Spends money. */
export async function startFrustrationRun(
	range: TimeRange,
	machine: string | undefined,
): Promise<FrustrationJobStatus> {
	return fetchJson<FrustrationJobStatus>(
		`${machinePath(LOCAL_API_BASE, machine)}/frustration/judge?range=${encodeURIComponent(range)}`,
		{
			method: "POST",
			headers: ACTION_HEADERS,
		},
	);
}

export async function cancelFrustrationRun(machine: string | undefined): Promise<FrustrationJobStatus> {
	return fetchJson<FrustrationJobStatus>(`${machinePath(LOCAL_API_BASE, machine)}/frustration/cancel`, {
		method: "POST",
		headers: ACTION_HEADERS,
	});
}

export async function getFolderStats(
	range: TimeRange = "24h",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<FolderStats[]> {
	return fetchJson<FolderStats[]>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/folders?range=${encodeURIComponent(range)}`,
		{ signal },
	);
}

export async function getGainDashboardStats(
	range: TimeRange = "24h",
	project: string | null | undefined,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<GainDashboardStats> {
	const params = new URLSearchParams({ range });
	if (project) params.set("project", project);
	return fetchJson<GainDashboardStats>(`${machinePath(LOCAL_API_BASE, machine)}/stats/gain?${params}`, { signal });
}

export async function getSpotlightDashboardStats(
	range: TimeRange = "24h",
	agent: SpotlightAgentScope = "all",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<SpotlightDashboardStats> {
	return fetchJson<SpotlightDashboardStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/spotlight?range=${encodeURIComponent(range)}&agent=${encodeURIComponent(agent)}`,
		{ signal },
	);
}

/** One experiment session's context per request, with and without shaping. */
export async function getSpotlightSessionContext(
	file: string,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<SpotlightSessionContext> {
	return fetchJson<SpotlightSessionContext>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/spotlight/session?file=${encodeURIComponent(file)}`,
		{
			signal,
		},
	);
}

export async function getToolDashboardStats(
	range: TimeRange = "24h",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<ToolDashboardStats> {
	return fetchJson<ToolDashboardStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/tools?range=${encodeURIComponent(range)}`,
		{ signal },
	);
}

export async function getProviderDashboardStats(
	range: TimeRange = "24h",
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<ProviderDashboardStats> {
	return fetchJson<ProviderDashboardStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/providers?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

/** Subscription-window insights (all providers) plus utilization series for `provider` only. */
export async function getProviderWindowStats(
	range: TimeRange,
	provider: string | null,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<ProviderWindowStats> {
	const params = new URLSearchParams({ range });
	if (provider !== null) params.set("provider", provider);
	return fetchJson<ProviderWindowStats>(`${machinePath(LOCAL_API_BASE, machine)}/stats/provider-windows?${params}`, {
		signal,
	});
}

/** Per-account traffic, status and quota readings, plus unattributed traffic per provider. */
export async function getAccountDashboardStats(
	range: TimeRange,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<AccountDashboardStats> {
	return fetchJson<AccountDashboardStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/accounts?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

/** Requests and tokens per account per bucket over the range (unattributed traffic as its own series per provider). */
export async function getAccountFlowStats(
	range: TimeRange,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<AccountFlowStats> {
	return fetchJson<AccountFlowStats>(
		`${machinePath(LOCAL_API_BASE, machine)}/stats/accounts/flow?range=${encodeURIComponent(range)}`,
		{
			signal,
		},
	);
}

/** Live traffic over the last five minutes (sessions, targets, lines, latest requests). */
export async function getLiveTrafficStats(
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<LiveTrafficStats> {
	return fetchJson<LiveTrafficStats>(`${machinePath(LOCAL_API_BASE, machine)}/stats/live`, { signal });
}

export async function getSessions(
	limit = 100,
	q: string | undefined,
	signal: AbortSignal | undefined,
	machine: string | undefined,
	options?: { before?: number; beforeFile?: string; after?: number; folder?: string },
): Promise<SessionSummary[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (q) params.set("q", q);
	if (options?.before !== undefined) params.set("before", String(options.before));
	if (options?.beforeFile) params.set("beforeFile", options.beforeFile);
	if (options?.after !== undefined) params.set("after", String(options.after));
	if (options?.folder) params.set("folder", options.folder);
	return fetchJson<SessionSummary[]>(`${machinePath(LOCAL_API_BASE, machine)}/sessions?${params}`, { signal });
}

/**
 * Pass the last trace for `file` as `previous` to revalidate it: an unchanged
 * trace resolves to that same object without downloading or parsing the body.
 */
export async function getSessionTrace(
	file: string,
	signal: AbortSignal | undefined,
	previous: SessionTrace | undefined,
	machine: string | undefined,
): Promise<SessionTrace> {
	// `no-store`: validation is ours (above); the browser cache would only keep a second multi-MB copy.
	return fetchJson<SessionTrace>(
		`${machinePath(LOCAL_API_BASE, machine)}/session/trace?file=${encodeURIComponent(file)}`,
		{ signal, cache: "no-store" },
		previous,
	);
}

export async function getSessionTraceTrack(
	file: string,
	trackId: string,
	signal: AbortSignal | undefined,
	previous: SessionTraceTrackResponse | undefined,
	machine: string | undefined,
): Promise<SessionTraceTrackResponse> {
	return fetchJson<SessionTraceTrackResponse>(
		`${machinePath(LOCAL_API_BASE, machine)}/session/trace-track?file=${encodeURIComponent(file)}&track=${encodeURIComponent(trackId)}`,
		{ signal, cache: "no-store" },
		previous,
	);
}

/** Fetch one full journal entry for the span drawer. Entries are opaque JSON. */
export async function getSessionEntryDetail(
	file: string,
	id: string,
	signal: AbortSignal | undefined,
	machine: string | undefined,
): Promise<{ entry: unknown }> {
	return fetchJson<{ entry: unknown }>(
		`${machinePath(LOCAL_API_BASE, machine)}/session/entry?file=${encodeURIComponent(file)}&id=${encodeURIComponent(id)}`,
		{ signal },
	);
}
