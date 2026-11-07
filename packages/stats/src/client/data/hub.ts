/**
 * The omp hub's own API (`/api/hub/*`). The hub fronts this dashboard: it lists live omp sessions,
 * hands out Collab links for them, starts new ones, and sends phone alerts.
 */
import { ApiError } from "../api";
import { markUnpaired } from "./pairing";

/** A live omp session sharing through Collab (`omp collab list --json`), annotated by the hub. */
export interface HubSession {
	instanceId: string;
	generation?: number;
	pid?: number;
	sessionId?: string;
	sessionName?: string;
	cwd?: string;
	model?: { provider?: string; id?: string } | null;
	startedAt?: number;
	participants?: number;
	relayConnected?: boolean;
	inputRequired?: boolean;
	busy?: boolean | null;
	/** Subagents still running: the session's task isn't done yet. */
	agentsRunning?: number;
	/** Which relay the session's room uses; the hub only opens `tailnet` ones. */
	relay?: "tailnet" | "public" | "unknown";
	/** The session runs the omp-hub-control extension, so Stop and Rename work (sessions started before it need a restart). */
	control?: boolean;
	/** Where it runs in herdr, when herdr reports it. */
	herdr?: HubHerdrPlace | null;
}

export interface HubHerdrPlace {
	workspace: string | null;
	tab: string | null;
	pane: string | null;
}

export interface HubSessions {
	sessions: HubSession[];
	now: number;
}

export interface HubProject {
	path: string;
	name: string;
	label: string;
	last_used: number | null;
}

export interface HubRelayHealth {
	ok: boolean;
	error: string | null;
	rooms?: number | null;
	guests?: number | null;
	uptime_s?: number | null;
	build?: string | null;
}

export interface HubAlerts {
	enabled: boolean;
	server: string;
	topic: string | null;
	sent: number;
	last_sent_at: number | null;
	last_error: string | null;
}

/** A session Start opened: a new herdr tab labelled `omp` in the project's workspace. */
export interface HubStarted {
	herdrWorkspace: string | null;
	tab: string | null;
	pane: string;
	instanceId: string | null;
}

/** What a Stop, Rename, Kill or Force kill did. */
export interface HubActionResult {
	outcome: "stopped" | "was_idle" | "renamed" | "exited" | "still_running" | "force_exited" | "force_still_running";
	name?: string;
	pid?: number;
}

async function hubFetch<T>(name: string, init?: RequestInit): Promise<T> {
	const endpoint = `/api/hub/${name}`;
	const res = await fetch(endpoint, init);
	if (res.status === 401) markUnpaired();
	const body = (await res.json().catch(() => null)) as unknown;
	if (!res.ok) {
		const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
		throw new ApiError(res.status, endpoint, typeof error === "string" ? error : `HTTP error ${res.status}`);
	}
	return body as T;
}

/**
 * Hub POSTs carry `X-Omp-Hub: 1`: a custom header forces a CORS preflight the hub never approves,
 * and the hub also checks Origin is the dashboard itself.
 */
function hubPost<T>(name: string, body: Record<string, unknown>): Promise<T> {
	return hubFetch<T>(name, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Omp-Hub": "1" },
		body: JSON.stringify(body),
	});
}

export function getHubSessions(signal?: AbortSignal): Promise<HubSessions> {
	return hubFetch("sessions", { signal });
}

export function getHubProjects(signal?: AbortSignal): Promise<{ projects: HubProject[] }> {
	return hubFetch("projects", { signal });
}

export function getHubRelay(signal?: AbortSignal): Promise<HubRelayHealth> {
	return hubFetch("relay", { signal });
}

export function getHubAlerts(signal?: AbortSignal): Promise<HubAlerts> {
	return hubFetch("alerts", { signal });
}

/** A fresh Collab link for the session's current room (full control, or view-only with `view`). */
export function getHubLink(instanceId: string, view: boolean): Promise<{ url: string }> {
	return hubPost("link", { instanceId, view });
}

export function startHubSession(path: string): Promise<HubStarted> {
	return hubPost("start", { path });
}

export function sendHubTestAlert(): Promise<{ ok: boolean }> {
	return hubPost("alerts/test", {});
}

function sessionAction(sessionId: string, action: string, body: Record<string, unknown>): Promise<HubActionResult> {
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/${action}`, body);
}

/** Interrupt the running turn (needs the omp-hub-control extension in that session). */
export function stopHubSession(sessionId: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "stop", {});
}

export function renameHubSession(sessionId: string, name: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "rename", { name });
}

/** End the session's omp process (SIGTERM); `confirm` is its exact name or project folder. */
export function killHubSession(sessionId: string, confirm: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "kill", { confirm });
}

/** SIGKILL, only accepted after Kill did not end the session. */
export function forceKillHubSession(sessionId: string, confirm: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "force-kill", { confirm });
}
