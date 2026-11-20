import { ApiError } from "../api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	getSessionInfo,
	type HubSession,
	type HubSessionInfo,
	type ModeStatus,
	sendSessionCommand,
	stopHubSession,
	type SessionCommand,
} from "../data/hub";
import {
	COMPACT_MAX_POLLS,
	INFO_REFRESH_MS,
	COMPACT_TIMEOUT_TEXT,
	COMPACT_POLL_MS,
	COMPACTING_TEXT,
	advisorSummary,
	commandConfirm,
	commandDone,
	commandErrorMessage,
	compactCommand,
	currentModelKey,
	instructionsProblem,
	isRestartNeeded,
	MAX_INSTRUCTIONS_CHARS,
	MAX_OBJECTIVE_CHARS,
	modeCommand,
	modelKey,
	modelLabel,
	NO_THINKING_LEVELS,
	objectiveProblem,
	parseSessionInfo,
	RESTART_FOR_COMMANDS,
} from "../data/session-commands";
import { Card, Modal, StatusCell } from "../ui";
import { type Notice, NoticeLine } from "./hub-common";

/** A model or thinking select has focus: the user may be choosing, so a background read must not move it. */
function editingSelect(): boolean {
	const active = typeof document === "undefined" ? null : (document.activeElement as Element | null);
	const id = active?.id ?? "";
	return active?.tagName === "SELECT" && id.startsWith("cmd-");
}

/**
 * Sessions whose compaction outlasted the poll budget while the server still reported it. Kept outside the component
 * so closing and reopening the card does not start polling again by itself: only "Check again" does.
 */
const timedOut = new Set<string>();

/**
 * Model, thinking level, mode and Compact for one session, through the omp-session-control plugin. Every change
 * asks first, runs alone, says what happened by error code, then reloads what the session reports.
 */
export function SessionCommandsPanel({
	session,
	onChanged,
	compactPollMs = COMPACT_POLL_MS,
	maxPolls = COMPACT_MAX_POLLS,
	refreshMs = INFO_REFRESH_MS,
	refreshToken = 0,
	active = true,
	onInfo,
	goalHint = null,
	lockedReason = null,
}: {
	session: HubSession;
	onChanged: () => void;
	/** How often the card checks a running compaction (tests shorten it). */
	compactPollMs?: number;
	/** How many checks one wait may make before it gives up (tests shorten it). */
	maxPolls?: number;
	/** How often the card re-reads the session's settings while visible (changes made in the terminal show up). */
	refreshMs?: number;
	/** Changes when something outside the card may have changed the session (a terminal send): re-read once. */
	refreshToken?: number;
	/** False while the Sessions page is not the one on show (routes stay mounted): no background reads. */
	active?: boolean;
	/** Hears every settings read (null: none yet, or the session's plugin can't report them). */
	onInfo?: (info: HubSessionInfo | null) => void;
	/** Shown when a goal runs but its objective isn't reported (an older hub or plugin). */
	goalHint?: string | null;
	/** Why every control is off (the machine is unreachable), or null. */
	lockedReason?: string | null;
}) {
	const sessionId = session.sessionId ?? "";
	const machine = session.machine;
	// The settings are bound to the session they were read for, so another session never shows them.
	const [infoState, setInfoState] = useState<{ id: string; info: HubSessionInfo } | null>(null);
	const info = infoState?.id === sessionId ? infoState.info : null;
	const [loadError, setLoadError] = useState<string | null>(null);
	const [restart, setRestart] = useState(false);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [instructions, setInstructions] = useState("");
	const [objective, setObjective] = useState("");
	/** The command being confirmed, bound to the session it was opened for. */
	const [confirming, setConfirming] = useState<{ command: SessionCommand; sessionId: string; resume: boolean } | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	/**
	 * Compaction lifecycle: `submitting` while the request is out (no polling: the server may not have started yet),
	 * `pending` once the hub said it is still running or session-info reports it (only polling ends this one).
	 */
	const [phase, setPhaseState] = useState<"idle" | "submitting" | "pending" | "timed-out">("idle");
	const phaseRef = useRef<"idle" | "submitting" | "pending" | "timed-out">("idle");
	const setPhase = useCallback((next: "idle" | "submitting" | "pending" | "timed-out") => {
		phaseRef.current = next;
		setPhaseState(next);
	}, []);
	/** The last compact failed because the agent is busy: offer Stop. */
	const [offerStop, setOfferStop] = useState(false);
	const [stopping, setStopping] = useState(false);
	/** Counts every info fetch; a response that is not the latest one is ignored. */
	const seq = useRef(0);
	/** Set synchronously on confirm, so a second click in the same tick can't send twice. */
	const busyRef = useRef(false);
	/** Bumped when the session changes: a command that finishes after that must not touch the new session's state. */
	const epoch = useRef(0);

	/**
	 * Every `session-info` read goes through here, one at a time. `barrier` counts moments after which an older
	 * read is not good enough (a command was acknowledged): `fresh` callers never join a read that started before
	 * the latest barrier; they queue one new read that starts once the old one has drained.
	 */
	const barrier = useRef(0);
	const inflight = useRef<{ id: string; promise: Promise<unknown>; barrier: number } | null>(null);
	const queued = useRef<{ id: string; promise: Promise<unknown>; barrier: number } | null>(null);
	const readInfo = useCallback(
		(fresh = false): Promise<unknown> => {
			const current = inflight.current;
			if (!current || current.id !== sessionId) {
				const startedAt = barrier.current;
				const promise: Promise<unknown> = getSessionInfo(sessionId, undefined, machine).finally(() => {
					if (inflight.current?.promise === promise) inflight.current = null;
				});
				inflight.current = { id: sessionId, promise, barrier: startedAt };
				return promise;
			}
			if (!fresh || current.barrier >= barrier.current) return current.promise;
			const waiting = queued.current;
			if (waiting && waiting.id === sessionId && waiting.barrier >= barrier.current) return waiting.promise;
			const entry = {
				id: sessionId,
				barrier: barrier.current,
				promise: current.promise
					.catch(() => undefined)
					.then(() => {
						if (queued.current === entry) queued.current = null;
						return readInfo(true);
					}),
			};
			queued.current = entry;
			return entry.promise;
		},
		[sessionId, machine],
	);

	/** The confirmation open now, mirrored for background reads. */
	const confirmingRef = useRef<unknown>(null);

	/** `quiet`: a background refresh. It never overwrites a select being edited or a confirmation being answered. */
	const load = useCallback(
		async (quiet = false, fresh = false) => {
			// A background refresh waits its turn: never during a compaction, never alongside another read.
			if (quiet && (inflight.current?.id === sessionId || phaseRef.current !== "idle" || document.hidden === true))
				return;
			const mine = ++seq.current;
			const asked = barrier.current;
			try {
				const next = parseSessionInfo(await readInfo(fresh));
				if (mine !== seq.current) return;
				// A command was acknowledged while this read was out: it may show the state from before it.
				if (asked !== barrier.current) return;
				if (quiet && (confirmingRef.current !== null || editingSelect())) return;
				if (!next) throw new Error("The hub sent settings this page doesn't understand.");
				setInfoState({ id: sessionId, info: next });
				// Opened (or reloaded) during a compaction: wait for it, never start another.
				if (next.compacting === true && phaseRef.current === "idle")
					setPhase(timedOut.has(sessionId) ? "timed-out" : "pending");
				// The server says it is over (or never started): forget a timeout and release a card that was waiting.
				if (next.compacting !== true) {
					timedOut.delete(sessionId);
					if (phaseRef.current === "timed-out") setPhase("idle");
				}
				setLoadError(null);
				setRestart(false);
			} catch (error) {
				if (mine !== seq.current || quiet) return;
				if (isRestartNeeded(error)) {
					setRestart(true);
					setInfoState(null);
					setLoadError(null);
				} else {
					setLoadError(commandErrorMessage(error));
				}
			}
		},
		[sessionId, machine, setPhase, readInfo],
	);

	useEffect(() => {
		epoch.current++;
		busyRef.current = false;
		setBusy(false);
		setPhase("idle");
		setOfferStop(false);
		setStopping(false);
		setInfoState(null);
		setLoadError(null);
		setRestart(false);
		setNotice(null);
		setConfirming(null);
		inflight.current = null;
		queued.current = null;
		void load();
		return () => {
			seq.current++;
		};
	}, [sessionId, machine, load]);

	confirmingRef.current = confirming;

	const onInfoRef = useRef(onInfo);
	onInfoRef.current = onInfo;
	useEffect(() => {
		onInfoRef.current?.(info);
	}, [info]);
	const ask = (command: SessionCommand, resume = false) => setConfirming({ command, sessionId, resume });

	// While the card is on screen (page shown, tab visible), re-read what the session reports: it can change from
	// the terminal. Routes stay mounted when you leave Sessions, so `active` gates this, not just tab visibility.
	useEffect(() => {
		if (!active) return;
		void load(true);
		const timer = setInterval(() => void load(true), refreshMs);
		const onVisible = () => {
			if (document.hidden !== true) void load(true);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [load, refreshMs, active]);

	// Something outside the card (a terminal send) may have changed the session.
	const firstToken = useRef(refreshToken);
	useEffect(() => {
		if (refreshToken === firstToken.current) return;
		firstToken.current = refreshToken;
		if (active) void load(true);
	}, [refreshToken, load, active]);

	const run = async () => {
		if (busyRef.current || phaseRef.current !== "idle" || !confirming || confirming.sessionId !== sessionId) {
			if (!busyRef.current) setConfirming(null);
			return;
		}
		const { command } = confirming;
		const mine = epoch.current;
		busyRef.current = true;
		setBusy(true);
		setConfirming(null);
		setNotice(null);
		setOfferStop(false);
		if (command.op === "compact") setPhase("submitting");
		try {
			const done = await sendSessionCommand(sessionId, command, machine);
			if (mine !== epoch.current) return;
			// From here on only a read that starts after this point can say what the command did.
			barrier.current++;
			if (done.outcome === "pending") {
				// Acknowledged and still running: from here only the poll below ends it.
				if (command.op === "compact") {
					setInstructions("");
					setPhase("pending");
				}
				return;
			}
			if (command.op === "compact") setInstructions("");
			if (command.op === "set-mode" && command.args.action === "enter") setObjective("");
			setNotice({ tone: "ok", text: commandDone(command) });
		} catch (error) {
			if (mine !== epoch.current) return;
			if (isRestartNeeded(error)) setRestart(true);
			if (command.op === "compact" && error instanceof ApiError && error.code === "failed") setOfferStop(true);
			setNotice({ tone: "bad", text: commandErrorMessage(error) });
		} finally {
			// A completion from another session leaves this session's state alone.
			onChanged();
			if (mine === epoch.current) {
				busyRef.current = false;
				setBusy(false);
				// (the check re-reads the ref: the request may have moved the phase on to pending)
				if ((phaseRef.current as string) === "submitting") setPhase("idle");
				void load(false, true);
			}
		}
	};

	// While the hub says a compaction is pending, ask the session every few seconds whether it has finished.
	useEffect(() => {
		if (phase !== "pending") return;
		const mine = epoch.current;
		let polls = 0;
		let stopped = false;
		const timeOut = () => {
			if (stopped || mine !== epoch.current) return;
			stopped = true;
			timedOut.add(sessionId);
			setPhase("timed-out");
			onChanged();
			// A reconciliation read may release it; it can never start polling again.
			void load();
		};
		const finish = (n: Notice) => {
			if (stopped || mine !== epoch.current) return;
			stopped = true;
			timedOut.delete(sessionId);
			setPhase("idle");
			setNotice(n);
			onChanged();
			void load();
		};
		const timer = setInterval(() => {
			if (stopped) return;
			if (++polls > maxPolls) {
				timeOut();
				return;
			}
			readInfo(true).then(
				raw => {
					if (stopped || mine !== epoch.current) return;
					const next = parseSessionInfo(raw);
					if (next && next.compacting !== true) finish({ tone: "ok", text: "Compacted." });
				},
				error => finish({ tone: "bad", text: commandErrorMessage(error) }),
			);
		}, compactPollMs);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [phase, sessionId, machine, compactPollMs, maxPolls, load, onChanged, setPhase, readInfo]);

	const stopTurn = async () => {
		if (stopping) return;
		const mine = epoch.current;
		setStopping(true);
		try {
			await stopHubSession(sessionId, machine);
			if (mine !== epoch.current) return;
			setOfferStop(false);
			setNotice({ tone: "ok", text: "Stop signal sent. Compact again once the turn has ended." });
		} catch (error) {
			if (mine === epoch.current) setNotice({ tone: "bad", text: commandErrorMessage(error) });
		} finally {
			if (mine === epoch.current) setStopping(false);
			onChanged();
		}
	};

	const locked = busy || phase !== "idle" || lockedReason !== null;
	const modeStatus = info?.modeStatus ?? { plan: "inactive", vibe: "inactive", goal: "inactive", loop: "inactive" };
	const confirmText = confirming ? commandConfirm(confirming.command, { resume: confirming.resume }) : null;
	const id = session.instanceId;
	const instructionsError = instructionsProblem(instructions);
	const objectiveError = objectiveProblem(objective);

	return (
		<Card
			title="Session controls"
			description="Goal, loop and plan mode, model, thinking level and compaction"
			className="session-detail-panel"
		>
			{restart && <p className="hub-warn">{RESTART_FOR_COMMANDS}</p>}
			{loadError && (
				<div className="plan-load-error">
					<p className="hub-notice" data-tone="bad" role="alert">
						{loadError}
					</p>
					<button type="button" className="btn" onClick={() => void load()}>
						Retry
					</button>
				</div>
			)}
			{!info && !restart && !loadError && <p className="micro">Loading the session's settings…</p>}
			{info && (
				<>
					<div className="plan-field">
						<label className="micro" htmlFor={`cmd-model-${id}`}>
							Model
						</label>
						<select
							id={`cmd-model-${id}`}
							className="input"
							value={currentModelKey(info)}
							disabled={locked || info.models.length === 0}
							onChange={event => {
								const picked = info.models.find(m => modelKey(m) === event.target.value);
								if (picked) ask({ op: "set-model", args: { provider: picked.provider, id: picked.id } });
							}}
						>
							{currentModelKey(info) === "" && (
								<option value="">{info.model ? modelKey(info.model) : "Unknown"}</option>
							)}
							{info.models.map(m => (
								<option key={modelKey(m)} value={modelKey(m)}>
									{modelLabel(m)}
								</option>
							))}
						</select>
					</div>
					<div className="plan-field">
						<label className="micro" htmlFor={`cmd-thinking-${id}`}>
							Thinking level
						</label>
						{info.thinkingLevels.length === 0 ? (
							<p className="micro">{NO_THINKING_LEVELS}</p>
						) : (
							<select
								id={`cmd-thinking-${id}`}
								className="input"
								value={
									info.thinkingLevel && info.thinkingLevels.includes(info.thinkingLevel)
										? info.thinkingLevel
										: ""
								}
								disabled={locked || info.thinkingLevels.length === 0}
								onChange={event => {
									if (info.thinkingLevels.includes(event.target.value))
										ask({ op: "set-thinking", args: { level: event.target.value } });
								}}
							>
								{!(info.thinkingLevel && info.thinkingLevels.includes(info.thinkingLevel)) && (
									<option value="">{info.thinkingLevel ?? "Unknown"}</option>
								)}
								{info.thinkingLevels.map(level => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						)}
					</div>
					<div className="plan-field">
						<label className="micro" htmlFor={`cmd-advisor-model-${id}`}>
							Advisor
						</label>
						{!info.advisor ? (
							<p className="micro">
								Advisor control needs the updated omp, session plugin and hub; restart this session after
								updating.
							</p>
						) : (
							<>
								<p className="micro">{advisorSummary(info.advisor)}</p>
								<button
									type="button"
									className="btn"
									disabled={locked}
									onClick={() => ask({ op: "set-advisor", args: { enabled: !info.advisor!.enabled } })}
								>
									{info.advisor.enabled ? "Turn advisor off" : "Turn advisor on"}
								</button>
								<select
									id={`cmd-advisor-model-${id}`}
									className="input"
									value={
										info.advisor.model &&
										info.models.some(m => modelKey(m) === modelKey(info.advisor!.model!))
											? modelKey(info.advisor.model)
											: ""
									}
									disabled={locked || !info.advisor.enabled}
									onChange={event => {
										const picked = info.models.find(m => modelKey(m) === event.target.value);
										if (picked)
											ask({ op: "set-advisor", args: { provider: picked.provider, id: picked.id } });
									}}
								>
									{(!info.advisor.model ||
										!info.models.some(m => modelKey(m) === modelKey(info.advisor!.model!))) && (
										<option value="">{info.advisor.model ? modelKey(info.advisor.model) : "Unknown"}</option>
									)}
									{info.models.map(m => (
										<option key={modelKey(m)} value={modelKey(m)}>
											{modelLabel(m)}
										</option>
									))}
								</select>
								<p className="micro">Not saved to config; resets when omp restarts.</p>
							</>
						)}
					</div>
					<div className="sd-modes" role="group" aria-label="Goal, loop and plan mode">
						<div className="sd-mode">
							<b>
								Goal <ModePill status={modeStatus.goal} />
							</b>
							{modeStatus.goal === "inactive" ? (
								<>
									<label className="micro" htmlFor={`cmd-goal-${id}`}>
										Goal objective (up to {MAX_OBJECTIVE_CHARS} characters)
									</label>
									<textarea
										id={`cmd-goal-${id}`}
										className="input"
										rows={2}
										placeholder="What should the session keep working towards?"
										value={objective}
										disabled={locked}
										onChange={event => setObjective(event.target.value)}
									/>
									{objective !== "" && objectiveError && <p className="micro hub-reason">{objectiveError}</p>}
									<div className="hub-actions">
										<button
											type="button"
											className="btn"
											data-size="sm"
											disabled={locked || objectiveError !== null}
											title={lockedReason ?? objectiveError ?? undefined}
											onClick={() => ask(modeCommand("goal", "enter", objective))}
										>
											Enter goal
										</button>
									</div>
								</>
							) : (
								<>
									{info.goal ? (
										<p className="sd-goal">{info.goal.objective}</p>
									) : (
										<p className="sd-hint">{goalHint ?? "The session did not report the objective."}</p>
									)}
									{info.goal?.tokenBudget !== undefined && (
										<p className="sd-hint">Token budget {info.goal.tokenBudget.toLocaleString("en-US")}</p>
									)}
									<div className="hub-actions">
										{modeStatus.goal === "active" ? (
											<button
												type="button"
												className="btn"
												data-size="sm"
												disabled={locked}
												title={lockedReason ?? undefined}
												onClick={() => ask(modeCommand("goal", "pause"))}
											>
												Pause goal
											</button>
										) : (
											<button
												type="button"
												className="btn"
												data-size="sm"
												disabled={locked}
												title={lockedReason ?? undefined}
												onClick={() => ask(modeCommand("goal", "resume"))}
											>
												Resume goal
											</button>
										)}
										<button
											type="button"
											className="btn"
											data-size="sm"
											data-variant="danger"
											disabled={locked}
											title={lockedReason ?? undefined}
											onClick={() => ask(modeCommand("goal", "drop"))}
										>
											Drop goal
										</button>
									</div>
								</>
							)}
						</div>
						<div className="sd-mode">
							<b>
								Loop <ModePill status={modeStatus.loop} />
							</b>
							{modeStatus.loop === "active" ? (
								<>
									<p>Repeats the last prompt after each turn until you end it.</p>
									<div className="hub-actions">
										<button
											type="button"
											className="btn"
											data-size="sm"
											disabled={locked}
											title={lockedReason ?? undefined}
											onClick={() => ask(modeCommand("loop", "exit"))}
										>
											Exit loop
										</button>
									</div>
								</>
							) : (
								<p>
									{modeStatus.loop === "paused" ? "Paused." : "Off."} A loop starts inside the session (
									<span className="mono">/loop</span>); from here you can end one.
								</p>
							)}
						</div>
						<div className="sd-mode">
							<b>
								Plan mode <ModePill status={modeStatus.plan} />
							</b>
							<p>
								{modeStatus.plan === "active"
									? "The session plans before it changes anything."
									: "The session works directly."}
							</p>
							<div className="hub-actions">
								<button
									type="button"
									className="btn"
									data-size="sm"
									disabled={locked}
									title={lockedReason ?? undefined}
									onClick={() =>
										ask(
											modeCommand("plan", modeStatus.plan === "active" ? "exit" : "enter"),
											modeStatus.plan === "paused",
										)
									}
								>
									{modeStatus.plan === "active"
										? "Exit plan mode"
										: modeStatus.plan === "paused"
											? "Resume plan mode"
											: "Enter plan mode"}
								</button>
								{modeStatus.plan === "paused" && (
									<button
										type="button"
										className="btn"
										data-size="sm"
										disabled={locked}
										title={lockedReason ?? undefined}
										onClick={() => ask(modeCommand("plan", "exit"))}
									>
										Exit plan mode
									</button>
								)}
							</div>
						</div>
					</div>
					<div className="plan-field">
						<label className="micro" htmlFor={`cmd-compact-${id}`}>
							Compact instructions (optional, up to {MAX_INSTRUCTIONS_CHARS} characters)
						</label>
						<textarea
							id={`cmd-compact-${id}`}
							className="input"
							rows={2}
							value={instructions}
							disabled={locked}
							onChange={event => setInstructions(event.target.value)}
						/>
						{instructionsError && <p className="micro hub-reason">{instructionsError}</p>}
						<div className="hub-actions">
							<button
								type="button"
								className="btn"
								disabled={locked || instructionsError !== null}
								title={instructionsError ?? undefined}
								onClick={() => ask(compactCommand(instructions))}
							>
								Compact
							</button>
						</div>
					</div>
				</>
			)}
			{(phase === "submitting" || phase === "pending") && (
				<p className="micro" role="status">
					{COMPACTING_TEXT}
				</p>
			)}
			{phase === "timed-out" && (
				<div className="hub-actions">
					<p className="hub-warn" role="status">
						{COMPACT_TIMEOUT_TEXT}
					</p>
					<button type="button" className="btn" onClick={() => setPhase("pending")}>
						Check again
					</button>
				</div>
			)}
			<NoticeLine notice={notice} />
			{offerStop && (
				<div className="hub-actions">
					<button type="button" className="btn" disabled={stopping} onClick={() => void stopTurn()}>
						{stopping ? "Stopping…" : "Stop the turn"}
					</button>
				</div>
			)}
			<Modal
				open={confirmText !== null && confirming?.sessionId === sessionId}
				title={confirmText?.title ?? "Confirm"}
				onClose={() => setConfirming(null)}
				primaryAction={{ label: confirmText?.label ?? "Confirm", onClick: () => void run(), disabled: busy }}
			>
				<p>{confirmText?.question}</p>
			</Modal>
		</Card>
	);
}

function ModePill({ status }: { status: ModeStatus }) {
	return status === "active" ? (
		<StatusCell tone="ok" live>
			On
		</StatusCell>
	) : status === "paused" ? (
		<StatusCell tone="warn">Paused</StatusCell>
	) : (
		<StatusCell>Off</StatusCell>
	);
}
