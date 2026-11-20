import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionScreen, type HubScreen, type HubSession, sendSessionKeys, type TerminalKey } from "../data/hub";
import {
	createScreenPoller,
	KEYS,
	MAX_TEXT_CHARS,
	newRequestId,
	SCREEN_POLL_MS,
	SCROLLED_WARNING,
	type ScreenPoller,
	TEXT_WARNING,
	terminalErrorMessage,
	textProblem,
} from "../data/terminal";
import { Card } from "../ui";
import { type Notice, NoticeLine } from "./hub-common";

/**
 * The session's terminal, for dialogs omp keeps there. Locked until "Control terminal" is on; it locks again when
 * the session changes, on any error, and when the page is left. Reading the screen and typing both need it on.
 */
export function TerminalPanel({
	session,
	active = true,
	pollMs = SCREEN_POLL_MS,
	staleMs = pollMs + 5000,
	onSent,
}: {
	session: HubSession;
	/** False while the Sessions page is not the one on show (routes stay mounted): the panel locks. */
	active?: boolean;
	pollMs?: number;
	/** A screen older than this no longer counts as seen: sending is off until a fresh one arrives. */
	staleMs?: number;
	/** Called after each send the hub accepted (the session may have changed). */
	onSent?: () => void;
}) {
	const sessionId = session.sessionId ?? "";
	const machine = session.machine;
	// Unlock, screen and "screen seen" are each bound to the session they were made for, so a panel that is
	// re-rendered for another session is locked at once, before any effect runs.
	const [unlockedFor, setUnlockedFor] = useState<string | null>(null);
	const [screenState, setScreenState] = useState<{ id: string; screen: HubScreen } | null>(null);
	const [readyFor, setReadyFor] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const unlocked = sessionId !== "" && unlockedFor === sessionId;
	const screen = screenState?.id === sessionId ? screenState.screen : null;
	const ready = unlocked && readyFor === sessionId;
	/** Set synchronously on send, so a second tap in the same tick can't send twice. */
	const sendingRef = useRef(false);
	const poller = useRef<ScreenPoller | null>(null);
	/** Bumped on every lock, so a send that finishes after a lock does not touch the new state. */
	const epoch = useRef(0);
	/** The session the panel is rendered for now, and which session is unlocked / has a fresh screen (synchronous mirrors). */
	const idRef = useRef(sessionId);
	idRef.current = sessionId;
	const unlockedRef = useRef<string | null>(null);
	const readyRef = useRef<string | null>(null);
	/** Counts sends; a screen only counts as seen when its read began after the latest one. */
	const sendGen = useRef(0);
	const readGen = useRef(0);
	/** Monotonic time (performance.now) the running read started, and when the permission it grants runs out. */
	const readStart = useRef(0);
	const expiresAt = useRef(0);
	const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const revoke = useCallback(() => {
		readyRef.current = null;
		if (staleTimer.current !== null) clearTimeout(staleTimer.current);
		staleTimer.current = null;
		setReadyFor(null);
	}, []);

	const lock = useCallback(
		(why: Notice | null) => {
			epoch.current++;
			poller.current?.stop();
			poller.current = null;
			unlockedRef.current = null;
			revoke();
			setUnlockedFor(null);
			setScreenState(null);
			if (why) setNotice(why);
		},
		[revoke],
	);

	// A different session, or leaving the page, locks the panel again.
	useEffect(() => {
		setNotice(null);
		setText("");
		return () => lock(null);
	}, [sessionId, machine, lock]);
	useEffect(() => {
		if (!active) lock(null);
	}, [active, lock]);

	useEffect(() => {
		if (!unlocked) return;
		const mine = epoch.current;
		const id = sessionId;
		const next = createScreenPoller({
			load: () => {
				readGen.current = sendGen.current;
				readStart.current = performance.now();
				return getSessionScreen(id, undefined, machine);
			},
			onScreen: shown => {
				if (mine !== epoch.current || unlockedRef.current !== id) return;
				setScreenState({ id, screen: shown });
				// Only a read that began after the last send says what the terminal shows now.
				if (readGen.current !== sendGen.current) return;
				// A screen counts for staleMs after its read began, not after it arrived: a late answer is already old.
				const left = readStart.current + staleMs - performance.now();
				if (left <= 0) return;
				expiresAt.current = readStart.current + staleMs;
				readyRef.current = id;
				setReadyFor(id);
				if (staleTimer.current !== null) clearTimeout(staleTimer.current);
				staleTimer.current = setTimeout(revoke, left);
			},
			onError: error => {
				if (mine === epoch.current) lock({ tone: "bad", text: terminalErrorMessage(error) });
			},
			delayMs: pollMs,
			isHidden: () => typeof document !== "undefined" && document.hidden === true,
		});
		poller.current = next;
		const onVisibility = () => {
			if (document.hidden === true) revoke();
			else next.resume();
		};
		document.addEventListener("visibilitychange", onVisibility);
		next.refresh();
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			next.stop();
			if (poller.current === next) poller.current = null;
		};
	}, [unlocked, sessionId, machine, pollMs, staleMs, lock, revoke]);

	const send = async (keys: TerminalKey[], line?: string) => {
		// Refused synchronously unless this very session is unlocked and its screen was seen since the last send.
		if (sendingRef.current || unlockedRef.current !== sessionId || idRef.current !== sessionId) return;
		if (readyRef.current !== sessionId) return;
		if (performance.now() >= expiresAt.current) {
			revoke();
			return;
		}
		sendingRef.current = true;
		sendGen.current++;
		revoke();
		setSending(true);
		setNotice(null);
		const mine = epoch.current;
		try {
			await sendSessionKeys(
				sessionId,
				{
					requestId: newRequestId(),
					keys,
					...(line !== undefined ? { text: line } : {}),
				},
				machine,
			);
			if (mine !== epoch.current) return;
			if (line !== undefined) setText("");
			onSent?.();
			// A read that began while the send was in flight can't show its effect: only a later one counts.
			sendGen.current++;
			revoke();
			poller.current?.refresh();
		} catch (error) {
			if (mine === epoch.current) lock({ tone: "bad", text: terminalErrorMessage(error) });
		} finally {
			sendingRef.current = false;
			setSending(false);
		}
	};

	const problem = textProblem(text);
	const id = session.instanceId;
	return (
		<Card
			title="Terminal"
			description="Answer dialogs that only exist in the session's terminal"
			className="session-detail-panel"
		>
			<button
				type="button"
				role="switch"
				aria-checked={unlocked}
				className="btn term-toggle"
				data-variant={unlocked ? "primary" : undefined}
				onClick={() => {
					if (unlocked) {
						lock(null);
					} else if (sessionId !== "") {
						setNotice(null);
						unlockedRef.current = sessionId;
						setUnlockedFor(sessionId);
					}
				}}
			>
				Control terminal: {unlocked ? "on" : "off"}
			</button>
			{!unlocked && <p className="micro">Locked. Turn it on to read the screen and type into the terminal.</p>}
			{unlocked && (
				<>
					<pre className="term-screen" tabIndex={0} aria-label="Terminal screen">
						{screen ? screen.rows.join("\n") : "Reading the screen…"}
					</pre>
					{!ready && !sending && <p className="micro">Waiting for a fresh screen before anything can be sent.</p>}
					{screen && <p className="micro">Screen read at {new Date(screen.capturedAt).toLocaleTimeString()}</p>}
					{screen?.scrolled && <p className="hub-warn">{SCROLLED_WARNING}</p>}
					<div className="term-keys" role="group" aria-label="Keys">
						{KEYS.map(k => (
							<button
								key={k.key}
								type="button"
								className="btn"
								aria-label={k.aria}
								disabled={sending || !ready}
								onClick={() => void send([k.key])}
							>
								{k.label}
							</button>
						))}
					</div>
					<div className="plan-field">
						<label className="micro" htmlFor={`term-text-${id}`}>
							Text (one line, up to {MAX_TEXT_CHARS} characters)
						</label>
						<input
							id={`term-text-${id}`}
							type="text"
							className="input"
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							value={text}
							disabled={sending}
							onChange={event => setText(event.target.value)}
						/>
						<p className="hub-warn">{TEXT_WARNING}</p>
						{text !== "" && problem && <p className="micro hub-reason">{problem}</p>}
						<div className="hub-actions">
							<button
								type="button"
								className="btn"
								disabled={sending || !ready || problem !== null}
								title={problem ?? undefined}
								onClick={() => void send([], text)}
							>
								Send text
							</button>
						</div>
					</div>
				</>
			)}
			<NoticeLine notice={notice} />
		</Card>
	);
}
