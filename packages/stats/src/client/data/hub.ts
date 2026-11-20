/**
 * The omp hub's own API (`/api/hub/*`). The hub fronts this dashboard: it lists live omp sessions,
 * hands out Collab links for them, starts new ones, and sends phone alerts.
 */
import { ApiError } from "../api";
import { type FleetMachine, getFleet, machinePrefix, parseMachines } from "../app/machine";
import type { HubReportInfo } from "../routes/controlCenter";
import { noteUnauthorized } from "./pairing";
import { fetchRetrying } from "./restart-retry";

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
	/** Fleet mode: the id of the machine the session runs on. Every action on the row goes through that machine. */
	machine?: string;
	/** Fleet mode: the machine did not answer just now; this row is its last known state. */
	stale?: boolean;
	/** Cost of the session's transcript so far (USD), joined from the machine's stats; null when unknown. */
	costSoFar?: number | null;
	/** Last recorded activity in the transcript (epoch ms); null when unknown. */
	lastActivityAt?: number | null;
}

/** Fleet mode: how one machine answered the aggregated session list. */
export interface HubSessionsMachine {
	id: string;
	name: string;
	ok: boolean;
	error?: string | null;
	/** Reachable, but a request just failed: its rows are the last good answer (the hub's grace period). */
	stale?: boolean;
	/** When the rows of an unreachable or stale machine were last good (epoch ms). */
	staleSince?: number | null;
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
	/** Why it isn't available (null when it is); absent on an older hub. */
	reason?: HubTerminalReason | null;
}

export type HubTerminalReason = "not_scanned_yet" | "scan_failed" | "scan_stale" | "ambiguous_panes" | "not_in_herdr";

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

/** What a hub can do; a flag that is absent means an older hub that can't. */
export type HubCapability =
	| "askAnswer"
	| "sessionMessage"
	| "planNotes"
	| "sessionGoal"
	| "sessionInstructions"
	| "liveCost";

export interface HubVersion {
	hub: { commit: string | null; dirty: boolean | null; startedAt: number };
	ui: { buildId: string; builtAt: string | null } | null;
	capabilities?: HubCapabilities;
}

export interface HubCapabilities extends Partial<Record<HubCapability, boolean>> {
	jobsActions?: boolean;
	devicesLastSeen?: boolean;
	alertsPerRule?: boolean;
	relayViewers?: boolean;
	relayRebuild?: boolean;
}

export interface HubHerdrPlace {
	workspace: string | null;
	tab: string | null;
	pane: string | null;
}

export interface HubSessions {
	sessions: HubSession[];
	/** Fleet mode only. */
	machines?: HubSessionsMachine[];
	now: number;
}

export interface HubProject {
	path: string;
	name: string;
	label: string;
	last_used: number | null;
}

export interface RelayRebuildState {
	runId: string | null;
	state: "idle" | "preparing" | "building" | "restarting" | "done" | "failed" | "restart-needed";
	step: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	exitCode: number | null;
	message: string | null;
	tail: string[];
}

export interface HubRelayHealth {
	ok: boolean;
	error: string | null;
	rooms?: number | null;
	guests?: number | null;
	uptime_s?: number | null;
	build?: string | { ompTag?: string | null; bun?: string | null } | null;
	relayViewers?: boolean;
	needsUpdate?: boolean;
	canUnpair?: boolean;
	pairingMode?: string | null;
	viewers?: HubRelayViewer[] | null;
	lastAdmittedAt?: Record<string, number>;
	ownerConfigured?: boolean;
	rebuild?: RelayRebuildState;
}

export interface HubRelayViewer {
	room: string;
	peer: number;
	device8: string;
	connectedAt: number;
	ua: string;
}

export interface HubAlerts {
	enabled: boolean;
	server: string;
	topic: string | null;
	sent: number;
	last_sent_at: number | null;
	last_error: string | null;
	/** When the hub's session watcher last completed a pass (it can send). */
	watchOkAt?: number | null;
	rules?: Record<string, { lastFiredAt: number | null; sent: number }>;
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

/** A hub refusal: the `ApiError` plus the hub's optional `reason` (a 409 `changed` on a question says which). */
export class HubError extends ApiError {
	reason: string | null;

	constructor(status: number, endpoint: string, message: string, code: string | null, reason: string | null) {
		super(status, endpoint, message, code);
		this.reason = reason;
	}
}

/**
 * Hub-level calls omit the machine for the fleet session list, machines and memory. Machine-local
 * calls target an explicit machine; without a fleet the empty machine addresses the local hub.
 */
export async function hubFetch<T>(name: string, init?: RequestInit, machine?: string): Promise<T> {
	if (
		getFleet() &&
		!machine &&
		(["relay", "quota", "jobs", "projects", "start", "link"].includes(name) ||
			name.startsWith("sessions/") ||
			name.startsWith("jobs/") ||
			name.startsWith("relay/"))
	)
		throw new Error("Pick a machine");
	const endpoint = `${machinePrefix(machine)}/api/hub/${name}`;
	const res = await fetchRetrying(endpoint, init);
	if (res.status === 401) await noteUnauthorized(res);
	const body = (await res.json().catch(() => null)) as unknown;
	if (!res.ok) {
		const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
		const code = typeof body === "object" && body !== null && "code" in body ? body.code : null;
		const reason = typeof body === "object" && body !== null && "reason" in body ? body.reason : null;
		throw new HubError(
			res.status,
			endpoint,
			typeof error === "string" ? error : `HTTP error ${res.status}`,
			typeof code === "string" ? code : null,
			typeof reason === "string" ? reason : null,
		);
	}
	return body as T;
}

/**
 * Hub POSTs carry `X-Omp-Hub: 1`: a custom header forces a CORS preflight the hub never approves,
 * and the hub also checks Origin is the dashboard itself.
 */
export function hubPost<T>(name: string, body: Record<string, unknown>, machine?: string): Promise<T> {
	return hubFetch<T>(
		name,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Omp-Hub": "1" },
			body: JSON.stringify(body),
		},
		machine,
	);
}

export type HubDeviceScope = "tailnet" | "local";

export interface HubDevice {
	id: string;
	scope: HubDeviceScope;
	label: string;
	pairedAt: number;
	expiresAt: number | null;
	auto: boolean;
	lastSeen?: number | null;
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

/** The hub's version and capabilities; `machine` asks that machine's own hub (fleet mode). */
export function getHubVersion(signal?: AbortSignal, machine?: string): Promise<HubVersion> {
	return hubFetch("version", { signal }, machine);
}

export function getHubProjects(machine: string, signal?: AbortSignal): Promise<{ projects: HubProject[] }> {
	return hubFetch("projects", { signal }, machine);
}

export function getProjectParents(
	machine: string,
	signal?: AbortSignal,
): Promise<{ roots: string[]; parents: string[] }> {
	return hubFetch("project-parents", { signal }, machine);
}

export function createProject(machine: string, parent: string, name: string, git: boolean): Promise<{ path: string }> {
	return hubPost("projects/create", { parent, name, git }, machine);
}

/** The machines this hub fronts, with their health (fleet mode; a plain hub answers 404). */
export function getHubMachines(signal?: AbortSignal): Promise<FleetMachine[]> {
	return hubFetch<unknown>("machines", { signal }).then(body => {
		const machines = parseMachines(body);
		if (!machines) throw new ApiError(404, "/api/hub/machines", "Not a multi-machine hub");
		return machines;
	});
}

/** The Mac this hub runs on (omp's `collab.displayName`). */
export function getHubMachine(signal?: AbortSignal): Promise<{ name: string }> {
	return hubFetch("machine", { signal });
}

export function getHubRelay(machine: string, signal?: AbortSignal): Promise<HubRelayHealth> {
	return hubFetch("relay", { signal }, machine);
}

export function rebuildHubRelay(machine: string): Promise<RelayRebuildState> {
	return hubPost("relay/rebuild", { confirm: true }, machine);
}

export function getHubAlerts(signal?: AbortSignal, machine?: string): Promise<HubAlerts> {
	return hubFetch("alerts", { signal }, machine);
}

/** A fresh Collab link for the session's current room (full control, or view-only with `view`). */
export function getHubLink(
	instanceId: string,
	view: boolean,
	machine?: string,
): Promise<{ url: string; pairUrl?: string }> {
	return hubPost("link", { instanceId, view }, machine);
}

export function startHubSession(path: string, machine: string): Promise<HubStarted> {
	return hubPost("start", { path }, machine);
}

export function sendHubTestAlert(machine?: string): Promise<{ ok: boolean }> {
	return hubPost("alerts/test", {}, machine);
}

function sessionAction(
	sessionId: string,
	action: string,
	body: Record<string, unknown>,
	machine?: string,
): Promise<HubActionResult> {
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/${action}`, body, machine);
}

/** The plan review open in the session's terminal (the plan text is cut by the hub when it is huge). */
export function getPlanReview(sessionId: string, signal?: AbortSignal, machine?: string): Promise<HubPlanReview> {
	return hubFetch(`sessions/${encodeURIComponent(sessionId)}/plan-review`, { signal }, machine);
}

/** Answer it like a local pick in the terminal. `role` is only valid with execute, compact and keep. */
export function answerPlanReview(
	sessionId: string,
	answer: PlanAnswerRequest,
	machine?: string,
): Promise<{ outcome: "accepted" }> {
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/plan-answer`, { ...answer }, machine);
}

/** Interrupt the running turn (needs the omp-hub-control extension in that session). */
export function stopHubSession(sessionId: string, machine?: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "stop", {}, machine);
}

export function renameHubSession(sessionId: string, name: string, machine?: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "rename", { name }, machine);
}

/** End the session's omp process (SIGTERM); `confirm` is its exact name or project folder. */
export function killHubSession(sessionId: string, confirm: string, machine?: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "kill", { confirm }, machine);
}

/** SIGKILL, only accepted after Kill did not end the session. */
export function forceKillHubSession(sessionId: string, confirm: string, machine?: string): Promise<HubActionResult> {
	return sessionAction(sessionId, "force-kill", { confirm }, machine);
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

export interface HubSessionAdvisor {
	enabled: boolean;
	active: boolean;
	model: { provider: string; id: string } | null;
	advisors: { name: string; status: "running" | "paused" | "quota_exhausted" | "error" | "no_model" }[];
}

/** What the session-control plugin reports: current model, thinking level, what can be picked, and the modes. */
export interface HubSessionInfo {
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	thinkingLevels: string[];
	models: HubModelRef[];
	mode: HubSessionModes;
	/** null/absent: hub, plugin or omp too old to report it. */
	advisor?: HubSessionAdvisor | null;
	/** Per mode: inactive, active or paused (a goal can be paused). */
	modeStatus: Record<"plan" | "vibe" | "goal" | "loop", ModeStatus>;
	/** A compaction is still running in the session. */
	compacting?: boolean;
	/** The goal's objective (null: no goal, or an older plugin that doesn't report it). */
	goal?: HubSessionGoal | null;
	/** How a message reaches a running turn: `immediate` steers it, `wait` waits for it to end; null is unknown. */
	interruptMode?: "immediate" | "wait" | null;
	/** The latest approve-with-notes request of this instance, if any. */
	planNotes?: HubPlanNotesStatus | null;
}

export interface HubSessionGoal {
	objective: string;
	tokenBudget?: number;
}

/** `unknown`: the hub has no such instance or receipt (only `requestId` and `state` are then present). */
export type PlanNotesState = "pending" | "sent" | "failed" | "uncertain" | "unknown";

/** `GET .../plan-notes?requestId=`: where an approve-with-notes request stands. */
export interface HubPlanNotesStatus {
	requestId: string;
	reviewId?: string;
	choice?: "execute" | "compact" | "keep";
	approved?: boolean;
	state: PlanNotesState;
	reason?: string;
	at?: string;
}

export type ModeStatus = "inactive" | "active" | "paused";

export type SessionCommand =
	| { op: "compact"; args: { instructions?: string } }
	| { op: "set-model"; args: { provider: string; id: string } }
	| { op: "set-thinking"; args: { level: string } }
	| { op: "set-advisor"; args: { enabled?: boolean; provider?: string; id?: string } }
	| {
			op: "set-mode";
			args: {
				mode: "plan" | "vibe" | "goal" | "loop";
				action: "enter" | "exit" | "pause" | "resume" | "drop";
				objective?: string;
			};
	  };

export function getSessionInfo(sessionId: string, signal?: AbortSignal, machine?: string): Promise<HubSessionInfo> {
	return hubFetch(`sessions/${encodeURIComponent(sessionId)}/session-info`, { signal }, machine);
}

/** Run a session command (compact, model, thinking level, advisor, mode) through the session-control plugin. */
export function sendSessionCommand(
	sessionId: string,
	command: SessionCommand,
	machine?: string,
): Promise<{ outcome: "ok" | "pending"; result?: unknown }> {
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/command`, { op: command.op, args: command.args }, machine);
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

export function getSessionScreen(sessionId: string, signal?: AbortSignal, machine?: string): Promise<HubScreen> {
	return hubFetch(`sessions/${encodeURIComponent(sessionId)}/screen`, { signal }, machine);
}

/** Type keys and/or one line of text into the session's terminal. Never retried: a repeat would type twice. */
export function sendSessionKeys(sessionId: string, send: TerminalSend, machine?: string): Promise<{ outcome: "sent" }> {
	const body: Record<string, unknown> = { requestId: send.requestId, keys: send.keys };
	if (send.text !== undefined) body.text = send.text;
	return hubPost(`sessions/${encodeURIComponent(sessionId)}/keys`, body, machine);
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

export type HubJobStatus = "running" | "ok" | "failed" | "overdue" | "not loaded" | "unknown";

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
	kind?: "keepalive" | "scheduled" | "ondemand";
	loaded?: boolean;
	impact?: string | null;
	nextRun?: number | null;
	overdue?: boolean;
	lastRun?: { at: number | null; result: string | null; durationS: number | null } | null;
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

export function getHubQuota(machine: string, signal?: AbortSignal): Promise<HubQuota> {
	return hubFetch("quota", { signal }, machine);
}

export function getHubJobs(machine: string, signal?: AbortSignal): Promise<HubJobs> {
	return hubFetch("jobs", { signal }, machine);
}

export function runHubJob(
	machine: string,
	action: "run" | "restart",
	label: string,
	confirm: string,
	confirmImpact: boolean,
) {
	return hubPost<{ outcome: "accepted" }>(`jobs/${action}`, { label, confirm, confirmImpact }, machine);
}

export function getHubJobLogs(machine: string, label: string, signal?: AbortSignal) {
	return hubFetch<{ stdout?: string; stderr?: string; journal?: string; truncated: boolean }>(
		`jobs/logs?label=${encodeURIComponent(label)}`,
		{ signal },
		machine,
	);
}

export function disconnectHubViewer(machine: string, viewer: HubRelayViewer, unpair: boolean) {
	return hubPost<{ ok: boolean }>(
		"relay/disconnect",
		{
			room: viewer.room,
			peer: viewer.peer,
			device8: viewer.device8,
			unpair,
		},
		machine,
	);
}

export interface FlowModel {
	selector: string;
	provider: string;
	id: string;
	name: string;
	thinking: string[] | null;
}

export interface FlowRole {
	role: string;
	value: string | null;
	model: string | null;
	thinking: string | null;
	editable: boolean;
	usedBy: string[];
}

export interface ModelFlow {
	path: string;
	revision: string;
	roles: FlowRole[];
	models: FlowModel[];
}

export interface FlowChoice {
	model: string;
	thinking: string | null;
}

export function getModelFlow(signal?: AbortSignal): Promise<ModelFlow> {
	return hubFetch("model-flow", { signal });
}

export function saveModelFlow(
	revision: string,
	roles: Record<string, FlowChoice>,
): Promise<ModelFlow & { saved: string[] }> {
	return hubPost("model-flow", { revision, roles });
}

/** Thinking levels the hub accepts for `model`: same rule as model_flow.allowed_levels. */
export function flowLevels(model: FlowModel | undefined, selectors: ReadonlySet<string>): string[] {
	if (!model?.thinking?.length) return [];
	return ["auto", "off", ...model.thinking].filter(level => !selectors.has(`${model.selector}:${level}`));
}

export function getHubReports(signal?: AbortSignal): Promise<{ reports: HubReportInfo[] }> {
	return hubFetch("reports", { signal });
}

export function getHubReport<T>(id: string, signal?: AbortSignal): Promise<T> {
	return hubFetch(`reports/${encodeURIComponent(id)}`, { signal });
}

export function getHubReportPart<T>(id: string, part: string, signal?: AbortSignal): Promise<T> {
	return hubFetch(`reports/${encodeURIComponent(id)}/${encodeURIComponent(part)}`, { signal });
}

export async function fetchHubReportPdf(
	id: string,
	params: Record<string, string>,
): Promise<{ blob: Blob; filename: string }> {
	const endpoint = `${machinePrefix(undefined)}/api/hub/reports/${encodeURIComponent(id)}/pdf?${new URLSearchParams(params)}`;
	const res = await fetchRetrying(endpoint);
	if (res.status === 401) await noteUnauthorized(res);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new HubError(res.status, endpoint, body?.error ?? `HTTP error ${res.status}`, null, null);
	}
	const disposition = res.headers.get("Content-Disposition") ?? "";
	const filename =
		/filename="([^"]+)"/i.exec(disposition)?.[1] ?? /filename=([^;\s]+)/i.exec(disposition)?.[1] ?? "report.pdf";
	return { blob: await res.blob(), filename };
}
