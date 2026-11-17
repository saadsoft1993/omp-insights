import { useCallback, useEffect, useRef, useState } from "react";
import { answerPlanReview, getPlanReview, type HubPlanReview, type HubSession, type PlanChoice } from "../data/hub";
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
import { Card, Modal } from "../ui";
import { type Notice, NoticeLine } from "./hub-common";

const MAX_AUTO_RETRIES = 5;
const CLOSED_TEXT = "This plan review is closed or was replaced, so the controls are off.";

/**
 * The plan review a session is waiting on: the plan as proposed, and the terminal's own choices.
 * Answers go through the hub, which asks the session's terminal to take them like a local pick.
 */
export function PlanReviewPanel({ session, onChanged }: { session: HubSession; onChanged: () => void }) {
	const sessionId = session.sessionId ?? "";
	const listed = session.planReview ?? null;
	const listedId = listed?.reviewId ?? null;
	const [review, setReview] = useState<HubPlanReview | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [feedback, setFeedback] = useState("");
	const [role, setRole] = useState("");
	/** The choice being confirmed, bound to the session and review it was opened for. */
	const [confirming, setConfirming] = useState<{ choice: PlanChoice; sessionId: string; reviewId: string } | null>(
		null,
	);
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
			const next = await getPlanReview(sessionId);
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
	}, [sessionId]);

	useEffect(() => {
		retries.current = 0;
		// A dialog opened for another review or session must not outlive it.
		setConfirming(null);
		if (listedId) void load();
		return () => {
			seq.current++;
		};
	}, [listedId, sessionId, load]);

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
			await answerPlanReview(sessionId, {
				reviewId: open.reviewId,
				choice,
				...(choice === "refine" ? { feedback } : {}),
				...(isApproval(choice) && activeRole ? { role: activeRole } : {}),
			});
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
	const closed = stale || review?.open === false;

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
					<pre className="plan-text" tabIndex={0} aria-label="Plan">
						{open.planContent}
					</pre>
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
					<div className="plan-field">
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
					</div>
					<div className="hub-actions plan-actions">
						{open.options.map(option => {
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
						})}
					</div>
				</>
			)}
			<NoticeLine notice={notice} />
			<Modal
				open={confirmingOption !== undefined}
				title={confirmingOption?.label ?? "Confirm"}
				onClose={() => setConfirming(null)}
				primaryAction={{
					label: confirmingOption?.label ?? "Confirm",
					onClick: () => confirming && void submit(confirming.choice),
					disabled: busy,
				}}
			>
				<p>{confirmingOption && open && confirming ? confirmText(confirming.choice, open.title) : null}</p>
			</Modal>
		</Card>
	);
}
