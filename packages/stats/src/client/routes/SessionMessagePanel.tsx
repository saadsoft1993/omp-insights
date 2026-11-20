import { useEffect, useRef, useState } from "react";
import type { HubSession } from "../data/hub";
import {
	deliver,
	getMessageStatus,
	deliveryText,
	followDelivery,
	MAX_MESSAGE_CHARS,
	messageFailure,
	messageProblem,
	newMessageId,
	sendSessionMessage,
} from "../data/session-ask";
import { type CapabilityState, isPluginTooOld, updateHubHint, updatePluginHint } from "../data/session-capabilities";
import { CapabilityChecking } from "./CapabilityChecking";

/** The last send whose delivery the hub did not confirm: only its status is read again, it is never resent. */
interface Uncertain {
	messageId: string;
}

/**
 * A message typed here goes to the session as if typed at the Mac. Each press gets a fresh id; the hub's reply
 * confirms admission, not a finished turn. A send the hub could not confirm is never repeated by itself: "Send it
 * again" reuses the same id, so the session ignores it if the first one arrived.
 */
export function SessionMessagePanel({
	session,
	machineName,
	capability,
	interruptMode,
	locked,
}: {
	session: HubSession;
	machineName: string;
	capability: CapabilityState;
	interruptMode: "immediate" | "wait" | null | undefined;
	locked: string | null;
}) {
	const sessionId = session.sessionId ?? "";
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
	const [uncertain, setUncertain] = useState<Uncertain | null>(null);
	const [pluginOld, setPluginOld] = useState(false);
	const busyRef = useRef(false);

	useEffect(() => {
		setText("");
		setResult(null);
		setUncertain(null);
		setPluginOld(false);
	}, [sessionId]);

	const send = async (body: { text: string; messageId: string }) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setResult(null);
		try {
			setResult({ tone: "warn", text: "Sending…" });
			const delivered = await deliver(
				() => sendSessionMessage(sessionId, body, session.machine),
				() => getMessageStatus(sessionId, body.messageId, session.machine),
			);
			if (delivered.state === "unconfirmed") setUncertain({ messageId: body.messageId });
			else setUncertain(null);
			if (delivered.state !== "failed") setText(current => (current === body.text ? "" : current));
			setResult({
				tone: delivered.state === "delivered" ? "ok" : delivered.state === "failed" ? "bad" : "warn",
				text: deliveryText(delivered, "message"),
			});
		} catch (error) {
			if (isPluginTooOld(error)) setPluginOld(true);
			const failure = messageFailure(error);
			if (failure.kind === "uncertain") setUncertain({ messageId: body.messageId });
			setResult({ tone: failure.kind === "uncertain" ? "warn" : "bad", text: failure.text });
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const problem = text === "" ? null : messageProblem(text);
	const working = session.busy === true;
	const modeLine =
		interruptMode === "immediate"
			? working
				? "The session is working: your message steers the running turn now."
				: "The session is idle: your message starts a new turn."
			: interruptMode === "wait"
				? working
					? "The session is working: your message waits until the running turn ends."
					: "The session is idle: your message starts a new turn."
				: interruptMode === null
					? "The session did not say how it takes messages during a turn; while it works, a message may wait for the turn to end."
					: null;

	/** Read the unconfirmed message's status again; nothing is sent. */
	const check = async (messageId: string) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setResult({ tone: "warn", text: "Checking…" });
		try {
			const delivered = await followDelivery(
				() => getMessageStatus(sessionId, messageId, session.machine),
				{},
				true,
			);
			if (delivered.state !== "unconfirmed") setUncertain(null);
			setResult({
				tone: delivered.state === "delivered" ? "ok" : delivered.state === "failed" ? "bad" : "warn",
				text: deliveryText(delivered, "message"),
			});
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	return (
		<section className="sd-sec" aria-label="Send a message">
			<h3>
				Send a message{" "}
				<span className="sd-hint">
					{text.length}/{MAX_MESSAGE_CHARS}
				</span>
			</h3>
			{capability === "off" ? (
				<p className="sd-hint">{updateHubHint(machineName, "sessionMessage")}</p>
			) : capability === "unknown" && !locked ? (
				<CapabilityChecking machineName={machineName} />
			) : pluginOld ? (
				<p className="sd-hint">{updatePluginHint(machineName, "send messages from here")}</p>
			) : (
				<form
					onSubmit={event => {
						event.preventDefault();
						if (!messageProblem(text) && !locked) void send({ text, messageId: newMessageId("msg") });
					}}
				>
					<textarea
						className="input"
						rows={3}
						aria-label="Message"
						placeholder="Type what you would type at the Mac"
						value={text}
						disabled={busy || locked !== null}
						aria-invalid={problem ? true : undefined}
						onChange={event => setText(event.target.value)}
					/>
					{problem && (
						<p className="sd-hint" data-tone="bad">
							{problem}
						</p>
					)}
					<div className="sd-row">
						<button
							type="submit"
							className="btn"
							data-size="sm"
							data-variant="primary"
							disabled={busy || locked !== null || messageProblem(text) !== null}
							title={locked ?? undefined}
						>
							{busy ? "Sending…" : "Send"}
						</button>
						<span className="sd-hint">{locked ?? modeLine}</span>
					</div>
				</form>
			)}
			{result && (
				<p className="sd-result" data-tone={result.tone} role={result.tone === "bad" ? "alert" : "status"}>
					{result.text}
				</p>
			)}
			{uncertain && (
				<div className="sd-row">
					<button
						type="button"
						className="btn"
						data-size="sm"
						disabled={busy}
						onClick={() => void check(uncertain.messageId)}
					>
						Check again
					</button>
					<span className="sd-hint">
						Look at the session (Open &amp; control) before sending anything again: a new message is sent as a new
						one.
					</span>
				</div>
			)}
		</section>
	);
}
