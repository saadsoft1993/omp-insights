/**
 * A session's open question and its messages, through the hub (`GET .../ask`, `POST .../ask-answer`,
 * `POST .../message`). Both POSTs confirm admission, not a finished turn, and are never retried by themselves:
 * a repeat with a new id could deliver twice.
 */
import { ApiError } from "../api";
import { HubError, hubFetch, hubPost } from "./hub";

export type AskFieldType = "radio" | "checkbox" | "select" | "text" | "textarea" | "number" | "date";

export interface AskOption {
	value: string;
	label: string;
	disabled?: boolean;
}

/** One typed field the hub parsed from the question (never raw HTML). */
export interface AskField {
	name: string;
	type: AskFieldType;
	label: string;
	required: boolean;
	options: AskOption[];
	default: unknown;
	multiple: boolean;
	/** Radio and checkbox: offer a final "Other…" choice with the user's own text (as the omp TUI does). */
	allowOther: boolean;
}

export type HubAsk =
	| { open: false }
	| { open: true; askId: string; tooLarge: true }
	/** The form can't be shown faithfully here: only its text, when the hub has it. */
	| { open: true; unsupported: true; reason: string | null; text: string | null }
	| { open: true; askId: string; fields: AskField[]; tooLarge?: false };

/** Form state: arrays for checkboxes and multiple selects, text for everything else. */
export type AskValues = Record<string, string | string[]>;

/** "Other…" per field name: picked, and its text. */
export type AskOthers = Record<string, { on: boolean; text: string }>;

export type AskAnswer =
	| string
	| string[]
	| number
	| { value: string }
	| { other: string }
	| { values: string[]; other?: string };

/**
 * What the hub takes: radio `{value}` or `{other}`, checkbox `{values, other?}`, arrays for multiple selects,
 * numbers for number fields, text otherwise.
 */
export type AskAnswers = Record<string, AskAnswer>;

export const MAX_OTHER_CHARS = 2000;

/** The hub's raw reply: `{state}` (admitted, pending as HTTP 202, failed) or, from an older hub, `{accepted, delivery}`. */
export interface MessageAdmission {
	state?: "admitted" | "pending" | "failed";
	reason?: string;
	accepted?: true;
	delivery?: "started" | "queued";
	duplicate?: true;
}

/** Where one message stands once the page stops asking. */
export type Delivery =
	| { state: "delivered"; duplicate: boolean; delivery?: "started" | "queued" }
	| { state: "failed"; reason: string }
	| { state: "unconfirmed" };

export function readDelivery(raw: MessageAdmission): Delivery | "pending" {
	if (raw.state === "pending") return "pending";
	if (raw.state === "failed") return { state: "failed", reason: raw.reason ?? "no reason given" };
	// "unknown" or anything unexpected.
	if (raw.state === "admitted" || raw.accepted === true)
		return { state: "delivered", duplicate: raw.duplicate === true, delivery: raw.delivery };
	return { state: "unconfirmed" };
}

export const DELIVERY_POLL_MS = 2000;
export const DELIVERY_MAX_MS = 30_000;

/**
 * Send once. While the hub says pending (202), read `message-status` for the same id every 2 s for up to 30 s;
 * the POST is never repeated. A status that can't be read, or no answer in time, is "not confirmed".
 */
export async function deliver(
	post: () => Promise<MessageAdmission>,
	status: () => Promise<MessageAdmission>,
	opts: DeliveryPollOptions = {},
): Promise<Delivery> {
	const first = readDelivery(await post());
	return first === "pending" ? followDelivery(status, opts) : first;
}

export interface DeliveryPollOptions {
	intervalMs?: number;
	maxMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Read `message-status` until it settles or 30 s pass. Read-only: also what "Check again" runs. */
export async function followDelivery(
	status: () => Promise<MessageAdmission>,
	opts: DeliveryPollOptions = {},
	readFirst = false,
): Promise<Delivery> {
	const interval = opts.intervalMs ?? DELIVERY_POLL_MS;
	const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const now = opts.now ?? Date.now;
	const deadline = now() + (opts.maxMs ?? DELIVERY_MAX_MS);
	let wait = !readFirst;
	for (;;) {
		if (wait) {
			if (now() + interval > deadline) return { state: "unconfirmed" };
			await sleep(interval);
		}
		wait = true;
		let next: Delivery | "pending";
		try {
			next = readDelivery(await status());
		} catch {
			return { state: "unconfirmed" };
		}
		if (next !== "pending") return next;
	}
}

export function getMessageStatus(
	sessionId: string,
	messageId: string,
	machine: string | undefined,
): Promise<MessageAdmission> {
	return hubFetch(
		`${sessionPath(sessionId, "message-status")}?messageId=${encodeURIComponent(messageId)}`,
		undefined,
		machine,
	);
}

export const MAX_MESSAGE_CHARS = 8000;

const FIELD_TYPES: Record<AskFieldType, true> = {
	radio: true,
	checkbox: true,
	select: true,
	text: true,
	textarea: true,
	number: true,
	date: true,
};

function sessionPath(sessionId: string, rest: string): string {
	return `sessions/${encodeURIComponent(sessionId)}/${rest}`;
}

/** The question open in the session, or `{open:false}`. A reply that isn't the expected shape is refused. */
export async function getSessionAsk(
	sessionId: string,
	machine: string | undefined,
	signal?: AbortSignal,
): Promise<HubAsk> {
	const raw = await hubFetch<unknown>(sessionPath(sessionId, "ask"), { signal }, machine);
	const ask = parseAsk(raw);
	if (!ask) throw new Error("The hub sent a question this page doesn't understand.");
	return ask;
}

export function parseAsk(raw: unknown): HubAsk | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.open === false) return { open: false };
	if (r.unsupported === true) {
		const text = [r.text, r.summary, r.question].find(v => typeof v === "string" && v.trim() !== "");
		return {
			open: true,
			unsupported: true,
			reason: typeof r.reason === "string" && r.reason ? r.reason : null,
			text: typeof text === "string" ? text : null,
		};
	}
	if (r.open !== true || typeof r.askId !== "string" || !r.askId) return null;
	if (r.tooLarge === true) return { open: true, askId: r.askId, tooLarge: true };
	if (!Array.isArray(r.fields)) return null;
	const fields: AskField[] = [];
	for (const item of r.fields as unknown[]) {
		if (typeof item !== "object" || item === null) return null;
		const f = item as Record<string, unknown>;
		if (typeof f.name !== "string" || !f.name || !Object.hasOwn(FIELD_TYPES, String(f.type))) return null;
		const options: AskOption[] = [];
		for (const o of Array.isArray(f.options) ? (f.options as unknown[]) : []) {
			if (typeof o !== "object" || o === null) return null;
			const opt = o as Record<string, unknown>;
			if (typeof opt.value !== "string") return null;
			options.push({
				value: opt.value,
				label: typeof opt.label === "string" && opt.label ? opt.label : opt.value,
				disabled: opt.disabled === true,
			});
		}
		fields.push({
			name: f.name,
			type: f.type as AskFieldType,
			label: typeof f.label === "string" ? f.label : "",
			required: f.required === true,
			options,
			default: f.default ?? null,
			multiple: f.multiple === true,
			allowOther: f.allowOther === true && (f.type === "radio" || f.type === "checkbox"),
		});
	}
	return { open: true, askId: r.askId, fields };
}

/** Checkboxes and multiple selects hold a list. */
export function isListField(field: AskField): boolean {
	return field.type === "checkbox" || (field.type === "select" && field.multiple);
}

/** The form's starting values: each field's default, kept only when it is one of the field's enabled options. */
export function initialValues(fields: readonly AskField[]): AskValues {
	const values: AskValues = {};
	for (const field of fields) {
		const allowed = new Set(field.options.filter(o => !o.disabled).map(o => o.value));
		const given = field.default;
		if (isListField(field)) {
			const list = Array.isArray(given) ? given : given == null || given === "" ? [] : [given];
			values[field.name] = list.map(String).filter(v => allowed.has(v));
		} else if (field.type === "radio" || field.type === "select") {
			const value = given == null ? "" : String(given);
			values[field.name] = allowed.has(value) ? value : "";
		} else {
			values[field.name] = given == null ? "" : String(given);
		}
	}
	return values;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why each field can't be sent yet (only fields with a problem are listed). The hub checks the same again. */
export function answerProblems(
	fields: readonly AskField[],
	values: AskValues,
	others: AskOthers = {},
): Record<string, string> {
	const problems: Record<string, string> = {};
	for (const field of fields) {
		const value = values[field.name];
		const other = field.allowOther && others[field.name]?.on ? others[field.name].text : null;
		if (other !== null) {
			if (other.trim() === "") {
				problems[field.name] = "Type your answer.";
				continue;
			}
			if (other.trim().length > MAX_OTHER_CHARS) {
				problems[field.name] = `At most ${MAX_OTHER_CHARS} characters.`;
				continue;
			}
			if (field.type === "radio") continue;
		}
		const allowed = new Set(field.options.filter(o => !o.disabled).map(o => o.value));
		if (isListField(field)) {
			const list = Array.isArray(value) ? value : [];
			if (field.required && list.length === 0 && other === null) problems[field.name] = "Pick at least one.";
			else if (list.some(v => !allowed.has(v))) problems[field.name] = "Pick from the listed options.";
			continue;
		}
		const text = typeof value === "string" ? value : "";
		if (text.trim() === "") {
			if (field.required)
				problems[field.name] = field.type === "radio" || field.type === "select" ? "Pick one." : "Required.";
			continue;
		}
		if ((field.type === "radio" || field.type === "select") && !allowed.has(text))
			problems[field.name] = "Pick from the listed options.";
		else if (field.type === "number" && !Number.isFinite(Number(text.trim())))
			problems[field.name] = "Enter a number.";
		else if (field.type === "date" && (!DATE.test(text) || Number.isNaN(Date.parse(text))))
			problems[field.name] = "Enter a date as YYYY-MM-DD.";
		else if (text.length > MAX_MESSAGE_CHARS) problems[field.name] = `At most ${MAX_MESSAGE_CHARS} characters.`;
	}
	return problems;
}

/** The body's `answers`: empty optional fields are left out; radio and checkbox answers are objects. */
export function toAnswers(fields: readonly AskField[], values: AskValues, others: AskOthers = {}): AskAnswers {
	const answers: AskAnswers = {};
	for (const field of fields) {
		const value = values[field.name];
		const other = field.allowOther && others[field.name]?.on ? others[field.name].text : null;
		if (field.type === "radio") {
			if (other !== null) answers[field.name] = { other: other.trim() };
			else if (typeof value === "string" && value !== "") answers[field.name] = { value };
			continue;
		}
		if (field.type === "checkbox") {
			const list = Array.isArray(value) ? value : [];
			if (list.length || other !== null)
				answers[field.name] = other !== null ? { values: list, other: other.trim() } : { values: list };
			continue;
		}
		if (Array.isArray(value)) {
			if (value.length) answers[field.name] = value;
			continue;
		}
		if (typeof value !== "string" || value.trim() === "") continue;
		answers[field.name] = field.type === "number" ? Number(value.trim()) : value;
	}
	return answers;
}

/** A fresh id for one user action (1–128 ASCII letters, digits, `_` or `-`). */
export function newMessageId(prefix: "msg" | "ask" | "plan"): string {
	const random =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${random}`;
}

export const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function answerSessionAsk(
	sessionId: string,
	body: { askId: string; answers: AskAnswers; messageId: string },
	machine: string | undefined,
): Promise<MessageAdmission> {
	return hubPost(sessionPath(sessionId, "ask-answer"), { ...body }, machine);
}

export function sendSessionMessage(
	sessionId: string,
	body: { text: string; messageId: string },
	machine: string | undefined,
): Promise<MessageAdmission> {
	return hubPost(sessionPath(sessionId, "message"), { ...body }, machine);
}

/** Why the message can't be sent, or null (counted in UTF-16 units, as the hub and plugin count). */
export function messageProblem(text: string): string | null {
	if (text.trim() === "") return "Type a message.";
	if (text.length > MAX_MESSAGE_CHARS)
		return `A message can be at most ${MAX_MESSAGE_CHARS} characters (an emoji counts as 2).`;
	return null;
}

export const QUESTION_CLOSED_TEXT =
	"This question was already answered, possibly by your earlier click. Check the session.";
export const QUESTION_CHANGED_TEXT = "The agent asked a new question.";
export const QUESTION_TOO_LARGE_TEXT = "This question is too large for the dashboard; answer it in Open & control.";
export const QUESTION_UNSUPPORTED_TEXT = "This question needs the full session view.";
export const WAIT_MODE_TEXT =
	"This session reads messages only after its turn ends (interrupt mode: wait), so an answer sent from here would not reach the question. Answer it in Open & control.";
export const UNKNOWN_MODE_TEXT =
	"The session did not say how it takes messages during a turn, so answering from here is off. Answer it in Open & control.";
export const UNCERTAIN_TEXT = "Not confirmed; check the session before sending again. Nothing was resent.";

/** How a question answer failed: a 409 `changed` says whether the question closed or was replaced. */
export type AskFailure = { kind: "closed" | "changed" | "uncertain" | "error"; text: string };

export function askFailure(error: unknown): AskFailure {
	if (error instanceof ApiError) {
		const reason = error instanceof HubError ? error.reason : null;
		if (error.code === "changed" && reason === "question_closed")
			return { kind: "closed", text: QUESTION_CLOSED_TEXT };
		if (error.code === "changed" && reason === "question_changed")
			return { kind: "changed", text: QUESTION_CHANGED_TEXT };
		if (error.code === "changed")
			return {
				kind: "changed",
				text: "The session changed while you answered. Check the question, then answer again.",
			};
		if (error.code === "too_large") return { kind: "error", text: QUESTION_TOO_LARGE_TEXT };
		if (error.code === "wait") return { kind: "error", text: WAIT_MODE_TEXT };
	}
	return messageFailure(error);
}

/** How a message failed. A gateway error or a dropped connection may have been delivered: never "failed". */
export function messageFailure(error: unknown): AskFailure {
	if (error instanceof ApiError) {
		if (error.code === "invalid") return { kind: "error", text: `The session refused it: ${error.message}` };
		if (error.code === "busy")
			return { kind: "error", text: "Another change is still running in this session. Try again shortly." };
		if (error.code === "stale_session" || error.code === "changed")
			return { kind: "error", text: "This session was restarted or replaced. Check it, then send again." };
		if (error.code === "restart_needed" || error.code === "unsupported")
			return { kind: "error", text: "This session runs an older session plugin; restart it to send from here." };
		if (error.status === 502 || error.status === 504 || error.code === "socket" || error.code === "failed")
			return { kind: "uncertain", text: UNCERTAIN_TEXT };
		return { kind: "error", text: error.message };
	}
	// A network error after sending: the request may have arrived.
	return { kind: "uncertain", text: UNCERTAIN_TEXT };
}

export const UNCONFIRMED_TEXT = "Not confirmed; check the session before sending again.";

/** The line shown for a finished delivery. */
export function deliveryText(result: Delivery, what: "message" | "answer"): string {
	const noun = what === "answer" ? "Answer" : "Message";
	if (result.state === "failed") return `Failed: ${result.reason}`;
	if (result.state === "unconfirmed") return UNCONFIRMED_TEXT;
	if (result.duplicate) return `${noun} was already delivered earlier; it was not sent again.`;
	if (result.delivery === "queued") return `${noun} delivered; the session reads it when the running turn lets it.`;
	return `${noun} delivered.`;
}
