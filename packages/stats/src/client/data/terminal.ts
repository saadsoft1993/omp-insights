/** Rules and polling for the Sessions page's Terminal panel: pure or injectable, so they are tested without a DOM. */
import { ApiError } from "../api";
import type { HubScreen, TerminalKey } from "./hub";

export const SCREEN_POLL_MS = 1500;
export const MAX_TEXT_CHARS = 2000;
export const MAX_KEYS = 5;

export const TEXT_WARNING = "Typed into whatever has focus in the terminal; digits can pick options.";
export const SCROLLED_WARNING =
	"The terminal is scrolled back, so this is not its live bottom. What you type still goes to the live input.";
export const UNCERTAIN_MESSAGE = "Delivery uncertain, check the screen before sending again.";

export const KEYS: { key: TerminalKey; label: string; aria: string }[] = [
	{ key: "up", label: "↑", aria: "Up" },
	{ key: "down", label: "↓", aria: "Down" },
	{ key: "left", label: "←", aria: "Left" },
	{ key: "right", label: "→", aria: "Right" },
	{ key: "enter", label: "Enter", aria: "Enter" },
	{ key: "esc", label: "Esc", aria: "Esc" },
	{ key: "tab", label: "Tab", aria: "Tab" },
	{ key: "backspace", label: "⌫", aria: "Backspace" },
	{ key: "space", label: "Space", aria: "Space" },
];

// The hub's rule (`printable_line` in omp_hub/terminal.py): reject Unicode categories Cc (C0, DEL, C1), Cs (lone
// surrogates), Zl and Zp (line and paragraph separators) and Cn (unassigned). The `u` flag makes a lone surrogate
// match \p{Cs}. Cn follows the Unicode version of the JS engine, which can differ from Python's by newly assigned characters.
const BAD_CHAR = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Cn}]/u;

/** Why this text can't be typed into the terminal, or null. Counted in UTF-16 code units, like the hub. */
export function textProblem(text: string): string | null {
	if (text === "") return "Type something to send.";
	if (text.length > MAX_TEXT_CHARS) return `Text can be at most ${MAX_TEXT_CHARS} characters (an emoji counts as 2).`;
	if (BAD_CHAR.test(text)) return "Use one line of printable text: no line breaks or control characters.";
	return null;
}

export function keysProblem(keys: readonly string[]): string | null {
	if (keys.length > MAX_KEYS) return `Send at most ${MAX_KEYS} keys at a time.`;
	const known = new Set<string>(KEYS.map(k => k.key));
	return keys.every(k => known.has(k)) ? null : "Unknown key.";
}

/** A fresh id for every send: the hub treats a repeated id as the same send and answers with the first result. */
export function newRequestId(): string {
	return crypto.randomUUID();
}

const CODE_MESSAGES: Record<string, string> = {
	busy: "Another send is still in progress. Wait for it, then try again.",
	no_terminal: "This session has no terminal the hub can read.",
	ambiguous: "The hub can't tell which terminal belongs to this session, so it won't type into it.",
	changed: "The terminal changed (the session was restarted or moved). Open the session again.",
	uncertain: UNCERTAIN_MESSAGE,
	herdr: "The hub could not reach herdr. Try again in a moment.",
};

/** The message for a failed terminal request: a known code gets its own text, anything else the server's. */
export function terminalErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code && error.code in CODE_MESSAGES) return CODE_MESSAGES[error.code];
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export interface ScreenPollerOptions {
	load: () => Promise<HubScreen>;
	onScreen: (screen: HubScreen) => void;
	/** A failed poll stops the poller; the owner decides what to do (the panel locks). */
	onError: (error: unknown) => void;
	delayMs?: number;
	isHidden?: () => boolean;
}

export interface ScreenPoller {
	/** Poll now (cancels a pending wait). */
	refresh: () => void;
	/** Call when the tab becomes visible again. */
	resume: () => void;
	stop: () => void;
}

/**
 * Reads the screen, then waits `delayMs` after each read finishes (never on a fixed clock, so reads can't pile
 * up), and does nothing while the tab is hidden. Every read carries a sequence number: a response that is not
 * from the latest read, or that arrives after stop, is dropped.
 */
export function createScreenPoller(opts: ScreenPollerOptions): ScreenPoller {
	const delay = opts.delayMs ?? SCREEN_POLL_MS;
	const hidden = opts.isHidden ?? (() => false);
	let seq = 0;
	let stopped = false;
	let paused = false;
	let inflight = false;
	/** A refresh asked for while a read was running: one more read follows it (reads never overlap). */
	let followUp = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clear = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const run = async (): Promise<void> => {
		clear();
		if (stopped) return;
		if (inflight) {
			followUp = true;
			return;
		}
		if (hidden()) {
			paused = true;
			return;
		}
		paused = false;
		followUp = false;
		inflight = true;
		const mine = ++seq;
		try {
			const screen = await opts.load();
			inflight = false;
			if (stopped || mine !== seq) return;
			opts.onScreen(screen);
		} catch (error) {
			inflight = false;
			if (stopped || mine !== seq) return;
			stopped = true;
			opts.onError(error);
			return;
		}
		if (stopped) return;
		if (followUp) void run();
		else timer = setTimeout(() => void run(), delay);
	};
	return {
		refresh: () => void run(),
		resume: () => {
			if (paused) void run();
		},
		stop: () => {
			stopped = true;
			seq++;
			clear();
		},
	};
}
