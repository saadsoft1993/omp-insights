import { ArrowLeft, Eye, Pencil, Play, Power, Square, SquareTerminal } from "lucide-react";
import { type FormEvent, useMemo, useState, useSyncExternalStore } from "react";
import {
	forceKillHubSession,
	getHubLink,
	getHubProjects,
	getHubSessions,
	type HubProject,
	type HubSession,
	type HubSessions,
	killHubSession,
	type HubStarted,
	renameHubSession,
	startHubSession,
	stopHubSession,
} from "../data/hub";
import { useQuery } from "../data/query";
import { needsYou, RESTART_FOR_PLAN, RESTART_FOR_PLAN_OR_TERMINAL, terminalWaiting } from "../data/plan-review";
import {
	herdrPlace,
	killConfirmMatches,
	MAX_NAME_CHARS,
	nameProblem,
	sessionControls,
	sessionDisplayName,
} from "../data/session-controls";
import { Badge, Card, EmptyState, PageHeader, QueryView, SearchInput, TableSkeleton, type Tone } from "../ui";
import { ago, Help, type Notice, NoticeLine } from "./hub-common";
import { PlanReviewPanel } from "./PlanReviewPanel";
import { QuotaCard } from "./QuotaCard";
import { SessionCommandsPanel } from "./SessionCommandsPanel";
import { TerminalPanel } from "./TerminalPanel";

export interface SessionsRouteProps {
	active: boolean;
	/** Session named by the URL (`#/sessions/<sessionId>`), or null for the list. */
	selected: string | null;
	onSelect: (key: string | null) => void;
}

const REFRESH_MS = 5000;
const MAX_PROJECTS = 60;
const TERMINAL_WAITING_LABEL = "Waiting in terminal";
const TERMINAL_WAITING_TITLE = "detected from the screen";

function sessionState(s: HubSession): { label: string; tone: Tone } {
	if (needsYou(s)) return { label: "Needs you", tone: "warn" };
	if (s.busy === true) return { label: "Working", tone: "accent" };
	// Its own turn ended, but subagents it started are still running: the task isn't done.
	const agents = s.agentsRunning ?? 0;
	if (agents > 0) return { label: `Working · ${agents} subagent${agents === 1 ? "" : "s"}`, tone: "accent" };
	if (s.busy === false) return { label: "Idle", tone: "ok" };
	return { label: "Unknown", tone: "neutral" };
}

const RELAY_LABEL: Record<NonNullable<HubSession["relay"]>, { label: string; tone: Tone }> = {
	tailnet: { label: "This Mac's relay", tone: "ok" },
	public: { label: "Still on the public relay", tone: "warn" },
	unknown: { label: "Relay unknown", tone: "neutral" },
};

/** Needs you first, then working, then newest. */
function sessionOrder(a: HubSession, b: HubSession): number {
	const working = (s: HubSession) => Number(s.busy === true || (s.agentsRunning ?? 0) > 0);
	return (
		Number(needsYou(b)) - Number(needsYou(a)) || working(b) - working(a) || (b.startedAt ?? 0) - (a.startedAt ?? 0)
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * collab-web is its own origin (:8796): open it in a new tab, never inside the dashboard. The tab is
 * opened during the click itself (Safari blocks tabs opened after an await) and cut off from this page
 * before the link is fetched, so the link is current and the opened page can't reach back in here.
 */
async function openSession(instanceId: string, view: boolean): Promise<void> {
	const tab = window.open("about:blank", "_blank");
	if (tab) tab.opener = null;
	try {
		const { url } = await getHubLink(instanceId, view);
		if (tab) tab.location.replace(url);
		else window.open(url, "_blank", "noopener,noreferrer");
	} catch (error) {
		tab?.close();
		throw error;
	}
}

const WIDE_QUERY = "(min-width: 768px)";

/** iPad-sized and larger: list and detail side by side. Below it they are separate screens. */
function useWide(): boolean {
	return useSyncExternalStore(
		onChange => {
			const media = window.matchMedia(WIDE_QUERY);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		() => window.matchMedia(WIDE_QUERY).matches,
	);
}

/** What `#/sessions/<id>` names: omp's session id (the one alerts carry), else the Collab instance. */
function sessionKey(s: HubSession): string {
	return s.sessionId ?? s.instanceId;
}

function projectFolder(s: HubSession): string {
	return (s.cwd ?? "").split("/").filter(Boolean).pop() ?? "omp session";
}

/** "waiting 5m", or "waiting (age unknown)" when the hub did not see the wait begin (it restarted since). */
function waitingText(s: HubSession, now: number): string {
	// A plan review carries the time it opened, so its wait is known even when the hub restarted since.
	const known = s.waitingObserved || (!s.inputRequired && (s.planReview || terminalWaiting(s)));
	if (!known || !s.waitingSince) return "waiting (age unknown)";
	return `waiting ${ago(s.waitingSince, now).replace(" ago", "").replace("just now", "<1m")}`;
}

/** Waiting longest first; sessions whose wait the hub only noticed after a restart sort by when it noticed. */
function needsOrder(a: HubSession, b: HubSession): number {
	return (
		(a.waitingSince ?? Number.MAX_SAFE_INTEGER) - (b.waitingSince ?? Number.MAX_SAFE_INTEGER) ||
		(a.startedAt ?? 0) - (b.startedAt ?? 0)
	);
}

export function SessionsRoute({ active, selected, onSelect }: SessionsRouteProps) {
	const sessions = useQuery(["hub-sessions"], ({ signal }) => getHubSessions(signal), {
		enabled: active,
		pollMs: REFRESH_MS,
	});
	const [notice, setNotice] = useState<Notice | null>(null);
	const wide = useWide();
	// On a phone a selected session is a screen of its own: no page header, help or Start card around it.
	const detailScreen = !wide && selected !== null;

	const open = (instanceId: string, view: boolean) => {
		setNotice(null);
		openSession(instanceId, view).catch((error: unknown) => {
			setNotice({ tone: "bad", text: `Could not open: ${errorText(error)}` });
			sessions.refetch();
		});
	};

	return (
		<div className="page">
			{!detailScreen && (
				<PageHeader
					title="Sessions"
					description={
						sessions.data
							? `Every omp session on this Mac that shares through Collab. Updated ${new Date(sessions.data.now).toLocaleTimeString()} · refreshes every 5 seconds.`
							: "Every omp session on this Mac that shares through Collab."
					}
				/>
			)}
			{!detailScreen && (
				<Help summary="What can I do here?">
					<p>
						<b>Needs you</b> means it is waiting for your answer; <b>Working</b> means a turn is running (or
						subagents it started still are); <b>Idle</b> means it is waiting for a prompt. Needs you sessions are
						listed first, longest waiting on top. The hub only shows them: answer or approve inside the session
						with Open &amp; control.
					</p>
					<p>
						A <b>Plan to approve</b> badge means the session finished a plan and waits for your answer. Open the
						session here to read the plan and answer with the same choices the terminal offers: approve and
						execute, approve and compact, approve and keep context, refine with feedback, or save and quit. Edits
						made inside the terminal's review aren't shown here, and sessions started before plan support was
						installed need a restart first.
					</p>
					<p>
						<b>Open &amp; control</b> opens the session in a new tab where you can read it, send prompts, answer
						its questions, approve tools and stop a running turn. <b>Watch</b> opens the same view read-only: you
						see everything but can't type or press anything that changes the session. Use it when you only want to
						look, or to show someone.
					</p>
					<p>
						<b>Stop</b> (shown while it works) interrupts the running turn, like pressing Esc at the Mac; the
						session stays open. <b>Rename</b> changes the session's name. <b>Kill</b> ends the session's omp
						process, and any subagents it is running stop with it. Its transcript stays on the Mac: resume it
						there later with <code>omp --resume</code>. Every Stop, Rename and Kill is written to the hub's audit
						log.
					</p>
					<p>
						Stop and Rename need a small omp extension that sessions load when they start. A session that was
						already running when it was installed shows "Restart this session to enable Stop and Rename"; Kill
						works for every session.
					</p>
					<p>
						Both Open and Watch use this Mac's own relay, reachable only inside your tailnet and only from
						browsers you paired. The conversation is end-to-end encrypted between the session and your browser;
						the relay only passes sealed messages along.
					</p>
					<p>
						<b>Still on the public relay</b>: the session started before the switch to our relay and still shares
						through omp's public server (my.omp.sh). Its links are never opened from here, so its Open and Watch
						buttons are off. To fix it, at the Mac in that session run <code>/collab stop</code>, then{" "}
						<code>/collab</code>; it moves to this Mac's relay and the buttons come back within a few seconds.
					</p>
					<p>
						The <b>Session</b> card changes the model, thinking level and plan, goal and loop mode, and compacts
						the context; each change asks first and is written to the audit log (never the instructions or
						objective text). A session started before the session-control plugin was updated shows a restart hint
						instead. Each link is fetched fresh when you click, so it always points at the session's current room.
					</p>
					<p>
						<b>Waiting in terminal</b> means the hub read a dialog off the session's terminal screen (a Yes/No
						question, a list to pick from, a text prompt or a sign-in wait) that omp does not share through Open
						&amp; control. It is detected from the screen, so it can be late or, rarely, wrong. The{" "}
						<b>Terminal</b> panel answers it: turn on Control terminal to read the screen, then use the key pad or
						type one line. Text goes to whatever has focus in the terminal, and digits can pick options. It locks
						again when you switch session, leave the page or anything fails. If it says delivery is uncertain,
						read the screen before sending again: nothing is ever resent automatically.
					</p>
				</Help>
			)}

			<NoticeLine notice={notice} />
			{!detailScreen && <QuotaCard active={active} wide={wide} />}
			<QueryView
				query={sessions}
				skeleton={<TableSkeleton rows={3} />}
				isEmpty={data => data.sessions.length === 0 && !selected}
				empty={
					<Card>
						<EmptyState
							title="No live omp sessions"
							hint={
								<>
									Start one below, or run <code>omp</code> on the Mac.
								</>
							}
						/>
					</Card>
				}
			>
				{data => (
					<SessionsView
						data={data}
						selected={selected}
						wide={wide}
						onSelect={onSelect}
						onOpen={open}
						onChanged={sessions.refetch}
						onEnded={setNotice}
						active={active}
					/>
				)}
			</QueryView>

			{!detailScreen && <StartSession active={active} onStarted={sessions.refetch} />}
		</div>
	);
}

function SessionsView({
	data,
	selected,
	wide,
	onSelect,
	onOpen,
	onChanged,
	onEnded,
	active,
}: {
	data: HubSessions;
	selected: string | null;
	wide: boolean;
	onSelect: (key: string | null) => void;
	onOpen: (instanceId: string, view: boolean) => void;
	onChanged: () => void;
	onEnded: (notice: Notice) => void;
	active: boolean;
}) {
	const needs = useMemo(() => data.sessions.filter(needsYou).sort(needsOrder), [data.sessions]);
	const rest = useMemo(() => data.sessions.filter(s => !needsYou(s)).sort(sessionOrder), [data.sessions]);
	const current = selected ? data.sessions.find(s => sessionKey(s) === selected) : undefined;
	const showList = wide || !selected;
	const showDetail = wide || selected !== null;

	return (
		<div className="sess-split" data-wide={wide}>
			{showList && (
				<nav className="sess-list" aria-label="Sessions">
					{data.sessions.length === 0 && <p className="micro">No live omp sessions.</p>}
					{needs.length > 0 && (
						<div className="sess-group" data-needs="true">
							<h3 className="sess-group-title">Needs you · {needs.length}</h3>
							{needs.map(s => (
								<SessionRow
									key={s.instanceId}
									session={s}
									now={data.now}
									selected={sessionKey(s) === selected}
									onSelect={onSelect}
								/>
							))}
						</div>
					)}
					{rest.length > 0 && (
						<div className="sess-group">
							{needs.length > 0 && <h3 className="sess-group-title">Other sessions</h3>}
							{rest.map(s => (
								<SessionRow
									key={s.instanceId}
									session={s}
									now={data.now}
									selected={sessionKey(s) === selected}
									onSelect={onSelect}
								/>
							))}
						</div>
					)}
				</nav>
			)}
			{showDetail && (
				<section className="sess-detail" aria-label="Session">
					{current ? (
						<SessionDetail
							key={current.instanceId}
							session={current}
							now={data.now}
							showBack={!wide}
							onBack={() => onSelect(null)}
							onOpen={onOpen}
							onChanged={onChanged}
							onEnded={onEnded}
							active={active}
						/>
					) : selected ? (
						<Card>
							<EmptyState
								title="Session ended"
								hint="It is no longer running, or it stopped sharing. Its transcript stays on the Mac."
							/>
							<div className="hub-actions">
								<button type="button" className="btn" data-variant="accent" onClick={() => onSelect(null)}>
									<ArrowLeft size={14} /> Back to sessions
								</button>
							</div>
						</Card>
					) : (
						<Card>
							<EmptyState title="Pick a session" hint="Its details and actions show here." />
						</Card>
					)}
				</section>
			)}
		</div>
	);
}

function SessionRow({
	session: s,
	now,
	selected,
	onSelect,
}: {
	session: HubSession;
	now: number;
	selected: boolean;
	onSelect: (key: string) => void;
}) {
	const state = sessionState(s);
	const sub = [s.workspace ?? "Other", projectFolder(s), needsYou(s) ? waitingText(s, now) : null].filter(Boolean);
	return (
		<button
			type="button"
			className="sess-row"
			data-selected={selected}
			aria-current={selected ? "true" : undefined}
			onClick={() => onSelect(sessionKey(s))}
		>
			<span className="sess-row-main">
				<span className="sess-row-name truncate">{sessionDisplayName(s)}</span>
				<span className="sess-row-sub truncate">{sub.join(" · ")}</span>
			</span>
			<span className="sess-row-badges">
				<Badge tone={state.tone}>{state.label}</Badge>
				{s.planReview && <Badge tone="accent">Plan to approve</Badge>}
				{terminalWaiting(s) && (
					<Badge tone="warn" title={TERMINAL_WAITING_TITLE}>
						{TERMINAL_WAITING_LABEL}
					</Badge>
				)}
			</span>
		</button>
	);
}

function SessionDetail({
	session: s,
	now,
	showBack,
	onBack,
	onOpen,
	onChanged,
	onEnded,
	active,
}: {
	session: HubSession;
	now: number;
	showBack: boolean;
	onBack: () => void;
	onOpen: (instanceId: string, view: boolean) => void;
	onChanged: () => void;
	onEnded: (notice: Notice) => void;
	active: boolean;
}) {
	const state = sessionState(s);
	const relay = RELAY_LABEL[s.relay ?? "unknown"];
	const isPublic = s.relay === "public";
	const place = herdrPlace(s);
	const waiting = terminalWaiting(s);
	const terminalOn = s.terminal?.available === true && Boolean(s.sessionId);
	const ctl = useSessionControlState(s, onChanged, onEnded);
	/** Counts successful terminal sends: the Session card re-reads what the session reports after each. */
	const [sent, setSent] = useState(0);
	const facts = [
		s.model?.id,
		s.startedAt ? `started ${ago(s.startedAt, now)}` : null,
		s.participants !== undefined ? `${s.participants} connected` : null,
		s.pid !== undefined ? `pid ${s.pid}` : null,
	].filter(Boolean);
	return (
		<div className="sess-detail-inner">
			{showBack && (
				<button type="button" className="btn sess-back" data-variant="ghost" onClick={onBack}>
					<ArrowLeft size={16} /> Sessions
				</button>
			)}
			<div className="sess-actionbar">
				<button
					type="button"
					className="btn"
					data-variant="accent"
					disabled={isPublic}
					title={isPublic ? "Still on the public relay" : "Open in a new tab with full control"}
					onClick={() => onOpen(s.instanceId, false)}
				>
					<SquareTerminal size={14} /> Open &amp; control
				</button>
				<button
					type="button"
					className="btn"
					disabled={isPublic}
					title={isPublic ? "Still on the public relay" : "Open read-only in a new tab"}
					onClick={() => onOpen(s.instanceId, true)}
				>
					<Eye size={14} /> Watch
				</button>
				{ctl.controls.showStop && (
					<button
						type="button"
						className="btn"
						disabled={!ctl.controls.stop.enabled || ctl.pending !== null}
						title={ctl.controls.stop.reason ?? "Interrupt the running turn; the session stays open"}
						onClick={ctl.stop}
					>
						<Square size={13} /> {ctl.pending === "Stop" ? "Stopping…" : "Stop"}
					</button>
				)}
			</div>
			<Card
				title={<span className="truncate">{sessionDisplayName(s)}</span>}
				description={(s.cwd ?? "").replace(/^\/Users\/[^/]+/, "~")}
				actions={<Badge tone={state.tone}>{state.label}</Badge>}
			>
				<div className="hub-session-meta">
					<Badge tone="neutral">{s.workspace ?? "Other"}</Badge>
					{needsYou(s) && <Badge tone="warn">{waitingText(s, now)}</Badge>}
					{s.planReview && <Badge tone="accent">Plan to approve</Badge>}
					{waiting && (
						<Badge tone="warn" title={TERMINAL_WAITING_TITLE}>
							{TERMINAL_WAITING_LABEL}
						</Badge>
					)}
					<Badge tone={relay.tone}>{relay.label}</Badge>
					{s.relayConnected === false && <Badge tone="bad">Relay offline</Badge>}
					{place && <Badge tone="neutral">{place}</Badge>}
					<span className="micro">{facts.join(" · ")}</span>
				</div>
				{s.inputRequired && (
					<p className="micro">Answer or approve inside the session: choose Open &amp; control.</p>
				)}
				{waiting && (
					<p className="micro">
						Waiting in terminal: <span className="term-line">{waiting.line}</span>. Answer it in the Terminal
						panel below, or choose Open &amp; control.
					</p>
				)}
				{s.planControl === "restart_needed" && (
					<p className="hub-warn">{terminalOn ? RESTART_FOR_PLAN_OR_TERMINAL : RESTART_FOR_PLAN}</p>
				)}
				{isPublic && (
					<p className="hub-warn">
						Still on the public relay, so it can't be opened from here. Fix: in that session run{" "}
						<code>/collab stop</code>, then <code>/collab</code>.
					</p>
				)}
				<ManagePanel session={s} ctl={ctl} />
			</Card>
			{s.planControl === "supported" && s.sessionId && <PlanReviewPanel session={s} onChanged={onChanged} />}
			{s.sessionId && <SessionCommandsPanel session={s} onChanged={onChanged} refreshToken={sent} active={active} />}
			{terminalOn && <TerminalPanel session={s} active={active} onSent={() => setSent(n => n + 1)} />}
		</div>
	);
}

type Panel = "rename" | "kill" | null;

function useSessionControlState(s: HubSession, onChanged: () => void, onEnded: (notice: Notice) => void) {
	const controls = sessionControls(s);
	const name = sessionDisplayName(s);
	const [panel, setPanel] = useState<Panel>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [newName, setNewName] = useState("");
	const [typed, setTyped] = useState("");
	const [forceOffered, setForceOffered] = useState(false);
	const [forceConfirming, setForceConfirming] = useState(false);
	const sessionId = s.sessionId ?? "";

	const run = async (label: string, action: () => Promise<void>) => {
		setPending(label);
		setNotice(null);
		try {
			await action();
		} catch (error) {
			setNotice({ tone: "bad", text: `${label} failed: ${errorText(error)}` });
		} finally {
			setPending(null);
			onChanged();
		}
	};

	const stop = () =>
		run("Stop", async () => {
			const r = await stopHubSession(sessionId);
			setNotice({
				tone: "ok",
				text:
					r.outcome === "stopped"
						? "Stopped the running turn. The session is still open."
						: "Nothing was running.",
			});
		});

	const rename = (event: FormEvent) => {
		event.preventDefault();
		run("Rename", async () => {
			const r = await renameHubSession(sessionId, newName);
			setPanel(null);
			setNotice({ tone: "ok", text: `Renamed to “${r.name ?? newName.trim()}”.` });
		});
	};

	const kill = (event: FormEvent) => {
		event.preventDefault();
		run("Kill", async () => {
			const r = await killHubSession(sessionId, typed);
			if (r.outcome === "exited") {
				setPanel(null);
				// The card disappears with the session, so the outcome is shown above the list.
				onEnded({
					tone: "ok",
					text: `“${name}” has ended. Its transcript is kept: resume it at the Mac with omp --resume.`,
				});
				return;
			}
			setForceOffered(true);
			setNotice({
				tone: "bad",
				text: "It is still running 10 seconds after being asked to end. Wait a little and refresh, or use Force kill.",
			});
		});
	};

	const forceKill = () =>
		run("Force kill", async () => {
			const r = await forceKillHubSession(sessionId, typed);
			setForceConfirming(false);
			if (r.outcome === "force_exited") {
				setPanel(null);
				setForceOffered(false);
				onEnded({
					tone: "ok",
					text: `“${name}” was force-killed. Its transcript up to that moment is kept: resume it with omp --resume.`,
				});
			} else {
				setNotice({ tone: "bad", text: "It is still running even after Force kill; check it at the Mac." });
			}
		});

	const toggle = (next: Panel) => {
		setNotice(null);
		setForceOffered(false);
		setForceConfirming(false);
		setPanel(panel === next ? null : next);
		if (next === "rename") setNewName(s.sessionName ?? "");
		if (next === "kill") setTyped("");
	};

	return {
		controls,
		name,
		panel,
		setPanel,
		pending,
		notice,
		newName,
		setNewName,
		typed,
		setTyped,
		forceOffered,
		forceConfirming,
		setForceConfirming,
		stop,
		rename,
		kill,
		forceKill,
		toggle,
	};
}

type Controls = ReturnType<typeof useSessionControlState>;

/** Rename and Kill (with Force kill only after a Kill that did not end the session); Stop lives in the action bar. */
function ManagePanel({ session: s, ctl }: { session: HubSession; ctl: Controls }) {
	const {
		controls,
		name,
		panel,
		setPanel,
		pending,
		notice,
		newName,
		setNewName,
		typed,
		setTyped,
		forceOffered,
		forceConfirming,
		setForceConfirming,
		rename,
		kill,
		forceKill,
		toggle,
	} = ctl;
	const extensionReason = controls.rename.enabled ? null : controls.rename.reason;
	return (
		<div className="hub-controls">
			<div className="hub-actions">
				<button
					type="button"
					className="btn"
					disabled={!controls.rename.enabled || pending !== null}
					title={controls.rename.reason ?? "Change this session's name"}
					aria-expanded={panel === "rename"}
					onClick={() => toggle("rename")}
				>
					<Pencil size={13} /> Rename
				</button>
				<button
					type="button"
					className="btn"
					data-variant="danger"
					disabled={!controls.kill.enabled || pending !== null}
					title={controls.kill.reason ?? "End this session's omp process"}
					aria-expanded={panel === "kill"}
					onClick={() => toggle("kill")}
				>
					<Power size={13} /> Kill
				</button>
			</div>
			{extensionReason && <p className="micro hub-reason">{extensionReason}</p>}
			{panel === "rename" && (
				<form className="hub-inline-form" onSubmit={rename}>
					<label className="micro" htmlFor={`rename-${s.instanceId}`}>
						New name (1–{MAX_NAME_CHARS} characters, no invisible characters)
					</label>
					<div className="hub-inline-row">
						<input
							id={`rename-${s.instanceId}`}
							className="input"
							value={newName}
							maxLength={MAX_NAME_CHARS}
							onChange={event => setNewName(event.target.value)}
						/>
						<button
							type="submit"
							className="btn"
							data-variant="primary"
							disabled={nameProblem(newName) !== null || pending !== null}
							title={nameProblem(newName) ?? undefined}
						>
							{pending === "Rename" ? "Saving…" : "Save"}
						</button>
						<button type="button" className="btn" data-variant="ghost" onClick={() => setPanel(null)}>
							Cancel
						</button>
					</div>
				</form>
			)}
			{panel === "kill" && (
				<form className="hub-inline-form hub-danger" onSubmit={kill}>
					<p>
						Kill ends this session's omp process, and any subagents it is running stop with it. Its transcript
						stays on the Mac: resume it later with <code>omp --resume</code>.
					</p>
					<label className="micro" htmlFor={`kill-${s.instanceId}`}>
						To confirm, type the session's name <b>{name}</b>
						{s.sessionName ? " (or its project folder's name)" : ""}
					</label>
					<div className="hub-inline-row">
						<input
							id={`kill-${s.instanceId}`}
							className="input"
							value={typed}
							autoComplete="off"
							onChange={event => setTyped(event.target.value)}
						/>
						<button
							type="submit"
							className="btn"
							data-variant="danger"
							disabled={!killConfirmMatches(s, typed) || pending !== null}
						>
							{pending === "Kill" ? "Ending…" : "Kill session"}
						</button>
						<button type="button" className="btn" data-variant="ghost" onClick={() => setPanel(null)}>
							Cancel
						</button>
					</div>
					{forceOffered && !forceConfirming && (
						<button
							type="button"
							className="btn"
							data-variant="danger"
							disabled={pending !== null}
							onClick={() => setForceConfirming(true)}
						>
							Force kill…
						</button>
					)}
					{forceConfirming && (
						<div className="hub-inline-form">
							<p>
								Force kill stops it at once, without letting it finish writing or close its subagents cleanly.
								Only use it when Kill did not work.
							</p>
							<div className="hub-inline-row">
								<button
									type="button"
									className="btn"
									data-variant="danger"
									disabled={!killConfirmMatches(s, typed) || pending !== null}
									onClick={forceKill}
								>
									{pending === "Force kill" ? "Force killing…" : "Yes, force kill"}
								</button>
								<button
									type="button"
									className="btn"
									data-variant="ghost"
									onClick={() => setForceConfirming(false)}
								>
									No
								</button>
							</div>
						</div>
					)}
				</form>
			)}
			<NoticeLine notice={notice} />
		</div>
	);
}

function startedText(project: HubProject, r: HubStarted): string {
	const where = r.herdrWorkspace ? `herdr: ${r.herdrWorkspace} › ${r.tab ?? "omp"}` : "a new herdr tab";
	return r.instanceId
		? `Started ${project.name} in ${where}. It is listed above: click Open & control to talk to it.`
		: `Started ${project.name} in ${where}; it is not sharing yet and shows up above in a few seconds.`;
}

function StartSession({ active, onStarted }: { active: boolean; onStarted: () => void }) {
	const projects = useQuery(["hub-projects"], ({ signal }) => getHubProjects(signal), { enabled: active });
	const [query, setQuery] = useState("");
	const [starting, setStarting] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		const all = projects.data?.projects ?? [];
		return all.filter(p => !q || p.label.toLowerCase().includes(q)).slice(0, MAX_PROJECTS);
	}, [projects.data, query]);

	const start = async (project: HubProject) => {
		setStarting(project.path);
		setNotice(null);
		try {
			const r = await startHubSession(project.path);
			onStarted();
			setNotice({ tone: "ok", text: startedText(project, r) });
		} catch (error) {
			setNotice({ tone: "bad", text: `Could not start: ${errorText(error)}` });
		} finally {
			setStarting(null);
		}
	};

	return (
		<Card
			title="Start a session"
			description="Most recently used projects first"
			actions={
				<SearchInput value={query} onChange={setQuery} placeholder="Search projects" label="Search projects" />
			}
		>
			<Help summary="What does Start do?">
				<p>
					Starts a new omp session in that project on the Mac, in herdr: a new tab called <b>omp</b> in the
					project's herdr workspace (a workspace named after the project is created when there is none). At the Mac
					you find it in herdr's sidebar. It uses your default model. Once it shows up above, click{" "}
					<b>Open &amp; control</b> to talk to it.
				</p>
			</Help>
			<NoticeLine notice={notice} />
			<QueryView
				query={projects}
				skeleton={<TableSkeleton rows={4} />}
				isEmpty={() => matches.length === 0}
				empty={<EmptyState title="No matching project" />}
			>
				{() => (
					<ul className="hub-projects">
						{matches.map(p => (
							<li key={p.path} className="hub-project">
								<div className="stack">
									<span className="hub-project-name truncate">{p.name}</span>
									<span className="micro truncate">
										{p.label}
										{p.last_used ? ` · used ${ago(p.last_used)}` : ""}
									</span>
								</div>
								<button
									type="button"
									className="btn"
									data-size="sm"
									disabled={starting !== null}
									onClick={() => start(p)}
								>
									<Play size={13} /> {starting === p.path ? "Starting…" : "Start"}
								</button>
							</li>
						))}
					</ul>
				)}
			</QueryView>
		</Card>
	);
}
