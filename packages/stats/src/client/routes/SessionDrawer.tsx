import { type FormEvent, useState } from "react";
import { formatCost } from "../data/formatters";
import {
	forceKillHubSession,
	type HubSession,
	type HubSessionInfo,
	type HubSessionsMachine,
	killHubSession,
	renameHubSession,
	stopHubSession,
} from "../data/hub";
import { RESTART_FOR_PLAN, RESTART_FOR_PLAN_OR_TERMINAL, terminalWaiting } from "../data/plan-review";
import { type CapabilityCheck, capabilityState, updateHubHint, useHubVersion } from "../data/session-capabilities";
import { RESTART_FOR_COMMANDS } from "../data/session-commands";
import {
	herdrPlace,
	killConfirmMatches,
	MAX_NAME_CHARS,
	nameProblem,
	RESTART_FOR_CONTROLS,
	sessionControls,
	sessionDisplayName,
} from "../data/session-controls";
import type { NotesChoice } from "../data/session-plan-notes";
import { projectFolder, sessionStatus, terminalAccess } from "../data/session-view";
import { Drawer, Modal, StatusCell } from "../ui";
import { ago, type Notice, NoticeLine } from "./hub-common";
import { CapabilityCheckContext } from "./CapabilityChecking";
import { type PlanNotesControl, PlanReviewPanel } from "./PlanReviewPanel";
import { SessionAskPanel } from "./SessionAskPanel";
import { SessionCommandsPanel } from "./SessionCommandsPanel";
import { SessionInstructionsPanel } from "./SessionInstructionsPanel";
import { SessionMessagePanel } from "./SessionMessagePanel";
import { TerminalPanel } from "./TerminalPanel";

type Tab = "session" | "plan" | "terminal" | "instructions";

/** One approve-with-notes request the page follows, shown in its session's drawer. */
export interface NotesJob {
	state: "pending" | "done";
	tone: "ok" | "bad" | "warn";
	text: string;
	/** Not settled when the page stopped waiting: the request a read-only "Check again" follows. */
	recheck?: { instanceId: string; requestId: string; machine: string | undefined };
}

function home(path: string): string {
	return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** "waiting 5m", or "waiting (age unknown)" when the hub did not see the wait begin. */
export function waitingText(s: HubSession, now: number): string {
	const known = s.waitingObserved || (!s.inputRequired && (s.planReview || terminalWaiting(s)));
	if (!known || !s.waitingSince) return "waiting (age unknown)";
	return `waiting ${ago(s.waitingSince, now).replace(" ago", "").replace("just now", "<1m")}`;
}

/**
 * A live session's controls: header facts and actions, then the Session, Plan to approve, Terminal and Instructions
 * tabs. Every request goes to the session's own machine.
 */
export function SessionDrawer({
	session: s,
	now,
	machineName,
	down,
	active,
	onClose,
	onOpen,
	onChanged,
	onEnded,
	notesJob,
	startNotes,
	onRecheckNotes,
}: {
	session: HubSession;
	now: number;
	machineName: string;
	/** The session's machine is unreachable: this is its last known state. */
	down: HubSessionsMachine | null;
	active: boolean;
	onClose: () => void;
	onOpen: (session: HubSession, view: boolean) => void;
	onChanged: () => void;
	onEnded: (notice: Notice) => void;
	notesJob: NotesJob | null;
	onRecheckNotes: () => void;
	startNotes: (
		session: HubSession,
		request: { reviewId: string; choice: NotesChoice; notes: string; role?: string },
	) => Promise<void>;
}) {
	const status = sessionStatus(s);
	const waiting = terminalWaiting(s);
	const terminal = terminalAccess(s, machineName);
	const terminalOn = terminal.on;
	const [tab, setTab] = useState<Tab>(s.planReview ? "plan" : "session");
	const [wide, setWide] = useState(false);
	const [info, setInfo] = useState<HubSessionInfo | null>(null);
	const [sent, setSent] = useState(0);
	const version = useHubVersion(s.machine, active && !down);
	const caps = version.data ?? null;
	const capability = (name: Parameters<typeof capabilityState>[1]) => (down ? "unknown" : capabilityState(caps, name));
	const locked = down ? `${machineName} is unreachable` : null;
	const check: CapabilityCheck = {
		error: version.data ? null : (version.error?.message ?? null),
		retry: version.refetch,
		unavailable: locked,
	};
	const ctl = useManage(s, onChanged, onEnded);
	const controls = sessionControls(s);
	const place = herdrPlace(s);
	const isPublic = s.relay === "public";
	const oldPlugin = s.control === false;
	const tabs: { id: Tab; label: string; flag: boolean }[] = [
		{ id: "session", label: "Session", flag: Boolean(s.inputRequired) || waiting?.kind === "oauth" },
		...(s.planReview ? [{ id: "plan" as const, label: "Plan to approve", flag: true }] : []),
		// Always listed: when the terminal can't be read, the tab says why instead of disappearing.
		{ id: "terminal", label: "Terminal", flag: terminalOn && waiting !== null },
		{ id: "instructions", label: "Instructions", flag: false },
	];
	const shown: Tab = tabs.some(t => t.id === tab) ? tab : "session";
	const notes: PlanNotesControl = {
		capability: capability("planNotes"),
		machineName,
		pending: notesJob?.state === "pending",
		start: request => startNotes(s, request),
	};
	const openOff = locked ?? (isPublic ? "Still on the public relay" : null);

	return (
		<CapabilityCheckContext.Provider value={check}>
			<Drawer
				open
				onClose={onClose}
				width={shown === "plan" && wide ? 1100 : 660}
				title={<span className="truncate">{sessionDisplayName(s)}</span>}
				subtitle={
					<span className="sd-sub">
						<span>{machineName}</span>
						<span aria-hidden="true">·</span>
						<span className="mono">{home(s.cwd ?? "")}</span>
						<StatusCell tone={status.tone} live={status.live}>
							{status.label}
						</StatusCell>
					</span>
				}
			>
				<div className="sd-head">
					<div className="sd-meta">
						{s.model?.id && <span>{s.model.provider ? `${s.model.provider}/${s.model.id}` : s.model.id}</span>}
						{s.startedAt && <span>started {ago(s.startedAt, now)}</span>}
						{s.pid !== undefined && <span>pid {s.pid}</span>}
						{place && <span>{place}</span>}
						<span>
							{s.relay === "public"
								? "public relay"
								: s.relay === "tailnet"
									? "this machine's relay"
									: "relay unknown"}
						</span>
						{s.relayConnected === false && <span data-tone="bad">relay offline</span>}
					</div>
					<div className="sd-actions">
						<button
							type="button"
							className="btn"
							data-variant="primary"
							disabled={openOff !== null}
							title={openOff ?? "Open in a new tab with full control"}
							onClick={() => onOpen(s, false)}
						>
							Open &amp; control
						</button>
						<button
							type="button"
							className="btn"
							disabled={openOff !== null}
							title={openOff ?? "Open read-only in a new tab"}
							onClick={() => onOpen(s, true)}
						>
							Watch
						</button>
						<button
							type="button"
							className="btn"
							disabled={locked !== null || !controls.rename.enabled || ctl.pending !== null}
							title={locked ?? controls.rename.reason ?? "Change this session's name"}
							aria-expanded={ctl.renaming}
							onClick={ctl.openRename}
						>
							Rename
						</button>
						{controls.showStop && !down && (
							<button
								type="button"
								className="btn"
								disabled={!controls.stop.enabled || ctl.pending !== null}
								title={controls.stop.reason ?? "Interrupt the running turn; the session stays open"}
								onClick={ctl.stop}
							>
								{ctl.pending === "Stop" ? "Stopping…" : "Stop"}
							</button>
						)}
						<button
							type="button"
							className="btn"
							data-variant="danger"
							disabled={locked !== null || !controls.kill.enabled || ctl.pending !== null}
							title={locked ?? controls.kill.reason ?? "End this session's omp process"}
							onClick={ctl.openKill}
						>
							Kill…
						</button>
					</div>
					{ctl.renaming && (
						<form className="sd-rename" onSubmit={ctl.rename}>
							<input
								type="text"
								className="input"
								aria-label="Session name"
								value={ctl.newName}
								aria-invalid={nameProblem(ctl.newName) !== null}
								onChange={event => ctl.setNewName(event.target.value)}
							/>
							<span className="sd-hint" data-tone={nameProblem(ctl.newName) ? "bad" : undefined}>
								{nameProblem(ctl.newName) ?? `1–${MAX_NAME_CHARS} characters. Shown in the list and in herdr.`}
							</span>
							<div className="sd-row">
								<button
									type="submit"
									className="btn"
									data-size="sm"
									data-variant="primary"
									disabled={nameProblem(ctl.newName) !== null || ctl.pending !== null}
								>
									{ctl.pending === "Rename" ? "Saving…" : "Save name"}
								</button>
								<button
									type="button"
									className="btn"
									data-size="sm"
									data-variant="ghost"
									onClick={ctl.closeRename}
								>
									Cancel
								</button>
							</div>
						</form>
					)}
					<NoticeLine notice={ctl.notice} />
					{notesJob && (
						<div className="sd-row">
							<p className="sd-result" data-tone={notesJob.tone} role="status">
								{notesJob.text}
							</p>
							{notesJob.recheck && (
								<button type="button" className="btn" data-size="sm" onClick={onRecheckNotes}>
									Check again
								</button>
							)}
						</div>
					)}
				</div>
				<div className="sd-tabs" role="tablist" aria-label="Session sections">
					{tabs.map(t => (
						<button
							key={t.id}
							type="button"
							role="tab"
							className="sd-tab"
							aria-selected={shown === t.id}
							onClick={() => setTab(t.id)}
						>
							{t.label}
							{t.flag && (
								<span className="sd-flag" aria-label="needs attention">
									!
								</span>
							)}
						</button>
					))}
				</div>
				<div className="sd-body" role="tabpanel">
					{/* The Session tab stays mounted (hidden) so its settings keep up with terminal sends. */}
					<div className="sd-body" hidden={shown !== "session"}>
						{down && (
							<div className="sd-callout" data-tone="bad" role="status">
								<b>{machineName} is unreachable</b>
								{down.staleSince ? ` since ${new Date(down.staleSince).toLocaleTimeString()}` : ""}. This is the
								session's last known state; every control is off until the machine answers.
							</div>
						)}
						{oldPlugin && !down && (
							<div className="sd-callout" data-tone="info">
								<b>Older plugin.</b> {RESTART_FOR_CONTROLS} Kill still works. To restart: Kill, then run{" "}
								<code className="mono">omp --resume</code> in <span className="mono">{home(s.cwd ?? "")}</span>.
							</div>
						)}
						{s.planControl === "restart_needed" && !down && (
							<p className="hub-warn">{terminalOn ? RESTART_FOR_PLAN_OR_TERMINAL : RESTART_FOR_PLAN}</p>
						)}
						{s.inputRequired && s.sessionId && (
							<SessionAskPanel
								session={s}
								machineName={machineName}
								capability={capability("askAnswer")}
								interruptMode={info ? (info.interruptMode ?? null) : undefined}
								locked={locked}
								waitingText={waitingText(s, now)}
								onOpen={() => onOpen(s, false)}
								onChanged={onChanged}
							/>
						)}
						{waiting?.kind === "oauth" && (
							<div className="sd-callout" data-tone="accent" role="status">
								<b>Waiting on login.</b> The terminal shows a sign-in prompt:{" "}
								<span className="mono">{waiting.line}</span>
								<p>
									Finish the sign-in in the browser it opened, then paste the code in the Terminal tab, or at
									the Mac.
								</p>
								{terminalOn && (
									<div className="sd-row">
										<button
											type="button"
											className="btn"
											data-size="sm"
											data-variant="primary"
											onClick={() => setTab("terminal")}
										>
											Open the terminal
										</button>
									</div>
								)}
							</div>
						)}
						{waiting && waiting.kind !== "oauth" && (
							<div className="sd-callout" data-tone="accent" role="status">
								<b>Waiting in terminal:</b> <span className="mono">{waiting.line}</span>
								<p>Detected from the screen; answer it in the Terminal tab or with Open &amp; control.</p>
							</div>
						)}
						{s.planReview && (
							<div className="sd-callout" data-tone="accent" role="status">
								<b>Plan to approve:</b> {s.planReview.title} · opened{" "}
								{ago(Date.parse(s.planReview.openedAt), now) || "just now"}
								<div className="sd-row">
									<button
										type="button"
										className="btn"
										data-size="sm"
										data-variant="primary"
										onClick={() => setTab("plan")}
									>
										Review the plan
									</button>
								</div>
							</div>
						)}
						<section className="sd-sec" aria-label="Session facts">
							<h3>Session</h3>
							<dl className="sd-grid">
								<dt>Project</dt>
								<dd>
									{s.workspace ?? "Other"} · {projectFolder(s) || "omp session"}
								</dd>
								<dt>Folder</dt>
								<dd className="mono">{s.cwd ?? "Unknown"}</dd>
								<dt>Last activity</dt>
								<dd>{s.lastActivityAt ? ago(s.lastActivityAt, now) : "Not reported"}</dd>
								<dt>Subagents</dt>
								<dd>{s.agentsRunning ? `${s.agentsRunning} running` : "none running"}</dd>
								<dt>Cost so far</dt>
								<dd className="num">
									{typeof s.costSoFar === "number"
										? formatCost(s.costSoFar)
										: s.costSoFar === undefined
											? updateHubHint(machineName, "liveCost")
											: "Not recorded yet"}
								</dd>
								<dt>Started</dt>
								<dd>{s.startedAt ? new Date(s.startedAt).toLocaleString() : "Unknown"}</dd>
							</dl>
						</section>
						{s.sessionId && (
							<SessionMessagePanel
								session={s}
								machineName={machineName}
								capability={capability("sessionMessage")}
								interruptMode={info ? (info.interruptMode ?? null) : undefined}
								locked={locked ?? (oldPlugin ? RESTART_FOR_COMMANDS : null)}
							/>
						)}
						{s.sessionId && !down && (
							<SessionCommandsPanel
								session={s}
								onChanged={onChanged}
								refreshToken={sent}
								active={active}
								onInfo={setInfo}
								lockedReason={locked}
								goalHint={
									capability("sessionGoal") === "off"
										? updateHubHint(machineName, "sessionGoal")
										: "The session's plugin does not report the objective; restart the session after updating it."
								}
							/>
						)}
					</div>
					{shown === "plan" && (
						<>
							<div className="sd-row">
								<button
									type="button"
									className="btn"
									data-size="sm"
									data-variant="ghost"
									onClick={() => setWide(w => !w)}
								>
									{wide ? "Narrow view" : "Read it wider"}
								</button>
							</div>
							{s.planControl === "restart_needed" && <p className="hub-warn">{RESTART_FOR_PLAN}</p>}
							{down && (
								<p className="hub-warn">{machineName} is unreachable; answer the plan once it is back.</p>
							)}
							{s.planControl === "supported" && s.sessionId && !down && (
								<PlanReviewPanel session={s} onChanged={onChanged} notes={notes} />
							)}
						</>
					)}
					{shown === "terminal" && terminalOn && !down && (
						<TerminalPanel session={s} active={active} onSent={() => setSent(n => n + 1)} />
					)}
					{shown === "terminal" && down && <p className="hub-warn">{machineName} is unreachable.</p>}
					{shown === "terminal" && !down && !terminal.on && (
						<p className="hub-warn" role="status">
							{terminal.reason}
						</p>
					)}
					{shown === "instructions" &&
						(s.sessionId ? (
							<SessionInstructionsPanel
								session={s}
								machineName={machineName}
								capability={capability("sessionInstructions")}
								active={active && !down}
							/>
						) : (
							<p className="sd-hint">omp did not report this session's id.</p>
						))}
				</div>
				<Modal
					open={ctl.killing}
					title="Kill session"
					onClose={ctl.closeKill}
					primaryAction={{
						label: ctl.pending === "Kill" ? "Ending…" : "Kill session",
						onClick: () => void ctl.kill(),
						disabled: !killConfirmMatches(s, ctl.typed) || ctl.pending !== null,
					}}
				>
					<p>
						End this session's omp process on {machineName}; any subagents it runs stop with it. Its transcript
						stays on the machine, and Old sessions can resume it.
					</p>
					<label className="sd-field">
						<span>
							Type the session name or its folder name (<span className="mono">{projectFolder(s)}</span>) to
							confirm
						</span>
						<input
							type="text"
							className="input"
							aria-label="Confirm by typing the name"
							autoComplete="off"
							value={ctl.typed}
							onChange={event => ctl.setTyped(event.target.value)}
						/>
					</label>
					{ctl.forceOffered && (
						<div className="sd-stack">
							<p className="hub-warn">
								It is still running 10 seconds after being asked to end. Force kill stops it at once, without
								letting it finish writing or close its subagents cleanly.
							</p>
							<button
								type="button"
								className="btn"
								data-variant="danger"
								disabled={!killConfirmMatches(s, ctl.typed) || ctl.pending !== null}
								onClick={() => void ctl.forceKill()}
							>
								{ctl.pending === "Force kill" ? "Force killing…" : "Force kill"}
							</button>
						</div>
					)}
					<NoticeLine notice={ctl.killNotice} />
				</Modal>
			</Drawer>
		</CapabilityCheckContext.Provider>
	);
}

/** Stop, Rename and Kill (with Force kill only after a Kill that did not end it), all on the row's machine. */
function useManage(s: HubSession, onChanged: () => void, onEnded: (notice: Notice) => void) {
	const name = sessionDisplayName(s);
	const sessionId = s.sessionId ?? "";
	const machine = s.machine;
	const [pending, setPending] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [killNotice, setKillNotice] = useState<Notice | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [killing, setKilling] = useState(false);
	const [newName, setNewName] = useState("");
	const [typed, setTyped] = useState("");
	const [forceOffered, setForceOffered] = useState(false);

	const run = async (label: string, action: () => Promise<void>, inKill = false) => {
		setPending(label);
		(inKill ? setKillNotice : setNotice)(null);
		try {
			await action();
		} catch (error) {
			(inKill ? setKillNotice : setNotice)({
				tone: "bad",
				text: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			setPending(null);
			onChanged();
		}
	};

	return {
		pending,
		notice,
		killNotice,
		renaming,
		killing,
		newName,
		setNewName,
		typed,
		setTyped,
		forceOffered,
		openRename: () => {
			setNotice(null);
			setNewName(s.sessionName ?? "");
			setRenaming(r => !r);
		},
		closeRename: () => setRenaming(false),
		openKill: () => {
			setTyped("");
			setKillNotice(null);
			setForceOffered(false);
			setKilling(true);
		},
		closeKill: () => setKilling(false),
		stop: () =>
			run("Stop", async () => {
				const r = await stopHubSession(sessionId, machine);
				setNotice({
					tone: "ok",
					text:
						r.outcome === "stopped"
							? "Stopped the running turn. The session is still open."
							: "Nothing was running.",
				});
			}),
		rename: (event: FormEvent) => {
			event.preventDefault();
			void run("Rename", async () => {
				const r = await renameHubSession(sessionId, newName, machine);
				setRenaming(false);
				setNotice({ tone: "ok", text: `Renamed to “${r.name ?? newName.trim()}”.` });
			});
		},
		kill: () =>
			run(
				"Kill",
				async () => {
					const r = await killHubSession(sessionId, typed, machine);
					if (r.outcome === "exited") {
						setKilling(false);
						onEnded({
							tone: "ok",
							text: `“${name}” has ended. Its transcript is kept: resume it with omp --resume or from Old sessions.`,
						});
						return;
					}
					setForceOffered(true);
				},
				true,
			),
		forceKill: () =>
			run(
				"Force kill",
				async () => {
					const r = await forceKillHubSession(sessionId, typed, machine);
					if (r.outcome === "force_exited") {
						setKilling(false);
						onEnded({
							tone: "ok",
							text: `“${name}” was force-killed. Its transcript up to that moment is kept: resume it with omp --resume.`,
						});
					} else
						setKillNotice({
							tone: "bad",
							text: "It is still running even after Force kill; check it at the machine.",
						});
				},
				true,
			),
	};
}
