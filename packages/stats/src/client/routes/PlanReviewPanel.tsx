import { useCallback, useEffect, useRef, useState } from "react";
import {
	answerPlanReview,
	getPlanReview,
	type HubPlanReview,
	type HubSession,
	type PlanChoice,
	type PlanOption,
} from "../data/hub";
import {
	confirmText,
	feedbackProblem,
	isApproval,
	MAX_FEEDBACK_CHARS,
	optionProblem,
	PLAN_EDIT_NOTE,
	planErrorMessage,
	TERMINAL_SELECTION,
	TRUNCATED_NOTICE,
} from "../data/plan-review";
import { type CapabilityState, isPluginTooOld, updateHubHint } from "../data/session-capabilities";
import { CapabilityChecking } from "./CapabilityChecking";
import { MAX_NOTES_CHARS, NOTES_NEED_OMP, type NotesChoice, notesProblem } from "../data/session-plan-notes";
import { Card, Modal } from "../ui";
import { type Notice, NoticeLine } from "./hub-common";
import { PlanMarkdown } from "./PlanMarkdown";

const MAX_AUTO_RETRIES = 5;
const CLOSED_TEXT = "This plan review is closed or was replaced, so the controls are off.";

/**
 * The plan review a session is waiting on: the plan as proposed, and the terminal's own choices.
 * Answers go through the hub, which asks the session's terminal to take them like a local pick.
 */
/** Approve with notes: what the drawer lets the panel do (absent: the page offers no notes). */
export interface PlanNotesControl {
	capability: CapabilityState;
	machineName: string;
	/** A notes request of this session is still being followed. */
	pending: boolean;
	/** Approve and hand the notes over; rejects with the hub's error. */
	start: (request: { reviewId: string; choice: NotesChoice; notes: string; role?: string }) => Promise<void>;
}

const NOTES_CHOICES: NotesChoice[] = ["execute", "compact", "keep"];

export function PlanReviewPanel({
	session,
	onChanged,
	notes: notesControl,
}: {
	session: HubSession;
	onChanged: () => void;
	notes?: PlanNotesControl;
}) {
	const sessionId = session.sessionId ?? "";
	const machine = session.machine;
	const listed = session.planReview ?? null;
	const listedId = listed?.reviewId ?? null;
	const [review, setReview] = useState<HubPlanReview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [feedback, setFeedback] = useState("");
	const [notes, setNotes] = useState("");
	const [notesChoice, setNotesChoice] = useState<NotesChoice>("execute");
	/** The session's omp or plugin can't take notes (the hub said so): the field goes away. */
	const [notesUnsupported, setNotesUnsupported] = useState(false);
	const [role, setRole] = useState("");
	/** The choice being confirmed, bound to the session and review it was opened for. */
	const [confirming, setConfirming] = useState<{
		choice: PlanChoice;
		sessionId: string;
		reviewId: string;
		withNotes?: boolean;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	/** Counts every plan fetch; a response that is not the latest one is ignored (they can arrive out of order). */
	const seq = useRef(0);
	/** Set synchronously on submit, so a second click in the same tick can't send twice. */
	const busyRef = useRef(false);
	/** Automatic retries of a failed fetch since the last success or review change (bounded). */
	const retries = useRef(0);

	const load = useCallback(async () => {
		const mine = ++seq.current;
		setLoading(true);
		try {
			const next = await getPlanReview(sessionId, undefined, machine);
			if (mine !== seq.current) return;
			setReview(next);
			setLoadError(null);
			retries.current = 0;
		} catch (error) {
			if (mine !== seq.current) return;
			setLoadError(planErrorMessage(error));
		} finally {
			if (mine === seq.current) setLoading(false);
		}
	}, [sessionId, machine]);

	useEffect(() => {
		retries.current = 0;
		// A dialog opened for another review or session must not outlive it.
		setConfirming(null);
		if (listedId) void load();
		return () => {
			seq.current++;
		};
	}, [listedId, sessionId, machine, load]);

	// The session list polls every few seconds: a failed fetch is tried again on a poll while the review is still pending.
	useEffect(() => {
		if (!listedId || !loadError || loading || retries.current >= MAX_AUTO_RETRIES) return;
		retries.current++;
		void load();
	}, [session]); // eslint-disable-line react-hooks/exhaustive-deps

	const open = review?.open === true ? review : null;
	const stale = !listed || (open !== null && open.reviewId !== listedId);
	const tiers = open?.tiers ?? null;
	// A tier that is no longer in the review is not sent.
	const activeRole = tiers?.some(t => t.role === role) ? role : "";

	if (!listed && !notice) return null;

	const submitNotes = async () => {
		if (busyRef.current || !open || !notesControl || !confirming?.withNotes) return;
		const choice = notesChoice;
		const option = open.options.find(o => o.id === choice);
		if (
			!option ||
			confirming.sessionId !== sessionId ||
			confirming.reviewId !== open.reviewId ||
			notesProblem(notes) !== null ||
			optionProblem(option, { truncated: open.truncated, feedback, busy: false, stale }) !== null
		) {
			setConfirming(null);
			return;
		}
		busyRef.current = true;
		setBusy(true);
		setConfirming(null);
		setNotice(null);
		try {
			await notesControl.start({
				reviewId: open.reviewId,
				choice,
				notes,
				...(activeRole ? { role: activeRole } : {}),
			});
			setNotes("");
		} catch (error) {
			if (isPluginTooOld(error)) setNotesUnsupported(true);
			else setNotice({ tone: "bad", text: planErrorMessage(error) });
		} finally {
			busyRef.current = false;
			setBusy(false);
			onChanged();
			void load();
		}
	};

	const submit = async (choice: PlanChoice) => {
		if (busyRef.current || !open) return;
		// The answer goes to the review the user confirmed, and only while it is still the open, answerable one.
		const option = open.options.find(o => o.id === choice);
		if (
			!option ||
			confirming?.choice !== choice ||
			confirming.sessionId !== sessionId ||
			confirming.reviewId !== open.reviewId ||
			optionProblem(option, { truncated: open.truncated, feedback, busy: false, stale }) !== null
		) {
			setConfirming(null);
			return;
		}
		busyRef.current = true;
		setBusy(true);
		setConfirming(null);
		setNotice(null);
		try {
			await answerPlanReview(
				sessionId,
				{
					reviewId: open.reviewId,
					choice,
					...(choice === "refine" ? { feedback } : {}),
					...(isApproval(choice) && activeRole ? { role: activeRole } : {}),
				},
				machine,
			);
			if (choice === "refine") setFeedback("");
			setNotice({ tone: "ok", text: "Answer accepted by the session." });
		} catch (error) {
			setNotice({ tone: "bad", text: planErrorMessage(error) });
		} finally {
			busyRef.current = false;
			setBusy(false);
			onChanged();
			void load();
		}
	};

	const confirmingValid =
		confirming !== null &&
		open !== null &&
		!stale &&
		!loading &&
		confirming.sessionId === sessionId &&
		confirming.reviewId === open.reviewId;
	const confirmingOption = confirmingValid ? open?.options.find(o => o.id === confirming.choice) : undefined;
	const confirmingNotes = confirming?.withNotes === true;
	const closed = stale || review?.open === false;

	const optionButton = (option: PlanOption) => {
		if (!open) return null;
		const problem = closed
			? CLOSED_TEXT
			: optionProblem(option, { truncated: open.truncated, feedback, busy, stale });
		return (
			<button
				key={option.id}
				type="button"
				className="btn"
				data-variant={option.id === "execute" ? "primary" : undefined}
				disabled={problem !== null}
				title={problem ?? undefined}
				onClick={() => setConfirming({ choice: option.id, sessionId, reviewId: open.reviewId })}
			>
				{option.label}
			</button>
		);
	};
	const notesOption = open?.options.find(o => o.id === notesChoice);
	const notesButtonProblem = !open
		? CLOSED_TEXT
		: notesControl?.pending
			? "The notes of your last approval are still on their way."
			: closed
				? CLOSED_TEXT
				: !notesOption
					? "The terminal does not offer that approval."
					: (optionProblem(notesOption, { truncated: open.truncated, feedback, busy, stale }) ??
						notesProblem(notes));

	return (
		<Card
			title={open ? <span className="truncate">{open.title}</span> : "Plan review"}
			description={open?.planFilePath}
			className="plan-review"
		>
			{loadError && (
				<div className="plan-load-error">
					<p className="hub-notice" data-tone="bad" role="alert">
						{loadError}
					</p>
					<button type="button" className="btn" disabled={loading} onClick={() => void load()}>
						Retry
					</button>
				</div>
			)}
			{!open && !loadError && !closed && <p className="micro">Loading the plan…</p>}
			{closed && <p className="hub-warn">{CLOSED_TEXT}</p>}
			{open && (
				<>
					<p className="micro">{PLAN_EDIT_NOTE}</p>
					<PlanMarkdown content={open.planContent} />
					{open.truncated && <p className="hub-warn">{TRUNCATED_NOTICE}</p>}
					{tiers && tiers.length > 0 && (
						<div className="plan-field">
							<label className="micro" htmlFor={`plan-tier-${session.instanceId}`}>
								Continue with
							</label>
							<select
								id={`plan-tier-${session.instanceId}`}
								className="input"
								value={activeRole}
								disabled={busy || closed}
								onChange={event => setRole(event.target.value)}
							>
								<option value="">{TERMINAL_SELECTION}</option>
								{tiers.map(t => (
									<option key={t.role} value={t.role}>
										{t.provider}/{t.model}
									</option>
								))}
							</select>
						</div>
					)}
					<div className="plan-boxes">
						<div className="plan-box">
							<b>Approve</b>
							<span className="sd-hint">Starts work in this session.</span>
							<div className="hub-actions plan-actions">
								{open.options.filter(option => isApproval(option.id)).map(optionButton)}
							</div>
						</div>
						{notesControl && (
							<div className="plan-box" data-kind="notes">
								<b>Approve with changes</b>
								{notesControl.capability === "off" ? (
									<span className="sd-hint">{updateHubHint(notesControl.machineName, "planNotes")}</span>
								) : notesControl.capability === "unknown" ? (
									<CapabilityChecking machineName={notesControl.machineName} inline />
								) : notesUnsupported ? (
									<span className="sd-hint">
										Approve with changes {NOTES_NEED_OMP} and the newer session plugin on{" "}
										{notesControl.machineName}. Update them, then restart this session.
									</span>
								) : (
									<>
										<span className="sd-hint">
											Approves the plan, then sends your changes as the session's next message once the plan
											has started.
										</span>
										<label className="micro" htmlFor={`plan-notes-${session.instanceId}`}>
											Changes to make (up to {MAX_NOTES_CHARS} characters)
										</label>
										<textarea
											id={`plan-notes-${session.instanceId}`}
											className="input"
											rows={3}
											value={notes}
											disabled={busy || closed || notesControl.pending}
											onChange={event => setNotes(event.target.value)}
										/>
										{notes !== "" && notesProblem(notes) && (
											<p className="micro hub-reason">{notesProblem(notes)}</p>
										)}
										<div className="hub-actions">
											<select
												className="input"
												aria-label="Approve how"
												value={notesChoice}
												disabled={busy || closed || notesControl.pending}
												onChange={event => setNotesChoice(event.target.value as NotesChoice)}
											>
												{NOTES_CHOICES.map(choice => {
													const option = open.options.find(o => o.id === choice);
													return option ? (
														<option key={choice} value={choice} disabled={option.disabled}>
															{option.label}
														</option>
													) : null;
												})}
											</select>
											<button
												type="button"
												className="btn"
												disabled={notesButtonProblem !== null}
												title={notesButtonProblem ?? undefined}
												onClick={() =>
													setConfirming({
														choice: notesChoice,
														sessionId,
														reviewId: open.reviewId,
														withNotes: true,
													})
												}
											>
												Approve with changes
											</button>
										</div>
									</>
								)}
							</div>
						)}
						<div className="plan-box">
							<b>Reject with a reason</b>
							<span className="sd-hint">The session revises the plan using your reason.</span>
							<label className="micro" htmlFor={`plan-feedback-${session.instanceId}`}>
								Feedback (required for Refine plan, up to {MAX_FEEDBACK_CHARS} characters)
							</label>
							<textarea
								id={`plan-feedback-${session.instanceId}`}
								className="input"
								rows={3}
								value={feedback}
								disabled={busy || closed}
								onChange={event => setFeedback(event.target.value)}
							/>
							{feedback !== "" && feedbackProblem(feedback) && (
								<p className="micro hub-reason">{feedbackProblem(feedback)}</p>
							)}
							<div className="hub-actions plan-actions">
								{open.options.filter(option => option.id === "refine").map(optionButton)}
							</div>
						</div>
						<div className="plan-box">
							<b>Save for later</b>
							<span className="sd-hint">
								Saves the plan, leaves plan mode and starts a fresh session. The omp process keeps running.
							</span>
							<div className="hub-actions plan-actions">
								{open.options.filter(option => option.id === "save").map(optionButton)}
							</div>
						</div>
					</div>
				</>
			)}
			<NoticeLine notice={notice} />
			<Modal
				open={confirmingOption !== undefined}
				title={confirmingNotes ? "Approve with changes" : (confirmingOption?.label ?? "Confirm")}
				onClose={() => setConfirming(null)}
				primaryAction={{
					label: confirmingNotes ? "Approve with changes" : (confirmingOption?.label ?? "Confirm"),
					onClick: () => confirming && void (confirming.withNotes ? submitNotes() : submit(confirming.choice)),
					disabled: busy,
				}}
			>
				<p>
					{confirmingOption && open && confirming
						? confirmingNotes
							? `${confirmingOption.label} for '${open.title}', then send your changes as the session's next message once the plan has started?`
							: confirmText(confirming.choice, open.title)
						: null}
				</p>
			</Modal>
		</Card>
	);
}
