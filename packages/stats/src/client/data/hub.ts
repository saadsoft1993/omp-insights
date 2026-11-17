/**
 * The omp hub's own API (`/api/hub/*`). The hub fronts this dashboard: it lists live omp sessions,
 * hands out Collab links for them, starts new ones, and sends phone alerts.
 */
import { ApiError } from "../api";
import { noteUnauthorized } from "./pairing";

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
	/** The workspace group the hub derives from the working directory (or Other). */
	workspace?: string;
	/** While it needs you: when the hub first noticed (ms). null otherwise. */
	waitingSince?: number | null;
	/** False when the hub first saw it already waiting (hub restarted): the real age is unknown. */
	waitingObserved?: boolean;
	/** A plan review is open in the session's terminal (null/absent: none). */
	planReview?: HubPlanReviewRef | null;
	/** supported: plan reviews can be answered here; restart_needed: the session predates the control plugin's plan support. */
	planControl?: "supported" | "restart_needed" | "none";
	/** What the hub reads off the session's terminal (herdr pane); absent on an older hub. */
	terminal?: HubTerminal;
}

export type TerminalWaitingKind = "confirm" | "select" | "input" | "oauth";

/** A dialog the hub detected from the terminal screen (not reported by omp itself). */
export interface HubTerminalWaiting {
	kind: TerminalWaitingKind;
	line: string;
	observedAt: string;
}

export interface HubTerminal {
	/** The hub can read and type into this session's terminal. */
	available: boolean;
	waiting: HubTerminalWaiting | null;
	/** The screen could not be read just now: "not waiting" is then not known. */
	unknown: boolean;
}

/** What the session list says about an open plan review; the full review comes from `getPlanReview`. */
export interface HubPlanReviewRef {
	reviewId: string;
	title: string;
	openedAt: string;
}

export type PlanChoice = "execute" | "compact" | "keep" | "refine" | "save";

export interface PlanOption {
	id: PlanChoice;
	label: string;
	disabled: boolean;
}

export interface PlanTier {
	role: string;
	provider: string;
	model: string;
	thinkingLevel?: string;
}

export type HubPlanReview =
	| { open: false }
	| {
			open: true;
			reviewId: string;
			title: string;
			planFilePath: string;
			options: PlanOption[];
			tiers: PlanTier[] | null;
			planContent: string;
			/** The hub had to cut the plan: approving is refused. */
			truncated: boolean;
	  };

export interface PlanAnswerRequest {
	reviewId: string;
	choice: PlanChoice;
	feedback?: string;
	role?: string;
}

export interface HubVersion {
	hub: { commit: string | null; dirty: boolean | null; startedAt: number };
	ui: { buildId: string; builtAt: string | null } | null;
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
	if (res.status === 401) await noteUnauthorized(res);
	const body = (await res.json().catch(() => null)) as unknown;
	if (!res.ok) {
		const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
		const code = typeof body === "object" && body !== null && "code" in body ? body.code : null;
		throw new ApiError(
			res.status,
			endpoint,
			typeof error === "string" ? error : `HTTP error ${res.status}`,
			typeof code === "string" ? code : null,
		);
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

export type HubDeviceScope = "tailnet" | "local";

export interface HubDevice {
	id: string;
	scope: HubDeviceScope;
	label: string;
	pairedAt: number;
	expiresAt: number | null;
	auto: boolean;
	current: boolean;
}

export interface HubDevices {
	devices: HubDevice[];
	autoPair: boolean;
	/** The listener this page talks to; also the scope of the links it can create. */
	scope: HubDeviceScope;
	canLink: boolean;
}

export interface HubPairLink {
	url: string;
	expiresAt: number;
}

export function getHubDevices(signal?: AbortSignal): Promise<HubDevices> {
	return hubFetch("devices", { signal });
}

export function createHubPairLink(): Promise<HubPairLink> {
	return hubPost("devices/link", {});
}

export function revokeHubDevice(id: string): Promise<{ revoked: number; self: boolean }> {
	return hubPost("devices/revoke", { id });
}

export function revokeHubAutoDevices(): Promise<{ revoked: number; self: boolean }> {
	return hubPost("devices/revoke-auto", {});
}

export function revokeOtherHubDevices(): Promise<{ revoked: number }> {
	return hubPost("devices/revoke-others", {});
}

export function getHubSessions(signal?: AbortSignal): Promise<HubSessions> {
	return hubFetch("sessions", { signal });
}

export function getHubVersion(signal?: AbortSignal): Promise<HubVersion> {
	return hubFetch("version", { signal });
}

export function getHubProjects(signal?: AbortSignal): Promise<{ projects: HubProject[] }> {
	return hubFetch("projects", { signal });
}

/** The Mac this hub runs on (omp's `collab.displayName`). */
export function getHubMachine(signal?: AbortSignal): Promise<{ name: string }> {
	return hubFetch("machine", { signal });
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

/** The plan review open in the session's terminal (the plan text is cut by the hub when it is huge). */
export function getPlanReview(sessionId: string, signal?: AbortSignal): Promise<HubPlanReview> {
	return hubFetch(`sessions/${encodeURIComponent(sessionId)}/plan-review`, { signal });
}

/** Answer it like a local pick in the terminal. `role` is only valid with execute, compact and keep. */
export function answerPlanReview(sessionId: string, answer: PlanAnswerRequest): Promise<{ outcome: "accepted" }> {
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/plan-answer`, { ...answer });
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

export interface HubModelRef {
	provider: string;
	id: string;
	name?: string;
}

export interface HubSessionModes {
	plan: boolean;
	goal: boolean;
	loop: boolean;
	vibe: boolean;
}

/** What the session-control plugin reports: current model, thinking level, what can be picked, and the modes. */
export interface HubSessionInfo {
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	thinkingLevels: string[];
	models: HubModelRef[];
	mode: HubSessionModes;
	/** Per mode: inactive, active or paused (a goal can be paused). */
	modeStatus: Record<"plan" | "vibe" | "goal" | "loop", ModeStatus>;
	/** A compaction is still running in the session. */
	compacting?: boolean;
}

export type ModeStatus = "inactive" | "active" | "paused";

export type SessionCommand =
	| { op: "compact"; args: { instructions?: string } }
	| { op: "set-model"; args: { provider: string; id: string } }
	| { op: "set-thinking"; args: { level: string } }
	| {
			op: "set-mode";
			args: {
				mode: "plan" | "vibe" | "goal" | "loop";
				action: "enter" | "exit" | "pause" | "resume" | "drop";
				objective?: string;
			};
	  };

export function getSessionInfo(sessionId: string, signal?: AbortSignal): Promise<HubSessionInfo> {
	return hubFetch(`sessions/${encodeURIComponent(sessionId)}/session-info`, { signal });
}

/** Run a session command (compact, model, thinking level, mode) through the session-control plugin. */
export function sendSessionCommand(
	sessionId: string,
	command: SessionCommand,
): Promise<{ outcome: "ok" | "pending"; result?: unknown }> {
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/command`, { op: command.op, args: command.args });
}

/** The visible terminal screen as the hub read it. */
export interface HubScreen {
	pane: string;
	rows: string[];
	/** The viewport is scrolled back: it is not the live bottom of the terminal. */
	scrolled: boolean;
	revision: number | null;
	/** When the hub read the screen (epoch milliseconds). */
	capturedAt: number;
}

export type TerminalKey = "up" | "down" | "left" | "right" | "enter" | "esc" | "tab" | "backspace" | "space";

export interface TerminalSend {
	requestId: string;
	keys: TerminalKey[];
	text?: string;
}

export function getSessionScreen(sessionId: string, signal?: AbortSignal): Promise<HubScreen> {
	return hubFetch(`sessions/${encodeURIComponent(sessionId)}/screen`, { signal });
}

/** Type keys and/or one line of text into the session's terminal. Never retried: a repeat would type twice. */
export function sendSessionKeys(sessionId: string, send: TerminalSend): Promise<{ outcome: "sent" }> {
	const body: Record<string, unknown> = { requestId: send.requestId, keys: send.keys };
	if (send.text !== undefined) body.text = send.text;
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/keys`, body);
}

/** One quota window of an account (5 hours, weekly, …) as the hub read it from local usage records. */
export interface HubQuotaWindow {
	label: string | null;
	/** null unless the reading is current: a stale or unknown reading is never shown as 0 %. */
	usedPercent: number | null;
	resetsAt: number | null;
	observedAt: number | null;
	state: "ok" | "stale" | "unknown";
	/** 95 % or more used. */
	high: boolean;
}

export interface HubQuotaAccount {
	provider: string;
	label: string;
	/** active / quiet / needs_login / rate_limited. */
	state: string | null;
	windows: HubQuotaWindow[];
}

export interface HubQuota {
	/** When the hub's last session poll collected this; null before the first poll. Not "now": see cacheAgeMs. */
	generatedAt: number | null;
	/** How old that collection is at the hub's clock; null before the first poll. */
	cacheAgeMs: number | null;
	/** The hub has not collected for a while (its poll is failing): every reading here may be out of date. */
	cacheStale: boolean;
	source: string;
	accounts: HubQuotaAccount[];
	/** Accounts per provider (a provider with one account has no backup). */
	providers: Record<string, number>;
}

export type HubJobStatus = "running" | "ok" | "failed" | "not loaded" | "unknown";

/** One launchd agent the hub lists (read only). */
export interface HubJob {
	label: string;
	file: string;
	readable: boolean;
	/** "unreadable plist" when the file could not be parsed. */
	note: string | null;
	schedule: string | null;
	status: HubJobStatus;
	/** "last exit ok" / "last exit 1"; null while running, not loaded or unknown. */
	exit: string | null;
	pid: number | null;
	/** Newest modification time of its stdout/stderr files (ms): a log write, not necessarily a run. */
	lastLogWrite: number | null;
}

/** A stretch with no hub tick (Mac asleep or hub stopped). */
export interface HubGap {
	start: number;
	end: number;
	alerted: boolean;
}

export interface HubJobs {
	now: number;
	jobs: HubJob[];
	gaps: HubGap[];
}

export function getHubQuota(signal?: AbortSignal): Promise<HubQuota> {
	return hubFetch("quota", { signal });
}

export function getHubJobs(signal?: AbortSignal): Promise<HubJobs> {
	return hubFetch("jobs", { signal });
}
