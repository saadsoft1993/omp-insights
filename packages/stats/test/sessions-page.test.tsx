import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { ApiError } from "../src/client/api";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { HubError } from "../src/client/data/hub";
import { clearQueryCache } from "../src/client/data/query-store";
import {
	answerProblems,
	askFailure,
	type AskField,
	deliver,
	deliveryText,
	initialValues,
	messageFailure,
	messageProblem,
	parseAsk,
	QUESTION_CHANGED_TEXT,
	QUESTION_CLOSED_TEXT,
	QUESTION_UNSUPPORTED_TEXT,
	toAnswers,
	UNCERTAIN_TEXT,
	WAIT_MODE_TEXT,
} from "../src/client/data/session-ask";
import { capabilityState, updateHubHint, useHubVersion } from "../src/client/data/session-capabilities";
import { pagePollMs } from "../src/client/data/page-polling";
import {
	outcomeText,
	pollPlanNotes,
	statusOutcome,
	UNCONFIRMED_NOTES_TEXT,
} from "../src/client/data/session-plan-notes";
import { KNOWN_STATS_REASONS, namedStatsReason, plainStatsReason } from "../src/client/app/stats-reasons";
import { subagentsFailure, subagentsUnavailable, subagentsUrl } from "../src/client/data/session-subagents";
import {
	countsLine,
	machineDown,
	machineHeld,
	sessionStatus,
	sessionsSubtitle,
	shortModelName,
} from "../src/client/data/session-view";
import { SessionsRoute } from "../src/client/routes/SessionsRoute";
import { all, byText, click, isDisabled, mount, settle, text, type, unmount, valueOf } from "./helpers/memory-dom";
import { installPlanWorker } from "./helpers/plan-worker";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

const FLEET = [
	{ id: "server", name: "Ada Server", self: true, ok: true },
	{ id: "macbook", name: "Ada MacBook", self: false, ok: true },
	{ id: "mini", name: "Ada Mac mini", self: false, ok: true },
];

const CAPS = {
	askAnswer: true,
	sessionMessage: true,
	planNotes: true,
	sessionGoal: true,
	sessionInstructions: true,
	liveCost: true,
};

const INFO = {
	model: { provider: "anthropic", id: "claude-opus-5-5" },
	thinkingLevel: "medium",
	thinkingLevels: ["low", "medium", "high"],
	models: [{ provider: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5" }],
	mode: { plan: false, goal: true, loop: false, vibe: false },
	modeStatus: { plan: "inactive", goal: "active", loop: "inactive", vibe: "inactive" },
	goal: { objective: "Make recall answer within 2 s" },
	interruptMode: "immediate",
};

const FIELDS: AskField[] = [
	{
		name: "choice",
		type: "radio",
		label: "Which plan?",
		required: true,
		options: [
			{ value: "a", label: "Replace it" },
			{ value: "b", label: "Keep the original" },
		],
		default: null,
		multiple: false,
		allowOther: false,
	},
	{
		name: "extras",
		type: "checkbox",
		label: "Also",
		required: false,
		options: [
			{ value: "tests", label: "Add tests" },
			{ value: "docs", label: "Update docs" },
		],
		default: ["docs"],
		multiple: true,
		allowOther: false,
	},
	{
		name: "tier",
		type: "select",
		label: "Tier",
		required: false,
		options: [
			{ value: "opus", label: "Opus" },
			{ value: "sonnet", label: "Sonnet", disabled: true },
		],
		default: "sonnet",
		multiple: false,
		allowOther: false,
	},
	{
		name: "note",
		type: "text",
		label: "Note",
		required: false,
		options: [],
		default: "hi",
		multiple: false,
		allowOther: false,
	},
	{
		name: "why",
		type: "textarea",
		label: "Why",
		required: true,
		options: [],
		default: null,
		multiple: false,
		allowOther: false,
	},
	{
		name: "count",
		type: "number",
		label: "How many",
		required: false,
		options: [],
		default: null,
		multiple: false,
		allowOther: false,
	},
];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function row(machine: string, id: string, over: Record<string, unknown> = {}) {
	return {
		instanceId: `inst-${id}`,
		sessionId: `sess-${id}`,
		sessionName: `Session ${id}`,
		cwd: `/Users/me/projects/${id}`,
		busy: false,
		relay: "tailnet",
		control: true,
		pid: 100,
		startedAt: Date.now() - 3_600_000,
		machine,
		costSoFar: 1.5,
		lastActivityAt: Date.now() - 60_000,
		...over,
	};
}

interface Call {
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}

type Handler = (call: Call, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Fleet hub stub: two sessions on macbook and mini; `handle` may answer any request first. */
function mockHub(rows: unknown[], handle: Handler = () => undefined, caps: Record<string, boolean> = CAPS) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		const call = { url, method: init?.method ?? "GET", body };
		calls.push(call);
		const own = await handle(call, init);
		if (own) return own;
		if (url === "/api/hub/sessions")
			return json({
				sessions: rows,
				machines: FLEET.map(m => ({ id: m.id, name: m.name, ok: true })),
				now: Date.now(),
			});
		if (url.endsWith("/api/hub/version"))
			return json({ hub: { commit: "abc", dirty: false, startedAt: 0 }, ui: null, capabilities: caps });
		if (url.endsWith("/session-info")) return json(INFO);
		if (url.endsWith("/ask")) return json({ open: true, askId: "ask-1", fields: FIELDS });
		if (url.endsWith("/plan-review"))
			return json({
				open: true,
				reviewId: "rev-1",
				title: "Add retry",
				planFilePath: "/tmp/p.md",
				options: [
					{ id: "execute", label: "Approve and execute", disabled: false },
					{ id: "compact", label: "Approve and compact context", disabled: false },
					{ id: "keep", label: "Approve and keep context", disabled: false },
					{ id: "refine", label: "Refine plan", disabled: false },
					{ id: "save", label: "Save and quit", disabled: false },
				],
				tiers: null,
				planContent: "# Plan",
				truncated: false,
			});
		return json({});
	}) as typeof fetch);
	return calls;
}

/** The light DOM has no implicit submission: submit the button's form the way a press would. */
async function press(button: Element | null) {
	const form = button?.closest("form");
	if (!form) throw new Error("press: no form");
	await act(async () => {
		form.dispatchEvent(
			new (globalThis.window as unknown as { Event: typeof Event }).Event("submit", {
				bubbles: true,
				cancelable: true,
			}),
		);
	});
}

function withMedia(h: ReturnType<typeof mount>) {
	(globalThis.window as unknown as Record<string, unknown>).matchMedia = () => ({
		matches: true,
		addEventListener() {},
		removeEventListener() {},
	});
	return h;
}

async function openDrawer(rows: unknown[], selected: string, handle?: Handler, caps?: Record<string, boolean>) {
	setFleet(parseMachines(FLEET));
	const calls = mockHub(rows, handle, caps);
	const h = withMedia(mount());
	await h.render(<SessionsRoute active selected={selected} onSelect={() => {}} />);
	await settle(40);
	return { h, calls };
}

const posts = (calls: Call[], end: string) =>
	calls.filter(c => c.method === "POST" && c.url.split("?")[0].endsWith(end));
const gets = (calls: Call[], part: string) => calls.filter(c => c.method === "GET" && c.url.includes(part));

describe("live sessions table", () => {
	it("groups rows by machine under All machines and lists only the header machine otherwise", async () => {
		setFleet(parseMachines(FLEET));
		mockHub([row("macbook", "a"), row("mini", "b"), row("macbook", "c", { busy: true })]);
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		expect(all(h.container, "tr.std-group").map(r => text(r))).toEqual([
			"Ada MacBook",
			"Ada Mac mini",
			"Ada Server",
		]);
		// A machine without sessions keeps its group, with a line saying so (D21).
		expect(all(h.container, "tr.std-group-empty").map(r => text(r))).toEqual(["Ada Server: no live sessions"]);
		expect(text(h.container)).toContain("$1.50");
		expect(text(h.container)).toContain("1 working · 2 idle");
		selectMachine("mini");
		await settle();
		expect(all(h.container, "tbody tr:not(.std-group):not(.std-detail)").map(r => text(r))).toHaveLength(1);
		expect(h.container.querySelector("tr.std-group")).toBeNull();
	});

	it("expands a row into its subagents, from that machine, with parentLive only for a fresh live row", async () => {
		setFleet(parseMachines(FLEET));
		const calls = mockHub([row("mini", "b")], call => {
			if (call.url.startsWith("/m/mini/api/sessions?")) return json([{ sessionId: "sess-b", file: "/x/b.jsonl" }]);
			if (call.url.startsWith("/m/mini/api/session/subagents"))
				return json([
					{
						id: "c1",
						agent: "task",
						title: "Build the page",
						models: ["anthropic/claude-sonnet-5-5"],
						startedAt: Date.now() - 60_000,
						endedAt: Date.now(),
						durationMs: 60_000,
						costTotal: 0.25,
						requests: 3,
						status: "cut_off",
						toolErrors: 2,
					},
				]);
			return undefined;
		});
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		await click(h.container.querySelector('button[aria-label^="Expand"]'));
		await settle(40);
		expect(calls.some(c => c.url === "/m/mini/api/session/subagents?file=%2Fx%2Fb.jsonl&parentLive=1")).toBe(true);
		const detail = text(h.container.querySelector("tr.std-detail") as Element);
		expect(detail).toContain("Build the page");
		expect(detail).toContain("Cut off");
		expect(detail).toContain("2 tool errors");
		expect(subagentsUrl("/a b.jsonl", "macbook", false)).toBe("/m/macbook/api/session/subagents?file=%2Fa+b.jsonl");
	});

	it("shows loading, error with Try again, and the empty state", async () => {
		setFleet(parseMachines(FLEET));
		let fail = true;
		let release = () => {};
		const gate = new Promise<void>(resolve => (release = resolve));
		mockHub([], async call => {
			if (call.url !== "/api/hub/sessions" || !fail) return undefined;
			await gate;
			return json({ error: "hub down" }, 500);
		});
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		expect(h.container.querySelector(".std-skeleton")).not.toBeNull();
		release();
		await settle(2200);
		expect(text(h.container)).toContain("Could not load the sessions");
		fail = false;
		await click(byText(h.container, "button", "Try again"));
		await settle();
		expect(text(h.container)).toContain("No live omp sessions");
	});

	it("reads status, model names and counts", () => {
		expect(sessionStatus({ instanceId: "i", stale: true, busy: true }).label).toBe("Last known");
		expect(
			sessionStatus({
				instanceId: "i",
				terminal: { available: true, unknown: false, waiting: { kind: "oauth", line: "x", observedAt: "" } },
			}).label,
		).toBe("Waiting on login");
		expect(sessionStatus({ instanceId: "i", busy: false, agentsRunning: 2 }).label).toBe("Working");
		expect(shortModelName("claude-opus-5-5")).toBe("Opus 5.5");
		expect(shortModelName("gpt-6.1-sol")).toBe("GPT 6.1 Sol");
		expect(
			countsLine([
				{ instanceId: "a", inputRequired: true },
				{ instanceId: "b", busy: false },
			]),
		).toBe("1 needs you · 0 working · 1 idle");
	});
});

describe("session actions go to the row's own machine", () => {
	for (const machine of ["macbook", "mini"]) {
		it(`sends stop, rename and kill to /m/${machine}/`, async () => {
			// No name yet: the light DOM can't edit a prefilled field, so the rename starts empty.
			const { h, calls } = await openDrawer(
				[row(machine, "a", { busy: true, sessionName: undefined })],
				"sess-a",
				call =>
					call.url.endsWith("/kill")
						? json({ outcome: "exited" })
						: call.url.endsWith("/stop")
							? json({ outcome: "stopped" })
							: undefined,
			);
			await click(byText(h.body, ".sd-actions button", "Stop"));
			await settle();
			expect(posts(calls, "/stop").map(c => c.url)).toEqual([`/m/${machine}/api/hub/sessions/sess-a/stop`]);
			await click(byText(h.body, ".sd-actions button", "Rename"));
			await type(h.body.querySelector('input[aria-label="Session name"]'), "New name");
			await press(byText(h.body, "button", "Save name"));
			await settle();
			expect(posts(calls, "/rename")[0]).toMatchObject({
				url: `/m/${machine}/api/hub/sessions/sess-a/rename`,
				body: { name: "New name" },
			});
			await click(byText(h.body, ".sd-actions button", "Kill…"));
			const dialog = h.body.querySelector(".modal, [role=dialog]:last-of-type") as Element;
			const confirmKill = () => byText(h.body, "button", "Kill session");
			expect(isDisabled(confirmKill())).toBe(true);
			await type(h.body.querySelector('input[aria-label="Confirm by typing the name"]'), "a");
			expect(isDisabled(confirmKill())).toBe(false);
			await click(confirmKill());
			await settle();
			expect(dialog).not.toBeNull();
			expect(posts(calls, "/kill")[0]).toMatchObject({
				url: `/m/${machine}/api/hub/sessions/sess-a/kill`,
				body: { confirm: "a" },
			});
		});

		it(`sends a message to /m/${machine}/ with a fresh id per press`, async () => {
			const { h, calls } = await openDrawer([row(machine, "a")], "sess-a", call =>
				call.url.endsWith("/message") ? json({ state: "admitted" }) : undefined,
			);
			const box = () => h.body.querySelector('textarea[aria-label="Message"]');
			await type(box(), "hello");
			await press(byText(h.body, "button", "Send"));
			await settle();
			await type(box(), "again");
			await press(byText(h.body, "button", "Send"));
			await settle();
			const sent = posts(calls, "/message");
			expect(sent.map(c => c.url)).toEqual([
				`/m/${machine}/api/hub/sessions/sess-a/message`,
				`/m/${machine}/api/hub/sessions/sess-a/message`,
			]);
			expect(sent[0].body?.text).toBe("hello");
			expect(sent[0].body?.messageId).toMatch(/^msg-[A-Za-z0-9_-]+$/);
			expect(sent[0].body?.messageId).not.toBe(sent[1].body?.messageId);
			expect(text(h.body)).toContain("Message delivered.");
		});
	}

	it("lists instruction files and previews one from the row's machine", async () => {
		const { h, calls } = await openDrawer([row("mini", "a")], "sess-a", call => {
			if (call.url === "/m/mini/api/hub/sessions/sess-a/instructions")
				return json({
					files: [
						{
							path: "/Users/me/projects/CLAUDE.md",
							kind: "workspace",
							size: 2048,
							mtime: "2026-11-17T10:00:00Z",
						},
					],
				});
			if (call.url.startsWith("/m/mini/api/hub/sessions/sess-a/instructions/file"))
				return json({
					path: "/Users/me/projects/CLAUDE.md",
					size: 2048,
					text: "# Projects root",
					truncated: false,
				});
			return undefined;
		});
		await click(byText(h.body, "[role=tab]", "Instructions"));
		await settle(40);
		expect(text(h.body)).toContain("~/projects/CLAUDE.md");
		await click(h.body.querySelector('.drawer button[aria-label^="Expand"]'));
		await settle(40);
		expect(gets(calls, "/instructions/file").map(c => c.url)).toEqual([
			"/m/mini/api/hub/sessions/sess-a/instructions/file?path=%2FUsers%2Fme%2Fprojects%2FCLAUDE.md",
		]);
		expect(h.body.querySelector(".sd-preview")?.textContent).toBe("# Projects root");
	});

	it("shows the goal's objective", async () => {
		const { h } = await openDrawer([row("macbook", "a")], "sess-a");
		expect(h.body.querySelector(".sd-goal")?.textContent).toBe("Make recall answer within 2 s");
	});
});

describe("message delivery", () => {
	it("polls message-status on pending and never posts again", async () => {
		const answers = [{ state: "pending" }, { state: "pending" }, { state: "admitted" }];
		const post = vi.fn(async () => ({ state: "pending" as const }));
		const status = vi.fn(async () => answers.shift() as { state: "pending" | "admitted" });
		const sleeps: number[] = [];
		const result = await deliver(post, status, { sleep: async ms => void sleeps.push(ms) });
		expect(result).toEqual({ state: "delivered", duplicate: false, delivery: undefined });
		expect(post).toHaveBeenCalledTimes(1);
		expect(status).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([2000, 2000, 2000]);
	});

	it("gives up as not confirmed after 30 s, and on an unreadable status", async () => {
		let t = 0;
		const pending = async () => ({ state: "pending" as const });
		const result = await deliver(pending, pending, { sleep: async ms => void (t += ms), now: () => t });
		expect(result).toEqual({ state: "unconfirmed" });
		expect(t).toBe(30_000);
		const broken = await deliver(pending, async () => Promise.reject(new Error("x")), { sleep: async () => {} });
		expect(broken).toEqual({ state: "unconfirmed" });
	});

	it("words each end state", () => {
		expect(deliveryText({ state: "delivered", duplicate: false }, "message")).toBe("Message delivered.");
		expect(deliveryText({ state: "failed", reason: "session busy" }, "answer")).toBe("Failed: session busy");
		expect(deliveryText({ state: "unconfirmed" }, "message")).toBe(
			"Not confirmed; check the session before sending again.",
		);
	});

	it("polls the status URL in the page on a 202", async () => {
		const { h, calls } = await openDrawer([row("macbook", "a")], "sess-a", call => {
			if (call.url.endsWith("/message")) return json({ state: "pending" }, 202);
			if (call.url.includes("/message-status")) return json({ state: "failed", reason: "turn refused it" });
			return undefined;
		});
		await type(h.body.querySelector('textarea[aria-label="Message"]'), "hello");
		await press(byText(h.body, "button", "Send"));
		expect(text(h.body)).toContain("Sending…");
		await settle(2200);
		const id = posts(calls, "/message")[0].body?.messageId as string;
		expect(posts(calls, "/message")).toHaveLength(1);
		expect(gets(calls, "/message-status").map(c => c.url)).toEqual([
			`/m/macbook/api/hub/sessions/sess-a/message-status?messageId=${id}`,
		]);
		expect(text(h.body)).toContain("Failed: turn refused it");
	});

	it("maps message errors; a gateway error is never called failed", () => {
		expect(messageProblem("  ")).toBe("Type a message.");
		expect(messageProblem("x".repeat(8001))).toContain("at most 8000");
		expect(messageFailure(new ApiError(502, "/x", "socket", "socket")).kind).toBe("uncertain");
		expect(messageFailure(new TypeError("Failed to fetch")).text).toBe(UNCERTAIN_TEXT);
		expect(messageFailure(new ApiError(409, "/x", "busy", "busy")).kind).toBe("error");
		expect(messageFailure(new ApiError(409, "/x", "restart", "restart_needed")).text).toContain(
			"older session plugin",
		);
	});
});

describe("questions", () => {
	it("parses only the typed shape and refuses anything else", () => {
		expect(parseAsk({ open: false })).toEqual({ open: false });
		expect(parseAsk({ open: true, askId: "a", tooLarge: true })).toEqual({ open: true, askId: "a", tooLarge: true });
		expect(parseAsk({ open: true, askId: "a", fields: [{ name: "x", type: "html" }] })).toBeNull();
		expect(parseAsk({ open: true, fields: [] })).toBeNull();
	});

	it("starts from valid defaults, validates required, options, numbers and dates, and sends numbers as numbers", () => {
		const values = initialValues(FIELDS);
		expect(values).toEqual({ choice: "", extras: ["docs"], tier: "", note: "hi", why: "", count: "" });
		expect(answerProblems(FIELDS, values)).toEqual({ choice: "Pick one.", why: "Required." });
		const date: AskField = {
			name: "d",
			type: "date",
			label: "",
			required: false,
			options: [],
			default: null,
			multiple: false,
		};
		expect(answerProblems([date], { d: "17/11/2026" })).toEqual({ d: "Enter a date as YYYY-MM-DD." });
		expect(answerProblems(FIELDS, { ...values, choice: "z", why: "x", count: "ten" })).toEqual({
			choice: "Pick from the listed options.",
			count: "Enter a number.",
		});
		expect(toAnswers(FIELDS, { ...values, choice: "a", why: "because", count: "3" })).toEqual({
			choice: { value: "a" },
			extras: { values: ["docs"] },
			note: "hi",
			why: "because",
			count: 3,
		});
	});

	it("maps each 409 reason and never retries", () => {
		const changed = (reason: string | null) => new HubError(409, "/x", "changed", "changed", reason);
		expect(askFailure(changed("question_closed"))).toEqual({ kind: "closed", text: QUESTION_CLOSED_TEXT });
		expect(askFailure(changed("question_changed"))).toEqual({ kind: "changed", text: QUESTION_CHANGED_TEXT });
		expect(askFailure(changed(null)).kind).toBe("changed");
		expect(askFailure(new HubError(409, "/x", "w", "wait", null)).text).toBe(WAIT_MODE_TEXT);
		expect(askFailure(new HubError(409, "/x", "t", "too_large", null)).text).toContain("too large");
	});

	it("renders every field with our own controls and answers on the row's machine", async () => {
		const { h, calls } = await openDrawer([row("mini", "a", { inputRequired: true })], "sess-a", call =>
			call.url.endsWith("/ask-answer") ? json({ state: "admitted" }) : undefined,
		);
		expect(gets(calls, "/ask").map(c => c.url)).toContain("/m/mini/api/hub/sessions/sess-a/ask");
		const form = h.body.querySelector(".sd-ask") as Element;
		expect(all(form, 'input[type="radio"]')).toHaveLength(2);
		expect(all(form, 'input[type="checkbox"]')).toHaveLength(2);
		expect(all(form, "select")).toHaveLength(1);
		expect(all(form, 'input[type="number"]')).toHaveLength(1);
		expect(all(form, "textarea")).toHaveLength(1);
		expect(byText(h.body, "button", "Answer in Open & control")).not.toBeNull();
		await press(byText(form, "button", "Send answer"));
		await settle();
		expect(text(form)).toContain("Pick one.");
		expect(posts(calls, "/ask-answer")).toHaveLength(0);
		await click(all(form, 'input[type="radio"]')[1]);
		await type(form.querySelector("textarea"), "safer");
		await type(form.querySelector('input[type="number"]'), "2");
		await press(byText(form, "button", "Send answer"));
		await settle();
		const sent = posts(calls, "/ask-answer");
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe("/m/mini/api/hub/sessions/sess-a/ask-answer");
		expect(sent[0].body).toMatchObject({
			askId: "ask-1",
			answers: { choice: { value: "b" }, extras: { values: ["docs"] }, note: "hi", why: "safer", count: 2 },
		});
		expect(sent[0].body?.messageId).toMatch(/^ask-/);
		expect(text(h.body)).toContain("Answer delivered.");
	});

	it("says the question closed, without a retry, and reloads a changed one", async () => {
		let reason = "question_closed";
		const { h, calls } = await openDrawer([row("macbook", "a", { inputRequired: true })], "sess-a", call =>
			call.url.endsWith("/ask-answer") ? json({ error: "changed", code: "changed", reason }, 409) : undefined,
		);
		const fill = async () => {
			const form = h.body.querySelector(".sd-ask") as Element;
			await click(all(form, 'input[type="radio"]')[0]);
			await type(form.querySelector("textarea"), "x");
			await press(byText(form, "button", "Send answer"));
			await settle();
		};
		await fill();
		expect(text(h.body)).toContain(QUESTION_CLOSED_TEXT);
		expect(posts(calls, "/ask-answer")).toHaveLength(1);
		expect(isDisabled(byText(h.body, "button", "Send answer"))).toBe(true);

		await unmount();
		clearQueryCache();
		reason = "question_changed";
		const second = await openDrawer([row("macbook", "a", { inputRequired: true })], "sess-a", call =>
			call.url.endsWith("/ask-answer") ? json({ error: "changed", code: "changed", reason }, 409) : undefined,
		);
		const form = second.h.body.querySelector(".sd-ask") as Element;
		await click(all(form, 'input[type="radio"]')[0]);
		await type(form.querySelector("textarea"), "x");
		const asksBefore = gets(second.calls, "/ask").filter(c => c.url.endsWith("/ask")).length;
		await press(byText(form, "button", "Send answer"));
		await settle();
		expect(text(second.h.body)).toContain(QUESTION_CHANGED_TEXT);
		expect(gets(second.calls, "/ask").filter(c => c.url.endsWith("/ask")).length).toBe(asksBefore + 1);
		expect(posts(second.calls, "/ask-answer")).toHaveLength(1);
	});

	it("shows the text, no form, and Open & control for a question the page can't draw", async () => {
		expect(parseAsk({ unsupported: true, reason: "file upload", text: "Pick a file" })).toEqual({
			open: true,
			unsupported: true,
			reason: "file upload",
			text: "Pick a file",
		});
		const { h, calls } = await openDrawer([row("mini", "a", { inputRequired: true })], "sess-a", call =>
			call.url.endsWith("/ask")
				? json({ unsupported: true, reason: "file upload", summary: "Which file?" })
				: undefined,
		);
		expect(h.body.querySelector(".sd-ask")).toBeNull();
		expect(text(h.body)).toContain("Which file?");
		expect(text(h.body)).toContain(QUESTION_UNSUPPORTED_TEXT);
		expect(byText(h.body, "button", "Answer in Open & control")).not.toBeNull();
		expect(posts(calls, "/ask-answer")).toHaveLength(0);
	});

	it("turns answering off in wait mode, with the reason", async () => {
		const { h } = await openDrawer([row("macbook", "a", { inputRequired: true })], "sess-a", call =>
			call.url.endsWith("/session-info") ? json({ ...INFO, interruptMode: "wait" }) : undefined,
		);
		expect(text(h.body)).toContain(WAIT_MODE_TEXT);
		expect(isDisabled(byText(h.body, "button", "Send answer"))).toBe(true);
	});
});

describe("capability gating", () => {
	it("says which machine's hub to update and keeps Open & control", async () => {
		const { h, calls } = await openDrawer(
			[row("macbook", "a", { inputRequired: true, planReview: null })],
			"sess-a",
			undefined,
			{},
		);
		expect(text(h.body)).toContain(updateHubHint("Ada MacBook", "askAnswer"));
		expect(text(h.body)).toContain(updateHubHint("Ada MacBook", "sessionMessage"));
		expect(byText(h.body, "button", "Answer in Open & control")).not.toBeNull();
		expect(gets(calls, "/ask").filter(c => c.url.endsWith("/ask"))).toHaveLength(0);
		expect(gets(calls, "/version").map(c => c.url)).toEqual(["/m/macbook/api/hub/version"]);
		expect(capabilityState(null, "askAnswer")).toBe("unknown");
		expect(capabilityState({ hub: { commit: null, dirty: null, startedAt: 0 }, ui: null }, "askAnswer")).toBe("off");
	});

	it("hides plan notes when the hub can't, and says omp 18.19 when the session can't", async () => {
		installPlanWorker();
		const planned = {
			planControl: "supported",
			planReview: { reviewId: "rev-1", title: "Add retry", openedAt: new Date().toISOString() },
		};
		const off = await openDrawer([row("macbook", "a", planned)], "sess-a", undefined, { ...CAPS, planNotes: false });
		expect(text(off.h.body)).toContain(updateHubHint("Ada MacBook", "planNotes"));
		expect(off.h.body.querySelector('textarea[id^="plan-notes-"]')).toBeNull();
		await unmount();
		clearQueryCache();

		const old = await openDrawer([row("macbook", "a", planned)], "sess-a", call =>
			call.url.includes("/plan-notes") && call.method === "POST"
				? json({ error: "update the session plugin", code: "restart_needed" }, 409)
				: undefined,
		);
		await type(old.h.body.querySelector('textarea[id^="plan-notes-"]'), "also add tests");
		await click(byText(old.h.body, ".plan-box button", "Approve with changes"));
		await click(byText(old.h.body, "[role=dialog] button[data-variant=primary]", "Approve with changes"));
		await settle();
		expect(text(old.h.body)).toContain("needs omp 18.19");
		expect(old.h.body.querySelector('textarea[id^="plan-notes-"]')).toBeNull();
	});
});

/** A request that never answers, until the page aborts it (as a timeout does). */
function hang(init?: RequestInit): Promise<Response> {
	return new Promise((_, reject) => {
		const signal = init?.signal;
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** The hub's list with `machine` unreachable and its rows stale (its last known state). */
const unreachableHub =
	(rows: unknown[], machine: string): Handler =>
	call =>
		call.url === "/api/hub/sessions"
			? json({
					sessions: rows,
					machines: FLEET.map(m => ({ id: m.id, name: m.name, ok: m.id !== machine })),
					now: Date.now(),
				})
			: undefined;

describe("page polling", () => {
	it("counts the sessions list, never the 60 s capability check or an expanded row's subagents", async () => {
		setFleet(parseMachines(FLEET));
		mockHub([row("macbook", "a")]);
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected="sess-a" onSelect={() => {}} />);
		await settle(40);
		await click(h.container.querySelector('button[aria-label^="Expand"]'));
		await settle(40);
		// The list's own 5 s refresh is the page's; the drawer's capability check and the expander don't count.
		expect(pagePollMs()).toBe(5000);
		await unmount();
		expect(pagePollMs()).toBeNull();
		function Caps() {
			useHubVersion("macbook", true);
			return null;
		}
		const caps = withMedia(mount());
		await caps.render(<Caps />);
		await settle();
		expect(pagePollMs()).toBeNull();
	});
});

describe("capability check timeout (D5)", () => {
	it("shares one check per machine across panels and times out to an error with Try again", async () => {
		let answer = false;
		setFleet(parseMachines(FLEET));
		// The version request hangs until the page aborts it, as a slow machine would.
		const seen = mockHub([row("macbook", "a", { inputRequired: true, planReview: null })], (call, init) =>
			call.url.endsWith("/api/hub/version") && !answer ? hang(init) : undefined,
		);
		const view = withMedia(mount());
		await view.render(<SessionsRoute active selected="sess-a" onSelect={() => {}} />);
		await settle(40);
		expect(text(view.body)).toContain("Checking what Ada MacBook's hub can do…");
		await settle(5300);
		const failed = "Could not check what Ada MacBook's hub can do: The hub did not answer within 5 s.";
		// The question callout and Send a message both wait on the same, single request.
		expect(text(view.body).split(failed).length - 1).toBe(2);
		expect(seen.filter(c => c.url === "/m/macbook/api/hub/version")).toHaveLength(1);
		expect(text(view.body)).not.toContain("Checking what");
		answer = true;
		await click(byText(view.body, "button", "Try again"));
		await settle(60);
		expect(text(view.body)).not.toContain(failed);
		expect(byText(view.body, "button", "Send")).not.toBeNull();
	}, 15_000);

	it("says the machine is unreachable instead of checking when its rows are stale", async () => {
		const rows = [row("macbook", "a", { stale: true })];
		const { h, calls } = await openDrawer(rows, "sess-a", unreachableHub(rows, "macbook"));
		expect(text(h.body)).not.toContain("Checking what");
		expect(text(h.body)).toContain("Ada MacBook is unreachable");
		expect(gets(calls, "/version")).toHaveLength(0);
	});
});

describe("empty machines (D21)", () => {
	it("names an unreachable machine without rows, hides empty groups under a filter, and centres Start when empty", async () => {
		setFleet(parseMachines(FLEET));
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) =>
			String(input) === "/api/hub/sessions"
				? json({
						sessions: [row("macbook", "a")],
						machines: [
							{ id: "server", name: "Ada Server", ok: true },
							{ id: "macbook", name: "Ada MacBook", ok: true },
							{ id: "mini", name: "Ada Mac mini", ok: false, staleSince: Date.now() - 60_000 },
						],
						now: Date.now(),
					})
				: json({})) as typeof fetch);
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		expect(all(h.container, "tr.std-group-empty").map(r => text(r))).toEqual([
			"Ada Server: no live sessions",
			"Ada Mac mini is unreachable; its sessions are unknown",
		]);
		selectMachine("mini");
		await settle();
		expect(h.container.querySelector("tr.std-group-empty")).toBeNull();
		expect(text(h.container)).toContain("No live omp sessions");
		expect(byText(h.container, ".std-state button", "Start a session")).not.toBeNull();
	});
});

describe("live sessions subtitle", () => {
	const m = (id: string, ok = true) => ({ id, name: `Ada ${id}`, ok });
	it("names machines that didn't answer and offers a row only when there is one", () => {
		const held = (id: string) => ({ ...m(id), stale: true });
		const one = [row("macbook", "a")] as never[];
		expect(sessionsSubtitle(one, [m("server"), m("macbook")])).toBe(
			"0 working · 1 idle. Click a row for its controls.",
		);
		expect(sessionsSubtitle([], [m("server"), m("macbook")])).toBe("0 working · 0 idle.");
		expect(sessionsSubtitle(one, [m("server"), m("macbook"), m("mini", false)])).toBe(
			"0 working · 1 idle · 2 of 3 machines answered · 1 didn't. Click a row for its controls.",
		);
		// A held machine is last known, not answered (review: "2 of 3 machines answered").
		expect(sessionsSubtitle(one, [m("server"), held("macbook"), m("mini", false)])).toBe(
			"0 working · 1 idle · 1 of 3 machines answered · 1 last known · 1 didn't. Click a row for its controls.",
		);
		expect(sessionsSubtitle([], [m("server", false), m("mini", false)])).toBe(
			"0 working · 0 idle · no machine answered.",
		);
		expect(sessionsSubtitle([], [m("mini", false)])).toBe("0 working · 0 idle · Ada mini didn't answer.");
		expect(sessionsSubtitle(one, [held("mini")])).toBe(
			"0 working · 1 idle · Ada mini's rows are last known. Click a row for its controls.",
		);
		// Rows filtered away: the counts stay, but there's no row to click.
		expect(sessionsSubtitle(one, [m("server")], 0)).toBe("0 working · 1 idle.");
	});

	it("drops the row prompt when the filter hides every row", async () => {
		setFleet(parseMachines(FLEET));
		mockHub([row("macbook", "a")]);
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("Click a row for its controls.");
		await type(h.container.querySelector('input[aria-label="Filter sessions"]'), "nothing matches this");
		await settle();
		expect(text(h.container)).not.toContain("Click a row for its controls.");
	});

	it("shows it on the page under All machines", async () => {
		setFleet(parseMachines(FLEET));
		mockHub([row("macbook", "a")], call =>
			call.url === "/api/hub/sessions"
				? json({
						sessions: [row("macbook", "a")],
						machines: FLEET.map(f => ({ id: f.id, name: f.name, ok: f.id !== "mini" })),
						now: Date.now(),
					})
				: undefined,
		);
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("2 of 3 machines answered · 1 didn't. Click a row for its controls.");
	});
});

describe("subagent expander (D7)", () => {
	it("says an unreachable machine's subagents are unavailable and asks nothing", async () => {
		setFleet(parseMachines(FLEET));
		const rows = [row("macbook", "a", { stale: true })];
		const calls = mockHub(rows, unreachableHub(rows, "macbook"));
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		await click(h.container.querySelector('button[aria-label^="Expand"]'));
		await settle(40);
		expect(text(h.container.querySelector("tr.std-detail") as Element)).toContain(
			subagentsUnavailable("Ada MacBook"),
		);
		expect(subagentsUnavailable("Ada MacBook")).toBe("Ada MacBook unreachable; subagents unavailable");
		expect(gets(calls, "/api/session/subagents")).toHaveLength(0);
		expect(h.container.querySelector("tr.std-detail .std-skeleton")).toBeNull();
	});

	it("held machine (ok, stale rows): last known, controls on, subagents asked without parentLive", async () => {
		setFleet(parseMachines(FLEET));
		const rows = [row("macbook", "a", { stale: true })];
		const calls = mockHub(rows, call =>
			call.url === "/api/hub/sessions"
				? json({
						sessions: rows,
						machines: [
							{ id: "server", name: "Ada Server", ok: true, stale: false },
							{ id: "macbook", name: "Ada MacBook", ok: true, stale: true, staleSince: Date.now() - 20_000 },
							{ id: "mini", name: "Ada Mac mini", ok: true, stale: false },
						],
						now: Date.now(),
					})
				: call.url.startsWith("/m/macbook/api/sessions?")
					? json([{ sessionId: "sess-a", file: "/x/a.jsonl" }])
					: undefined,
		);
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected="sess-a" onSelect={() => {}} />);
		await settle(40);
		expect(text(h.container)).toContain("Ada MacBook missed its last check (last answer");
		expect(text(h.container)).not.toContain("is unreachable");
		expect(h.container.querySelector('[data-state="last-known"]')).not.toBeNull();
		expect(h.container.querySelector('[data-state="unreachable"]')).toBeNull();
		// The drawer keeps its controls: Rename and Kill… are on, and the hub is asked what it can do.
		expect(text(h.body)).not.toContain("Ada MacBook is unreachable");
		expect(isDisabled(byText(h.body, "button", "Rename"))).toBe(false);
		expect(isDisabled(byText(h.body, "button", "Kill…"))).toBe(false);
		expect(gets(calls, "/m/macbook/api/hub/version")).toHaveLength(1);
		await click(h.container.querySelector('button[aria-label^="Expand"]'));
		await settle(40);
		expect(calls.some(c => c.url === "/m/macbook/api/session/subagents?file=%2Fx%2Fa.jsonl")).toBe(true);
		expect(text(h.container.querySelector("tr.std-detail") as Element)).not.toContain("subagents unavailable");
	});

	it("unreachable machine (ok:false): controls off", async () => {
		const rows = [row("macbook", "a", { stale: true })];
		const { h } = await openDrawer(rows, "sess-a", unreachableHub(rows, "macbook"));
		expect(text(h.body)).toContain("Ada MacBook is unreachable");
		expect(isDisabled(byText(h.body, "button", "Rename"))).toBe(true);
		expect(isDisabled(byText(h.body, "button", "Kill…"))).toBe(true);
	});

	it("machineDown and machineHeld follow the machine's ok, not the row's stale flag", () => {
		const held = [{ id: "m", name: "M", ok: true, stale: true }];
		const gone = [{ id: "m", name: "M", ok: false, stale: true }];
		const fresh = [{ id: "m", name: "M", ok: true, stale: false }];
		const stale = { instanceId: "i", machine: "m", stale: true };
		expect(machineDown(stale, held)).toBeNull();
		expect(machineHeld(stale, held)).toBe(true);
		expect(machineDown(stale, gone)).toEqual(gone[0]);
		expect(machineHeld(stale, gone)).toBe(false);
		expect(machineDown({ instanceId: "i", machine: "m" }, fresh)).toBeNull();
		expect(machineHeld({ instanceId: "i", machine: "m" }, fresh)).toBe(false);
		// An older hub without machine reports: stale rows still count as unreachable.
		expect(machineDown(stale, undefined)?.ok).toBe(false);
	});

	it("keeps each row's subagent request and error on its own machine when one machine fails (N2)", async () => {
		setFleet(parseMachines(FLEET));
		const NO_PROOF = "the stats port answered without the dashboard's proof; nothing was passed on";
		const server = row("server", "s", { startedAt: Date.now() - 1_000 });
		const macbook = row("macbook", "m", { startedAt: Date.now() - 2_000 });
		let polls = 0;
		const calls = mockHub([], call => {
			if (call.url === "/api/hub/sessions") {
				polls++;
				// Each refresh swaps the order, as a busy list does while the expander loads.
				return json({
					sessions: polls % 2 ? [server, macbook] : [macbook, server],
					machines: FLEET.map(m => ({ id: m.id, name: m.name, ok: true, stale: false })),
					now: Date.now(),
				});
			}
			if (call.url.startsWith("/m/server/api/")) return json({ error: NO_PROOF }, 502);
			if (call.url.startsWith("/m/macbook/api/sessions?"))
				return json([{ sessionId: "sess-m", file: "/mb/m.jsonl" }]);
			if (call.url.startsWith("/m/macbook/api/session/subagents"))
				return json([
					{
						id: "mb-child",
						agent: "task",
						title: "MacBook child",
						models: [],
						startedAt: Date.now() - 60_000,
						endedAt: Date.now(),
						durationMs: 60_000,
						costTotal: 0,
						requests: 1,
						status: "done",
						toolErrors: 0,
					},
				]);
			if (call.url.includes("/api/session") || call.url.startsWith("/api/sessions"))
				return json({ error: "unprefixed" }, 500);
			return undefined;
		});
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		const expand = (name: string) =>
			click(byText(h.container, "tbody tr", name)?.querySelector('button[aria-label^="Expand"]'));
		const detailOf = (name: string) => {
			const tr = byText(h.container, "tbody tr", name);
			const next = tr?.nextElementSibling;
			return next?.classList.contains("std-detail") ? text(next) : null;
		};
		// The server row fails, and says which machine failed.
		await expand("Session s");
		await settle(60);
		expect(detailOf("Session s")).toContain(
			"Could not list the subagents: Ada Server's stats server is a different version until it's updated.",
		);
		// The raw reason stays in the tooltip.
		expect(
			byText(h.container, "tbody tr", "Session s")?.nextElementSibling?.querySelector(`[title="${NO_PROOF}"]`),
		).not.toBeNull();
		// Then the MacBook row: its own list, never the server's error, through a refresh that reorders the rows.
		await expand("Session m");
		await settle(5_300);
		expect(detailOf("Session s")).toBeNull();
		expect(detailOf("Session m")).toContain("MacBook child");
		expect(detailOf("Session m")).not.toContain(NO_PROOF);
		expect(polls).toBeGreaterThan(1);
		const sub = calls.filter(c => c.url.includes("/api/session") || c.url.includes("/api/sessions?"));
		expect(sub.every(c => c.url.startsWith("/m/server/") || c.url.startsWith("/m/macbook/"))).toBe(true);
		expect(sub.some(c => c.url.startsWith("/m/macbook/api/session/subagents?file=%2Fmb%2Fm.jsonl"))).toBe(true);
	}, 15_000);

	it("words every kind of stats failure plainly, naming the machine and never the raw text", () => {
		const raws = [
			...KNOWN_STATS_REASONS.keys(),
			"too many dashboard tabs are streaming from Ada MacBook",
			"stats answered 404",
			"the machine answered 500",
			"connect ECONNREFUSED 127.0.0.1:3850",
			"the machine did not answer within 10 s.",
			"something nobody expected",
			"constructor",
		];
		const phrases = new Set<string>();
		for (const raw of raws) {
			const line = subagentsFailure("Ada MacBook", raw, true);
			expect(line).toBe(
				`Could not list the subagents: ${namedStatsReason("Ada MacBook", raw, { refreshing: true })}.`,
			);
			// Without a refresh of its own, nothing may promise a retry.
			expect(subagentsFailure("Ada MacBook", raw, false)).not.toContain("retrying");
			// Every line names its subject: never a bare "its" or "it".
			expect(line).not.toMatch(/: (its|it) /);
			// Technical sentences stay in the tooltip; single words like "busy" may read the same in plain words.
			if (raw.includes(" ")) expect(line).not.toContain(raw);
			expect(line).not.toMatch(/\.\.$|undefined/);
			phrases.add(plainStatsReason(raw, { refreshing: true }));
		}
		// One phrase per group: version, unexpected, clock, timeout, down, loading, busy, setup and unknown.
		expect(phrases.size).toBe(9);
		expect(plainStatsReason("bad fleet signature")).toBe(plainStatsReason("something nobody expected"));
	});

	it("says retrying only where the list asks again by itself", async () => {
		for (const [raw, plain] of [
			["request too old", "Ada MacBook's stats: clocks are out of sync or the hub restarted"],
			["busy", "Ada MacBook's stats are busy"],
		] as const) {
			expect(subagentsFailure("Ada MacBook", raw, false)).toBe(`Could not list the subagents: ${plain}.`);
			expect(subagentsFailure("Ada MacBook", raw, true)).toBe(`Could not list the subagents: ${plain}; retrying.`);
		}
		// The Sessions expander refreshes every 15 s, so it may say retrying.
		setFleet(parseMachines(FLEET));
		mockHub([row("mini", "b")], call => {
			if (call.url.startsWith("/m/mini/api/sessions?")) return json([{ sessionId: "sess-b", file: "/x/b.jsonl" }]);
			if (call.url.startsWith("/m/mini/api/session/subagents")) return json({ error: "request too old" }, 401);
			return undefined;
		});
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		await click(h.container.querySelector('button[aria-label^="Expand"]'));
		await settle(60);
		expect(text(h.container.querySelector("tr.std-detail") as Element)).toContain(
			"Could not list the subagents: Ada Mac mini's stats: clocks are out of sync or the hub restarted; retrying.",
		);
	});

	it("times a hanging subagent request out to an error with Try again", async () => {
		setFleet(parseMachines(FLEET));
		let answer = false;
		mockHub([row("mini", "b")], (call, init) => {
			if (call.url.startsWith("/m/mini/api/sessions?")) return json([{ sessionId: "sess-b", file: "/x/b.jsonl" }]);
			if (call.url.startsWith("/m/mini/api/session/subagents")) return answer ? json([]) : hang(init);
			return undefined;
		});
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		await click(h.container.querySelector('button[aria-label^="Expand"]'));
		await settle(10_300);
		const detail = () => text(h.container.querySelector("tr.std-detail") as Element);
		expect(detail()).toContain("Could not list the subagents: Ada Mac mini's stats didn't answer in time.");
		answer = true;
		await click(byText(h.container, "tr.std-detail button", "Try again"));
		await settle(60);
		expect(detail()).toContain("No subagents");
	}, 20_000);
});

describe("Terminal tab (N14)", () => {
	const tabs = (body: Element) => all(body, '[role="tab"]').map(t => text(t).replace("!", ""));

	it("keeps the Terminal tab when the terminal can't be read, and says why", async () => {
		const cases: [Record<string, unknown>, string][] = [
			[
				{ terminal: { available: false, waiting: null, unknown: false }, herdr: { workspace: "qa", tab: "omp" } },
				"Ada MacBook's hub hasn't matched this session to a herdr pane yet; it checks every 15 seconds.",
			],
			[
				{ terminal: { available: false, waiting: null, unknown: false }, herdr: null },
				"Ada MacBook's hub hasn't matched this session to a herdr pane yet; it checks every 15 seconds.",
			],
			[
				{ terminal: { available: false, waiting: null, unknown: true } },
				"Ada MacBook's hub can't tell which herdr pane runs this session right now",
			],
			[
				{ terminal: undefined },
				"Ada MacBook's hub doesn't report terminals; update the hub there to use this tab.",
			],
			// A hub that says why: its reason wins over the wording read from `unknown`.
			...(
				[
					[
						"not_scanned_yet",
						true,
						"Ada MacBook's hub hasn't listed herdr panes yet; it checks every 15 seconds.",
					],
					["scan_failed", true, "herdr on Ada MacBook didn't answer the hub's last check."],
					["scan_stale", true, "Ada MacBook's hub's last herdr check is over 45 seconds old."],
					["ambiguous_panes", true, "More than one herdr pane shows this session."],
					[
						"not_in_herdr",
						false,
						"Ada MacBook's hub hasn't matched this session to a herdr pane yet; it checks every 15 seconds.",
					],
				] as const
			).map(([reason, unknown, words]): [Record<string, unknown>, string] => [
				{ terminal: { available: false, waiting: null, unknown, reason } },
				words,
			]),
		];
		for (const [over, reason] of cases) {
			const { h } = await openDrawer([row("macbook", "a", over)], "sess-a");
			expect(tabs(h.body)).toEqual(["Session", "Terminal", "Instructions"]);
			await click(byText(h.body, '[role="tab"]', "Terminal"));
			expect(text(h.body)).toContain(reason);
			// Not listed by the last scan is never read as "not in herdr".
			expect(text(h.body)).not.toContain("isn't running in a herdr pane");
			await unmount();
			clearQueryCache();
		}
	});

	it("opens the terminal when the hub can read it", async () => {
		const { h } = await openDrawer(
			[row("macbook", "a", { terminal: { available: true, waiting: null, unknown: false } })],
			"sess-a",
		);
		expect(tabs(h.body)).toEqual(["Session", "Terminal", "Instructions"]);
		await click(byText(h.body, '[role="tab"]', "Terminal"));
		expect(text(h.body)).not.toContain("herdr pane");
		expect(text(h.body)).not.toContain("doesn't report terminals");
	});
});

describe("approve with notes", () => {
	const status = (over: Record<string, unknown>) => ({
		requestId: "plan-1",
		reviewId: "rev-1",
		choice: "execute" as const,
		approved: true,
		state: "pending" as const,
		at: "2026-11-18T00:00:00Z",
		...over,
	});

	it("reads each end state", () => {
		expect(statusOutcome(status({}))).toBeNull();
		expect(outcomeText(statusOutcome(status({ state: "sent" }))!)).toBe(
			"Plan approved; notes sent as the session's next message.",
		);
		expect(
			outcomeText(statusOutcome(status({ state: "failed", reason: "plan did not start within 5 minutes" }))!),
		).toBe("Plan approved; notes not sent: plan did not start within 5 minutes");
		expect(outcomeText(statusOutcome(status({ state: "uncertain" }))!)).toBe(
			"Plan approved; notes may not have been delivered; check the session",
		);
		expect(
			outcomeText(statusOutcome(status({ approved: false, state: "failed", reason: "another approval" }))!),
		).toBe("The plan was not approved: another approval");
	});

	it("polls the instance's own status route every 2 s, through a 404", async () => {
		const reads: string[] = [];
		const replies: (() => unknown)[] = [
			() => {
				throw new ApiError(404, "/x", "not found", "not_found");
			},
			() => status({}),
			() => status({ state: "sent" }),
		];
		const sleeps: number[] = [];
		const outcome = await pollPlanNotes({
			instanceId: "inst-a",
			requestId: "plan-1",
			machine: "mini",
			signal: new AbortController().signal,
			sleep: async ms => void sleeps.push(ms),
			read: async (instanceId, requestId, machine) => {
				reads.push(`${machine}:${instanceId}:${requestId}`);
				return replies.shift()!() as ReturnType<typeof status>;
			},
		});
		expect(outcome).toEqual({ state: "sent" });
		expect(reads).toEqual(["mini:inst-a:plan-1", "mini:inst-a:plan-1", "mini:inst-a:plan-1"]);
		expect(sleeps).toEqual([2000, 2000, 2000]);
	});

	it("stops waiting after the deadline, on an unexpected error, and when a read hangs", async () => {
		let t = 0;
		const base = { instanceId: "i", requestId: "p", machine: undefined, signal: new AbortController().signal };
		const late = await pollPlanNotes({
			...base,
			sleep: async ms => void (t += ms),
			now: () => t,
			read: async () => status({}),
		});
		expect(late.state).toBe("unknown");
		const broken = await pollPlanNotes({
			...base,
			sleep: async () => {},
			read: async () => {
				throw new ApiError(502, "/x", "socket", "socket");
			},
		});
		expect(broken.state).toBe("unknown");
		// a read that never settles and ignores its signal is still cut off by the per-read limit
		const started = Date.now();
		const hung = await pollPlanNotes({
			...base,
			sleep: async () => {},
			readMs: 20,
			read: () => new Promise(() => {}),
		});
		expect(hung.state).toBe("unknown");
		expect(Date.now() - started).toBeLessThan(500);
		// and by the overall deadline when it is closer
		const near = await pollPlanNotes({
			...base,
			sleep: async () => {},
			maxMs: 15,
			read: () => new Promise(() => {}),
		});
		expect(near.state).toBe("unknown");
	});

	it("posts to the instance on the row's machine and shows the outcome", async () => {
		installPlanWorker();
		const planned = {
			planControl: "supported",
			planReview: { reviewId: "rev-1", title: "Add retry", openedAt: new Date().toISOString() },
		};
		const { h, calls } = await openDrawer([row("mini", "a", planned)], "sess-a", call => {
			if (call.method === "POST" && call.url.endsWith("/plan-notes"))
				return json({ approved: true, requestId: call.body?.requestId, notes: "pending" }, 202);
			if (call.url.includes("/plan-notes?requestId="))
				return json(status({ requestId: "x", state: "failed", reason: "control disabled" }));
			return undefined;
		});
		await type(h.body.querySelector('textarea[id^="plan-notes-"]'), "also add tests");
		await click(byText(h.body, ".plan-box button", "Approve with changes"));
		await click(byText(h.body, "[role=dialog] button[data-variant=primary]", "Approve with changes"));
		await settle();
		const sent = posts(calls, "/plan-notes")[0];
		expect(sent.url).toBe("/m/mini/api/hub/instances/inst-a/plan-notes");
		expect(sent.body).toMatchObject({
			sessionId: "sess-a",
			reviewId: "rev-1",
			choice: "execute",
			notes: "also add tests",
		});
		expect(sent.body?.requestId).toMatch(/^plan-/);
		expect(text(h.body)).toContain("Plan approved; the notes go out once the plan has started");
		await settle(2200);
		expect(gets(calls, "/plan-notes?requestId=")[0].url).toBe(
			`/m/mini/api/hub/instances/inst-a/plan-notes?requestId=${sent.body?.requestId}`,
		);
		expect(text(h.body)).toContain("Plan approved; notes not sent: control disabled");
	});

	async function approveWithNotes(handle: Handler) {
		installPlanWorker();
		const planned = {
			planControl: "supported",
			planReview: { reviewId: "rev-1", title: "Add retry", openedAt: new Date().toISOString() },
		};
		const opened = await openDrawer([row("mini", "a", planned)], "sess-a", handle);
		await type(opened.h.body.querySelector('textarea[id^="plan-notes-"]'), "also add tests");
		await click(byText(opened.h.body, ".plan-box button", "Approve with changes"));
		await click(byText(opened.h.body, "[role=dialog] button[data-variant=primary]", "Approve with changes"));
		await settle();
		return opened;
	}

	it("keeps an uncertain request and checks it again, read-only, until it settles", async () => {
		let state = "uncertain";
		const { h, calls } = await approveWithNotes(call => {
			if (call.method === "POST" && call.url.endsWith("/plan-notes"))
				return json({ approved: true, requestId: call.body?.requestId, notes: "pending" }, 202);
			if (call.url.includes("/plan-notes?requestId=")) return json(status({ state }));
			return undefined;
		});
		await settle(2200);
		expect(text(h.body)).toContain("notes may not have been delivered");
		state = "sent";
		await click(byText(h.body, "button", "Check again"));
		await settle(2200);
		expect(text(h.body)).toContain("Plan approved; notes sent");
		expect(posts(calls, "/plan-notes")).toHaveLength(1);
		const reads = gets(calls, "/plan-notes?requestId=").map(c => c.url);
		expect(new Set(reads).size).toBe(1);
		expect(reads).toHaveLength(2);
	});

	it("stops on an unknown request, says it couldn't confirm, and keeps a read-only Check again", async () => {
		expect(statusOutcome({ requestId: "plan-1", state: "unknown" })).toEqual({ state: "unconfirmed" });
		let reply: Record<string, unknown> = { state: "unknown" };
		const { h, calls } = await approveWithNotes(call => {
			if (call.method === "POST" && call.url.endsWith("/plan-notes"))
				return json({ approved: true, requestId: call.body?.requestId, notes: "pending" }, 202);
			if (call.url.includes("/plan-notes?requestId="))
				return json({ requestId: new URL(call.url, "http://x").searchParams.get("requestId"), ...reply });
			return undefined;
		});
		await settle(2200);
		expect(text(h.body)).toContain(UNCONFIRMED_NOTES_TEXT);
		expect(text(h.body)).not.toContain("the notes go out once the plan has started");
		await settle(2200);
		// polling stopped at the unknown answer
		expect(gets(calls, "/plan-notes?requestId=")).toHaveLength(1);
		reply = status({ state: "sent" });
		await click(byText(h.body, "button", "Check again"));
		await settle(2200);
		expect(text(h.body)).toContain("Plan approved; notes sent");
		expect(posts(calls, "/plan-notes")).toHaveLength(1);
		expect(new Set(gets(calls, "/plan-notes?requestId=").map(c => c.url)).size).toBe(1);
	}, 15_000);

	it("follows a request_in_use refusal instead of showing an error", async () => {
		const { h, calls } = await approveWithNotes(call => {
			if (call.method === "POST" && call.url.endsWith("/plan-notes"))
				return json({ error: "already submitted", code: "request_in_use" }, 409);
			if (call.url.includes("/plan-notes?requestId=")) return json(status({ state: "sent" }));
			return undefined;
		});
		expect(text(h.body)).toContain("Plan approved; the notes go out once the plan has started");
		await settle(2200);
		const id = posts(calls, "/plan-notes")[0].body?.requestId;
		expect(gets(calls, "/plan-notes?requestId=")[0].url).toBe(
			`/m/mini/api/hub/instances/inst-a/plan-notes?requestId=${id}`,
		);
		expect(text(h.body)).toContain("Plan approved; notes sent");
	});

	it("starts no poll when the page goes away before the approval answers", async () => {
		let answer: (r: Response) => void = () => {};
		const { h, calls } = await approveWithNotes(call => {
			if (call.method === "POST" && call.url.endsWith("/plan-notes"))
				return new Promise<Response>(resolve => (answer = resolve));
			return undefined;
		});
		const id = posts(calls, "/plan-notes")[0].body?.requestId;
		await h.render(<div />);
		answer(json({ approved: true, requestId: id, notes: "pending" }, 202));
		await Bun.sleep(2300);
		expect(calls.filter(c => c.url.includes("/plan-notes?requestId="))).toHaveLength(0);
	});
});

describe("unconfirmed messages", () => {
	it("never sends again: Check again only reads message-status", async () => {
		let status = "unknown";
		const { h, calls } = await openDrawer([row("macbook", "a")], "sess-a", call => {
			if (call.url.endsWith("/message")) return json({ state: "pending" }, 202);
			if (call.url.includes("/message-status")) return json({ state: status });
			return undefined;
		});
		await type(h.body.querySelector('textarea[aria-label="Message"]'), "hello");
		await press(byText(h.body, "button", "Send"));
		await settle(2200);
		expect(text(h.body)).toContain("Not confirmed; check the session");
		expect(byText(h.body, "button", "Send it again")).toBeNull();
		status = "admitted";
		await click(byText(h.body, "button", "Check again"));
		await settle();
		expect(text(h.body)).toContain("Message delivered.");
		expect(posts(calls, "/message")).toHaveLength(1);
		const id = posts(calls, "/message")[0].body?.messageId as string;
		expect(gets(calls, "/message-status").every(c => c.url.endsWith(`messageId=${id}`))).toBe(true);
		expect(byText(h.body, "button", "Check again")).toBeNull();
	});
});

describe("Other… answers", () => {
	const radio: AskField = {
		name: "plan",
		type: "radio",
		label: "Which plan?",
		required: true,
		options: [{ value: "a", label: "A" }],
		default: null,
		multiple: false,
		allowOther: true,
	};
	const boxes: AskField = { ...radio, name: "also", label: "Also", type: "checkbox", required: false, multiple: true };

	it("validates the text once chosen and sends objects", () => {
		expect(answerProblems([radio], { plan: "" }, { plan: { on: true, text: " " } })).toEqual({
			plan: "Type your answer.",
		});
		expect(answerProblems([radio], { plan: "" }, { plan: { on: true, text: "x".repeat(2001) } })).toEqual({
			plan: "At most 2000 characters.",
		});
		expect(toAnswers([radio], { plan: "" }, { plan: { on: true, text: "  my way " } })).toEqual({
			plan: { other: "my way" },
		});
		expect(toAnswers([radio], { plan: "a" })).toEqual({ plan: { value: "a" } });
		expect(toAnswers([boxes], { also: ["a"] }, { also: { on: true, text: "more" } })).toEqual({
			also: { values: ["a"], other: "more" },
		});
		expect(toAnswers([boxes], { also: [] })).toEqual({});
		expect(parseAsk({ open: true, askId: "q", fields: [{ ...radio, allowOther: true }] })).toMatchObject({
			fields: [{ allowOther: true }],
		});
	});

	it("shows an Other… choice that reveals its text box, and answers with it", async () => {
		const { h, calls } = await openDrawer([row("mini", "a", { inputRequired: true })], "sess-a", call => {
			if (call.url.endsWith("/ask")) return json({ open: true, askId: "ask-9", fields: [radio, boxes] });
			if (call.url.endsWith("/ask-answer")) return json({ state: "admitted" });
			return undefined;
		});
		const form = () => h.body.querySelector(".sd-ask") as Element;
		expect(all(form(), ".sd-qopt").map(o => text(o))).toEqual(["A", "Other…", "A", "Other…"]);
		expect(form().querySelector('input[aria-label^="Your answer"]')).toBeNull();
		await click(all(form(), 'input[type="radio"]')[1]);
		await press(byText(form(), "button", "Send answer"));
		await settle();
		expect(text(form())).toContain("Type your answer.");
		expect(posts(calls, "/ask-answer")).toHaveLength(0);
		await type(form().querySelector('input[aria-label="Your answer for Which plan?"]'), "neither");
		await click(all(form(), 'input[type="checkbox"]')[1]);
		await type(form().querySelector('input[aria-label="Your answer for Also"]'), "docs too");
		await press(byText(form(), "button", "Send answer"));
		await settle();
		expect(posts(calls, "/ask-answer")[0].body?.answers).toEqual({
			plan: { other: "neither" },
			also: { values: [], other: "docs too" },
		});
	});
});

describe("Start form", () => {
	it("forgets the chosen parent when the target machine changes", async () => {
		setFleet(parseMachines(FLEET));
		selectMachine("macbook");
		mockHub([], call =>
			call.url.endsWith("/project-parents")
				? json({ roots: [call.url.startsWith("/m/macbook") ? "/macbook/projects" : "/mini/projects"], parents: [] })
				: call.url.endsWith("/projects")
					? json({ projects: [] })
					: undefined,
		);
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		await click(all(h.container, "button").find(b => text(b).includes("Start a session")));
		await settle();
		await click(byText(h.body, "button", "New folder"));
		await type(h.body.querySelector(".sd-start select"), "/macbook/projects");
		expect(valueOf(h.body.querySelector(".sd-start select"))).toBe("/macbook/projects");
		selectMachine("mini");
		await settle();
		expect(byText(h.body, "button", "Create and start")).toBeNull();
		await click(byText(h.body, "button", "New folder"));
		expect(valueOf(h.body.querySelector(".sd-start select"))).toBe("");
		expect(all(h.body, ".sd-start select option").map(o => text(o))).toEqual(["Choose a parent", "/mini/projects"]);
		expect(isDisabled(byText(h.body, "button", "Create and start"))).toBe(true);
	});
});
