import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ApiError } from "../src/client/api";
import {
	getSessionInfo,
	getSessionScreen,
	type HubScreen,
	type HubSession,
	type HubSessionInfo,
	sendSessionCommand,
	sendSessionKeys,
} from "../src/client/data/hub";
import { clearQueryCache } from "../src/client/data/query-store";
import { RESTART_FOR_PLAN, RESTART_FOR_PLAN_OR_TERMINAL, needsYou } from "../src/client/data/plan-review";
import {
	commandConfirm,
	commandErrorMessage,
	compactCommand,
	instructionsProblem,
	modeCommand,
	objectiveProblem,
	parseSessionInfo,
	RESTART_FOR_COMMANDS,
} from "../src/client/data/session-commands";
import {
	createScreenPoller,
	KEYS,
	keysProblem,
	TEXT_WARNING,
	terminalErrorMessage,
	textProblem,
	UNCERTAIN_MESSAGE,
} from "../src/client/data/terminal";
import { SessionCommandsPanel } from "../src/client/routes/SessionCommandsPanel";
import { SessionsRoute } from "../src/client/routes/SessionsRoute";
import { TerminalPanel } from "../src/client/routes/TerminalPanel";
import { act } from "react";
import { all, byText, click, isDisabled, mount, settle, text, type, unmount, valueOf } from "./helpers/memory-dom";

beforeEach(clearQueryCache);

afterEach(async () => {
	clearQueryCache();
	await unmount();
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const INFO: HubSessionInfo = {
	model: { provider: "anthropic", id: "claude-opus" },
	thinkingLevel: "medium",
	thinkingLevels: ["low", "medium", "high"],
	models: [
		{ provider: "anthropic", id: "claude-opus", name: "Opus" },
		{ provider: "anthropic", id: "claude-haiku" },
	],
	mode: { plan: false, goal: false, loop: false, vibe: false },
};

const SCREEN: HubScreen = {
	pane: "p1",
	rows: ["Exit plan mode?", "  1. Yes", "  2. No"],
	scrolled: false,
	revision: 1,
	capturedAt: 1_795_000_000_000,
};

function session(over: Partial<HubSession> = {}): HubSession {
	return {
		instanceId: "inst-1",
		sessionId: "sess-1",
		cwd: "/Users/me/projects/app",
		sessionName: "Work",
		busy: false,
		terminal: { available: true, waiting: null, unknown: false },
		...over,
	};
}

interface Call {
	url: string;
	method: string;
	body: Record<string, unknown> | null;
	headers: Record<string, string>;
}

interface Handlers {
	info?: (url: string) => Response | Promise<Response>;
	command?: (body: Record<string, unknown>) => Response | Promise<Response>;
	screen?: () => Response | Promise<Response>;
	keys?: (body: Record<string, unknown>) => Response | Promise<Response>;
	sessions?: () => Response;
}

function mockHub(h: Handlers = {}) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		calls.push({
			url,
			method: init?.method ?? "GET",
			body,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		if (url.endsWith("/session-info")) return h.info?.(url) ?? json(INFO);
		if (url.endsWith("/command")) return h.command?.(body ?? {}) ?? json({ outcome: "ok", result: {} });
		if (url.endsWith("/screen")) return h.screen?.() ?? json(SCREEN);
		if (url.endsWith("/keys")) return h.keys?.(body ?? {}) ?? json({ outcome: "sent" });
		if (url.endsWith("/plan-review")) return json({ open: false });
		if (url === "/api/hub/sessions") return h.sessions?.() ?? json({ sessions: [], now: Date.now() });
		if (url === "/api/hub/quota")
			return json({
				generatedAt: null,
				cacheAgeMs: null,
				cacheStale: false,
				source: "",
				providers: {},
				accounts: [],
			});
		return json({ projects: [] });
	}) as typeof fetch);
	return calls;
}

const urlEnds = (calls: Call[], end: string) => calls.filter(c => c.url.endsWith(end));

describe("request shapes", () => {
	it("reads session info and the screen with GET", async () => {
		const calls = mockHub();
		await getSessionInfo("a/b");
		await getSessionScreen("a/b");
		expect(calls[0]).toMatchObject({ url: "/api/hub/sessions/a%2Fb/session-info", method: "GET" });
		expect(calls[1]).toMatchObject({ url: "/api/hub/sessions/a%2Fb/screen", method: "GET" });
	});

	it("posts commands as {op, args} with the hub's header", async () => {
		const calls = mockHub();
		await sendSessionCommand("s", { op: "set-model", args: { provider: "anthropic", id: "claude-haiku" } });
		await sendSessionCommand("s", { op: "set-mode", args: { mode: "goal", action: "enter", objective: "ship" } });
		expect(calls[0]).toMatchObject({
			url: "/api/hub/sessions/s/command",
			method: "POST",
			body: { op: "set-model", args: { provider: "anthropic", id: "claude-haiku" } },
		});
		expect(calls[0].headers["X-Omp-Hub"]).toBe("1");
		expect(calls[1].body).toEqual({ op: "set-mode", args: { mode: "goal", action: "enter", objective: "ship" } });
	});

	it("posts keys with a request id, and sends text only when there is some", async () => {
		const calls = mockHub();
		await sendSessionKeys("s", { requestId: "r1", keys: ["down", "enter"] });
		await sendSessionKeys("s", { requestId: "r2", keys: [], text: "2" });
		expect(calls[0]).toMatchObject({
			url: "/api/hub/sessions/s/keys",
			method: "POST",
			body: { requestId: "r1", keys: ["down", "enter"] },
		});
		expect(calls[0].body).not.toHaveProperty("text");
		expect(calls[0].headers["X-Omp-Hub"]).toBe("1");
		expect(calls[1].body).toEqual({ requestId: "r2", keys: [], text: "2" });
	});
});

describe("command rules", () => {
	it("limits instructions and objectives in UTF-16 units", () => {
		expect(instructionsProblem("x".repeat(2000))).toBeNull();
		expect(instructionsProblem("x".repeat(2001))).not.toBeNull();
		expect(instructionsProblem("😀".repeat(1000))).toBeNull();
		expect(instructionsProblem("😀".repeat(1001))).not.toBeNull();
		expect(objectiveProblem("  ")).not.toBeNull();
		expect(objectiveProblem("ship it")).toBeNull();
		expect(objectiveProblem("😀".repeat(1001))).not.toBeNull();
	});

	it("builds the commands and words each confirmation", () => {
		expect(compactCommand("  ")).toEqual({ op: "compact", args: {} });
		expect(compactCommand(" keep the API ")).toEqual({ op: "compact", args: { instructions: "keep the API" } });
		expect(modeCommand("plan", "exit")).toEqual({ op: "set-mode", args: { mode: "plan", action: "exit" } });
		expect(modeCommand("goal", "enter", " x ")).toEqual({
			op: "set-mode",
			args: { mode: "goal", action: "enter", objective: "x" },
		});
		expect(commandConfirm(modeCommand("goal", "drop")).question).toContain("Drop the current goal");
		expect(commandConfirm({ op: "set-model", args: { provider: "p", id: "m" } }).question).toContain("p/m");
	});

	it("gives each error code its own message", () => {
		const message = (code: string) => commandErrorMessage(new ApiError(409, "/e", "raw", code));
		const known = ["restart_needed", "changed", "stale_session", "invalid", "socket", "unsupported", "busy"].map(
			message,
		);
		expect(new Set(known).size).toBe(7);
		expect(known).not.toContain("raw");
		expect(message("restart_needed")).toBe(RESTART_FOR_COMMANDS);
		expect(message("failed")).toBe("raw");
		expect(message("busy")).toBe("Another change is still running in this session.");
		expect(commandErrorMessage(new ApiError(500, "/e", "plain", null))).toBe("plain");
	});

	it("ignores a session-info reply that is not the expected shape", () => {
		expect(parseSessionInfo({ projects: [] })).toBeNull();
		expect(parseSessionInfo(INFO)).toMatchObject({ thinkingLevel: "medium" });
	});
});

describe("terminal rules", () => {
	it("has exactly the nine keys", () => {
		expect(KEYS.map(k => k.key)).toEqual([
			"up",
			"down",
			"left",
			"right",
			"enter",
			"esc",
			"tab",
			"backspace",
			"space",
		]);
		expect(keysProblem(["up", "enter"])).toBeNull();
		expect(keysProblem(["up", "up", "up", "up", "up", "up"])).not.toBeNull();
		expect(keysProblem(["pageup"])).not.toBeNull();
	});

	it("accepts one printable line of at most 2000 UTF-16 units", () => {
		expect(textProblem("2")).toBeNull();
		expect(textProblem("hello world 😀 é")).toBeNull();
		expect(textProblem("")).not.toBeNull();
		expect(textProblem("x".repeat(2000))).toBeNull();
		expect(textProblem("x".repeat(2001))).not.toBeNull();
		expect(textProblem("😀".repeat(1000))).toBeNull();
		expect(textProblem("😀".repeat(1001))).not.toBeNull();
		// boundary fixtures shared with the hub's printable_line (omp_hub/terminal.py): Cc, Cs, Zl, Zp and Cn are refused
		for (const ok of ["a\u00a0b", "a\u200bb", "a\ue000b", "a\u{1f600}b", "a\u3000b", "a\u2060b"]) {
			expect(textProblem(ok)).toBeNull();
		}
		for (const bad of [
			"\u0378",
			"a\u0378b",
			"\u{10ffff}",
			"\u{e0080}",
			"a\u0080b",
			"a\u009fb",
			"a\u2029",
			"a\nb",
			"a\rb",
			"a\tb",
			"a\u0000b",
			"a\u001bb",
			"a\u007fb",
			"a\u0085b",
			"a\u2028b",
			"a\ud800b",
			"a\udc00b",
		]) {
			expect(textProblem(bad)).not.toBeNull();
		}
	});

	it("gives each error code its own message", () => {
		const codes = ["busy", "no_terminal", "ambiguous", "changed", "uncertain", "herdr"];
		const messages = codes.map(code => terminalErrorMessage(new ApiError(409, "/e", "raw", code)));
		expect(new Set(messages).size).toBe(6);
		expect(messages).not.toContain("raw");
		expect(messages[4]).toContain("Delivery uncertain, check the screen before sending again");
		expect(terminalErrorMessage(new ApiError(400, "/e", "Bad text", "invalid"))).toBe("Bad text");
	});
});

describe("screen poller", () => {
	const gap = (ms: number) => Bun.sleep(ms);
	const screen = (n: number): HubScreen => ({ ...SCREEN, revision: n });

	it("waits after each read finishes, never overlapping reads", async () => {
		let inflight = 0;
		let max = 0;
		let reads = 0;
		const seen: (number | null)[] = [];
		const poller = createScreenPoller({
			delayMs: 30,
			load: async () => {
				inflight++;
				max = Math.max(max, inflight);
				reads++;
				await gap(40);
				inflight--;
				return screen(reads);
			},
			onScreen: s => seen.push(s.revision),
			onError: () => {},
		});
		poller.refresh();
		await gap(60);
		expect(reads).toBe(1);
		await gap(80);
		poller.stop();
		expect(max).toBe(1);
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(seen[0]).toBe(1);
	});

	it("coalesces refreshes asked for during a read into one follow-up read", async () => {
		const pending: ((s: HubScreen) => void)[] = [];
		const seen: (number | null)[] = [];
		const poller = createScreenPoller({
			delayMs: 1000,
			load: () => new Promise<HubScreen>(resolve => pending.push(resolve)),
			onScreen: s => seen.push(s.revision),
			onError: () => {},
		});
		poller.refresh();
		poller.refresh();
		poller.refresh();
		expect(pending).toHaveLength(1);
		pending[0](screen(1));
		await gap(5);
		// exactly one more read, started only after the first finished
		expect(pending).toHaveLength(2);
		pending[1](screen(2));
		await gap(5);
		expect(pending).toHaveLength(2);
		poller.stop();
		expect(seen).toEqual([1, 2]);
	});

	it("drops a response that arrives after stop, and a failure stops it for good", async () => {
		let release: (s: HubScreen) => void = () => {};
		const seen: unknown[] = [];
		const a = createScreenPoller({
			load: () => new Promise<HubScreen>(resolve => (release = resolve)),
			onScreen: s => seen.push(s),
			onError: () => seen.push("error"),
		});
		a.refresh();
		a.stop();
		release(screen(1));
		await gap(5);
		expect(seen).toEqual([]);

		let loads = 0;
		const errors: unknown[] = [];
		const b = createScreenPoller({
			delayMs: 5,
			load: async () => {
				loads++;
				throw new ApiError(409, "/e", "x", "changed");
			},
			onScreen: () => {},
			onError: e => errors.push(e),
		});
		b.refresh();
		await gap(40);
		expect(loads).toBe(1);
		expect(errors).toHaveLength(1);
	});

	it("pauses while hidden and resumes when shown", async () => {
		let hidden = true;
		let reads = 0;
		const poller = createScreenPoller({
			delayMs: 10,
			isHidden: () => hidden,
			load: async () => {
				reads++;
				return screen(reads);
			},
			onScreen: () => {},
			onError: () => {},
		});
		poller.refresh();
		await gap(50);
		expect(reads).toBe(0);
		hidden = false;
		poller.resume();
		await gap(50);
		expect(reads).toBeGreaterThanOrEqual(2);
		hidden = true;
		await gap(40);
		const settled = reads;
		await gap(60);
		expect(reads).toBe(settled);
		poller.stop();
	});
});

const toggle = (h: ReturnType<typeof mount>) => h.container.querySelector(".term-toggle");

async function unlock(h: ReturnType<typeof mount>) {
	await click(toggle(h));
	await settle();
}

const keyButton = (h: ReturnType<typeof mount>, aria: string) =>
	all(h.container, ".term-keys button").find(b => b.getAttribute("aria-label") === aria) as Element;

describe("terminal panel", () => {
	it("is locked until the toggle is on: no screen reads, no key pad, no text field", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={20} />);
		await settle(60);
		expect(urlEnds(calls, "/screen")).toHaveLength(0);
		expect(h.container.querySelector(".term-keys")).toBeNull();
		expect(h.container.querySelector(".term-screen")).toBeNull();
		expect(text(h.container)).toContain("Locked");
	});

	it("shows the screen rows as monospace text, polls, and warns about typed text and a scrolled view", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={20} />);
		await unlock(h);
		const screen = h.container.querySelector(".term-screen");
		expect(screen?.textContent).toBe("Exit plan mode?\n  1. Yes\n  2. No");
		expect(text(h.container)).toContain(TEXT_WARNING);
		expect(text(h.container)).not.toContain("scrolled back");
		await settle(120);
		expect(urlEnds(calls, "/screen").length).toBeGreaterThanOrEqual(2);
		await unmount();

		mockHub({ screen: () => json({ ...SCREEN, scrolled: true }) });
		const h2 = mount();
		await h2.render(<TerminalPanel session={session()} pollMs={20} />);
		await unlock(h2);
		expect(text(h2.container)).toContain("scrolled back");
	});

	it("renders screen text as text, not markup", async () => {
		mockHub({ screen: () => json({ ...SCREEN, rows: ["<b>bold</b>"] }) });
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={20} />);
		await unlock(h);
		expect(h.container.querySelector(".term-screen")?.textContent).toBe("<b>bold</b>");
		expect(h.container.querySelector(".term-screen b")).toBeNull();
	});

	it("has the nine keys and sends each as its own request with a fresh id", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		const buttons = all(h.container, ".term-keys button");
		expect(buttons.map(b => b.getAttribute("aria-label"))).toEqual([
			"Up",
			"Down",
			"Left",
			"Right",
			"Enter",
			"Esc",
			"Tab",
			"Backspace",
			"Space",
		]);
		await click(keyButton(h, "Down"));
		await settle();
		await click(keyButton(h, "Enter"));
		await settle();
		const sent = urlEnds(calls, "/keys");
		expect(sent.map(c => c.body?.keys)).toEqual([["down"], ["enter"]]);
		expect(sent.every(c => c.method === "POST")).toBe(true);
		const ids = sent.map(c => c.body?.requestId as string);
		expect(ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 64)).toBe(true);
		expect(new Set(ids).size).toBe(2);
		expect(sent[0].body).not.toHaveProperty("text");
		// still unlocked after success
		expect(h.container.querySelector(".term-keys")).not.toBeNull();
	});

	it("sends one line of text, then clears it; invalid text can't be sent", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		const input = h.container.querySelector("input[type=text]");
		const sendButton = () => byText(h.container, "button", "Send text");
		expect(isDisabled(sendButton())).toBe(true);
		await type(input, "bad\nline");
		expect(isDisabled(sendButton())).toBe(true);
		expect(text(h.container)).toContain("one line of printable text");
		await type(input, "x".repeat(2001));
		expect(isDisabled(sendButton())).toBe(true);
		await type(input, "2");
		expect(isDisabled(sendButton())).toBe(false);
		await click(sendButton());
		await settle();
		const sent = urlEnds(calls, "/keys");
		expect(sent).toHaveLength(1);
		expect(sent[0].body).toMatchObject({ keys: [], text: "2" });
		expect(valueOf(input)).toBe("");
	});

	it("allows one send in flight: other buttons are off and a second tap sends nothing", async () => {
		let release: (r: Response) => void = () => {};
		const calls = mockHub({ keys: () => new Promise<Response>(resolve => (release = resolve)) });
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		const enter = keyButton(h, "Enter");
		await click(enter);
		await click(enter);
		await click(keyButton(h, "Esc"));
		expect(urlEnds(calls, "/keys")).toHaveLength(1);
		expect(all(h.container, ".term-keys button").every(b => isDisabled(b))).toBe(true);
		release(json({ outcome: "sent" }));
		await settle();
		expect(all(h.container, ".term-keys button").every(b => !isDisabled(b))).toBe(true);
		await click(keyButton(h, "Esc"));
		await settle();
		expect(urlEnds(calls, "/keys")).toHaveLength(2);
	});

	for (const [code, status, expected] of [
		["busy", 409, "Another send is still in progress"],
		["no_terminal", 409, "no terminal the hub can read"],
		["ambiguous", 409, "can't tell which terminal"],
		["changed", 409, "The terminal changed"],
		["uncertain", 502, UNCERTAIN_MESSAGE],
		["herdr", 502, "could not reach herdr"],
	] as const) {
		it(`locks again and says so on a ${code} reply, without retrying`, async () => {
			const calls = mockHub({ keys: () => json({ error: "raw server text", code }, status) });
			const h = mount();
			await h.render(<TerminalPanel session={session()} pollMs={500} />);
			await unlock(h);
			await click(keyButton(h, "Enter"));
			await settle(60);
			expect(text(h.container)).toContain(expected);
			expect(text(h.container)).not.toContain("raw server text");
			expect(h.container.querySelector(".term-keys")).toBeNull();
			expect(toggle(h)?.getAttribute("aria-checked")).toBe("false");
			expect(urlEnds(calls, "/keys")).toHaveLength(1);
		});
	}

	it("locks again when a screen read fails", async () => {
		mockHub({ screen: () => json({ error: "x", code: "no_terminal" }, 409) });
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={20} />);
		await unlock(h);
		await settle(40);
		expect(h.container.querySelector(".term-keys")).toBeNull();
		expect(text(h.container)).toContain("no terminal the hub can read");
	});

	it("locks again when the session changes, and when the page is no longer active", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		expect(h.container.querySelector(".term-keys")).not.toBeNull();
		await h.render(<TerminalPanel session={session({ sessionId: "sess-2", instanceId: "inst-2" })} pollMs={500} />);
		await settle();
		expect(h.container.querySelector(".term-keys")).toBeNull();
		const reads = urlEnds(calls, "/screen").length;
		await settle(80);
		expect(urlEnds(calls, "/screen").length).toBe(reads);

		await unlock(h);
		expect(h.container.querySelector(".term-keys")).not.toBeNull();
		await h.render(
			<TerminalPanel session={session({ sessionId: "sess-2", instanceId: "inst-2" })} active={false} pollMs={500} />,
		);
		await settle();
		expect(h.container.querySelector(".term-keys")).toBeNull();
	});

	it("stops polling when the tab is hidden and continues when it is shown", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={20} />);
		await unlock(h);
		const doc = globalThis.document as unknown as { hidden: boolean; dispatchEvent: (e: unknown) => void };
		Object.defineProperty(doc, "hidden", { configurable: true, value: true });
		await settle(80);
		const frozen = urlEnds(calls, "/screen").length;
		await settle(120);
		expect(urlEnds(calls, "/screen").length).toBe(frozen);
		Object.defineProperty(doc, "hidden", { configurable: true, value: false });
		const Event = (globalThis.window as unknown as { Event: typeof globalThis.Event }).Event;
		doc.dispatchEvent(new Event("visibilitychange"));
		await settle(80);
		expect(urlEnds(calls, "/screen").length).toBeGreaterThan(frozen);
		Reflect.deleteProperty(doc, "hidden");
	});
});

describe("session commands panel", () => {
	const confirmPrimary = async (h: ReturnType<typeof mount>) => {
		const dialog = h.body.querySelector("[role=dialog]");
		expect(dialog).not.toBeNull();
		await click((dialog as Element).querySelector("button[data-variant=primary]"));
		await settle();
	};

	it("shows an off advisor and confirms turning it on", async () => {
		const calls = mockHub({ info: () => json({ ...INFO, advisor: { enabled: false, active: false, model: null, advisors: [] } }) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("Off");
		expect(isDisabled(h.container.querySelector("#cmd-advisor-model-inst-1"))).toBe(true);
		await click(byText(h.container, "button", "Turn advisor on"));
		expect(text(h.body.querySelector("[role=dialog]") as Element)).toContain("extra requests");
		await confirmPrimary(h);
		expect(urlEnds(calls, "/command").at(-1)?.body).toEqual({ op: "set-advisor", args: { enabled: true } });
	});

	it("confirms an advisor model change", async () => {
		const calls = mockHub({ info: () => json({ ...INFO, advisor: { enabled: true, active: true, model: INFO.model, advisors: [{ name: "default", status: "quota_exhausted" }] } }) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("On · anthropic/claude-opus · default quota exhausted");
		await type(h.container.querySelector("#cmd-advisor-model-inst-1"), "anthropic/claude-haiku");
		await confirmPrimary(h);
		expect(urlEnds(calls, "/command").at(-1)?.body).toEqual({ op: "set-advisor", args: { provider: "anthropic", id: "claude-haiku" } });
	});

	it("explains when advisor control is unavailable", async () => {
		mockHub();
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("Advisor control needs the updated omp, session plugin and hub");
	});

	it("loads the session's settings into the selects and shows the modes", async () => {
		const calls = mockHub({ info: () => json({ ...INFO, mode: { ...INFO.mode, plan: true } }) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(urlEnds(calls, "/session-info")).toHaveLength(1);
		const selects = all(h.container, "select");
		expect(valueOf(selects[0])).toBe("anthropic/claude-opus");
		expect(valueOf(selects[1])).toBe("medium");
		expect(all(h.container, "select option").map(o => o.textContent)).toContain("Opus (anthropic/claude-opus)");
		expect(text(h.container)).toContain("Plan mode On");
		expect(byText(h.container, "button", "Exit plan mode")).not.toBeNull();
	});

	it("asks before changing the model, and Cancel sends nothing", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		await type(all(h.container, "select")[0], "anthropic/claude-haiku");
		const dialog = h.body.querySelector("[role=dialog]") as Element;
		expect(text(dialog)).toContain("Switch this session to anthropic/claude-haiku?");
		await click(byText(dialog, "button", "Cancel"));
		expect(urlEnds(calls, "/command")).toHaveLength(0);
	});

	it("sends model, thinking, mode and compact commands after confirming, then refetches", async () => {
		const calls = mockHub();
		let changed = 0;
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => changed++} />);
		await settle();

		await type(all(h.container, "select")[0], "anthropic/claude-haiku");
		await confirmPrimary(h);
		await type(all(h.container, "select")[1], "high");
		await confirmPrimary(h);
		await click(byText(h.container, "button", "Enter plan mode"));
		await confirmPrimary(h);
		await type(h.container.querySelector("textarea[id^=cmd-goal]"), "ship the retry work");
		await click(byText(h.container, "button", "Enter goal"));
		await confirmPrimary(h);
		await type(h.container.querySelector("textarea[id^=cmd-compact]"), "keep the API names");
		await click(byText(h.container, "button", "Compact"));
		await confirmPrimary(h);

		const sent = urlEnds(calls, "/command").map(c => c.body);
		expect(sent).toEqual([
			{ op: "set-model", args: { provider: "anthropic", id: "claude-haiku" } },
			{ op: "set-thinking", args: { level: "high" } },
			{ op: "set-mode", args: { mode: "plan", action: "enter" } },
			{ op: "set-mode", args: { mode: "goal", action: "enter", objective: "ship the retry work" } },
			{ op: "compact", args: { instructions: "keep the API names" } },
		]);
		expect(changed).toBe(5);
		expect(urlEnds(calls, "/session-info")).toHaveLength(6);
		expect(text(h.container)).toContain("Compacted.");
	});

	it("offers goal controls by modeStatus, and exit only for an active loop", async () => {
		const status = (goal: string, loop: string) => ({
			...INFO,
			mode: { plan: false, goal: goal !== "inactive", loop: loop !== "inactive", vibe: false },
			modeStatus: { plan: "inactive", vibe: "inactive", goal, loop },
		});
		const buttons = (h: ReturnType<typeof mount>) => all(h.container, ".hub-actions button").map(b => b.textContent);
		let current = status("inactive", "inactive");
		let calls = mockHub({ info: () => json(current) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(buttons(h)).toContain("Enter goal");
		for (const gone of ["Pause goal", "Resume goal", "Drop goal", "Exit loop"])
			expect(buttons(h)).not.toContain(gone);
		expect(h.container.querySelector("textarea[id^=cmd-goal]")).not.toBeNull();
		await unmount();

		current = status("active", "active");
		calls = mockHub({ info: () => json(current) });
		const h2 = mount();
		await h2.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(buttons(h2)).toEqual(expect.arrayContaining(["Pause goal", "Drop goal", "Exit loop"]));
		expect(buttons(h2)).not.toContain("Resume goal");
		expect(buttons(h2)).not.toContain("Enter goal");
		expect(h2.container.querySelector("textarea[id^=cmd-goal]")).toBeNull();
		await click(byText(h2.container, "button", "Exit loop"));
		await confirmPrimary(h2);
		expect(urlEnds(calls, "/command").at(-1)?.body).toEqual({
			op: "set-mode",
			args: { mode: "loop", action: "exit" },
		});
		await unmount();

		current = status("paused", "inactive");
		calls = mockHub({ info: () => json(current) });
		const h3 = mount();
		await h3.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(buttons(h3)).toEqual(expect.arrayContaining(["Resume goal", "Drop goal"]));
		expect(buttons(h3)).not.toContain("Pause goal");
		expect(buttons(h3)).not.toContain("Exit loop");
		await click(byText(h3.container, "button", "Resume goal"));
		await confirmPrimary(h3);
		expect(urlEnds(calls, "/command").at(-1)?.body).toEqual({
			op: "set-mode",
			args: { mode: "goal", action: "resume" },
		});
	});

	it("hides the thinking select and says so when the model has no levels", async () => {
		mockHub({ info: () => json({ ...INFO, thinkingLevel: null, thinkingLevels: [] }) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(all(h.container, "select")).toHaveLength(1);
		expect(text(h.container)).toContain("This model has no thinking levels");
	});

	it("keeps the card busy while a compaction is pending and polls session-info until it ends", async () => {
		let compacting = false;
		const calls = mockHub({
			command: () => json({ outcome: "pending" }, 202),
			info: () => json({ ...INFO, compacting }),
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} compactPollMs={30} />);
		await settle();
		await click(byText(h.container, "button", "Compact"));
		compacting = true; // the session has started compacting once the request is accepted
		await confirmPrimary(h);
		expect(text(h.container)).toContain("Compacting… this can take a few minutes");
		expect(isDisabled(byText(h.container, "button", "Enter plan mode"))).toBe(true);
		const reads = () => urlEnds(calls, "/session-info").length;
		const before = reads();
		await settle(120);
		expect(reads()).toBeGreaterThan(before + 1);
		expect(text(h.container)).toContain("Compacting…");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(true);
		compacting = false;
		await settle(120);
		expect(text(h.container)).not.toContain("Compacting…");
		expect(text(h.container)).toContain("Compacted.");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
		const done = reads();
		await settle(120);
		expect(reads()).toBe(done);
	});

	it("does not finish or unlock on a poll while the compact request is still outstanding", async () => {
		let release: (r: Response) => void = () => {};
		const calls = mockHub({
			command: () => new Promise<Response>(resolve => (release = resolve)),
			info: () => json({ ...INFO, compacting: false }),
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} compactPollMs={20} />);
		await settle();
		await click(byText(h.container, "button", "Compact"));
		await confirmPrimary(h);
		const before = urlEnds(calls, "/session-info").length;
		await settle(120);
		// no completion polling happens before the request settles
		expect(urlEnds(calls, "/session-info").length).toBe(before);
		expect(text(h.container)).toContain("Compacting…");
		expect(text(h.container)).not.toContain("Compacted.");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(true);
		await click(byText(h.container, "button", "Enter plan mode"));
		expect(h.body.querySelector("[role=dialog]")).toBeNull();
		expect(urlEnds(calls, "/command")).toHaveLength(1);
		release(json({ outcome: "ok", result: {} }));
		await settle();
		expect(text(h.container)).toContain("Compacted.");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
	});

	it("a 202 that arrives after a poll-looking quiet period starts completion polling only then", async () => {
		let release: (r: Response) => void = () => {};
		let compacting = false;
		const calls = mockHub({
			command: () => new Promise<Response>(resolve => (release = resolve)),
			info: () => json({ ...INFO, compacting }),
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} compactPollMs={20} />);
		await settle();
		await click(byText(h.container, "button", "Compact"));
		compacting = true; // the session has started compacting once the request is accepted
		await confirmPrimary(h);
		await settle(80);
		release(json({ outcome: "pending" }, 202));
		await settle(60);
		expect(text(h.container)).toContain("Compacting…");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(true);
		const during = urlEnds(calls, "/session-info").length;
		await settle(80);
		expect(urlEnds(calls, "/session-info").length).toBeGreaterThan(during);
		compacting = false;
		await settle(80);
		expect(text(h.container)).toContain("Compacted.");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
	});

	it("opened during a compaction: shows it, stays busy, polls until it clears, and never compacts again", async () => {
		let compacting = true;
		const calls = mockHub({ info: () => json({ ...INFO, compacting }) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} compactPollMs={20} />);
		await settle(60);
		expect(text(h.container)).toContain("Compacting… this can take a few minutes");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(true);
		expect(isDisabled(byText(h.container, "button", "Enter plan mode"))).toBe(true);
		const first = urlEnds(calls, "/session-info").length;
		await settle(100);
		expect(urlEnds(calls, "/session-info").length).toBeGreaterThan(first);
		expect(text(h.container)).toContain("Compacting…");
		compacting = false;
		await settle(80);
		expect(text(h.container)).not.toContain("Compacting…");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
		expect(urlEnds(calls, "/command")).toHaveLength(0);
	});

	it("times out after the poll budget and only Check again resumes polling, even across a reopen", async () => {
		const sid = { sessionId: "sess-timeout", instanceId: "inst-timeout" };
		const calls = mockHub({
			// a slow reconciliation read: still compacting
			info: async () => {
				await Bun.sleep(5);
				return json({ ...INFO, compacting: true });
			},
		});
		const reads = () => urlEnds(calls, "/session-info").length;
		const h = mount();
		await h.render(
			<SessionCommandsPanel session={session(sid)} onChanged={() => {}} compactPollMs={15} maxPolls={3} />,
		);
		await settle(40);
		expect(text(h.container)).toContain("Compacting…");
		await settle(200);
		expect(text(h.container)).toContain("Compaction is taking longer than expected");
		expect(text(h.container)).not.toContain("Compacting…");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(true);
		// the late reconciliation answered compacting=true: no more polls happen on their own
		await settle(60);
		const frozen = reads();
		await settle(150);
		expect(reads()).toBe(frozen);
		expect(byText(h.container, "button", "Check again")).not.toBeNull();

		// leaving and reopening the card does not rearm it either
		await h.render(<div />);
		await h.render(
			<SessionCommandsPanel session={session(sid)} onChanged={() => {}} compactPollMs={15} maxPolls={3} />,
		);
		await settle(60);
		expect(text(h.container)).toContain("Compaction is taking longer than expected");
		const reopened = reads();
		await settle(150);
		expect(reads()).toBe(reopened);

		// Check again gives one new bounded budget
		await click(byText(h.container, "button", "Check again"));
		await settle(15);
		expect(text(h.container)).toContain("Compacting…");
		await settle(250);
		expect(text(h.container)).toContain("Compaction is taking longer than expected");
		const again = reads();
		expect(again).toBeGreaterThan(reopened + 2);
		expect(again).toBeLessThanOrEqual(reopened + 3 + 3);
		await settle(150);
		expect(reads()).toBe(again);
	});

	it("releases a timed-out card once the server says the compaction is over", async () => {
		const sid = { sessionId: "sess-timeout2", instanceId: "inst-timeout2" };
		let compacting = true;
		mockHub({ info: () => json({ ...INFO, compacting }) });
		const h = mount();
		await h.render(
			<SessionCommandsPanel session={session(sid)} onChanged={() => {}} compactPollMs={15} maxPolls={2} />,
		);
		await settle(150);
		expect(byText(h.container, "button", "Check again")).not.toBeNull();
		compacting = false;
		await click(byText(h.container, "button", "Check again"));
		await settle(80);
		expect(byText(h.container, "button", "Check again")).toBeNull();
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
	});

	it("shows a paused plan as paused and offers only Resume and Exit", async () => {
		const calls = mockHub({
			info: () =>
				json({
					...INFO,
					mode: { ...INFO.mode, plan: true },
					modeStatus: { plan: "paused", vibe: "inactive", goal: "inactive", loop: "inactive" },
				}),
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("Plan mode Paused");
		expect(text(h.container)).not.toContain("Plan mode On");
		expect(byText(h.container, "button", "Enter plan mode")).toBeNull();
		await click(byText(h.container, "button", "Resume plan mode"));
		const dialog = h.body.querySelector("[role=dialog]") as Element;
		expect(text(dialog)).toContain("Resume plan mode in this session?");
		await click(dialog.querySelector("button[data-variant=primary]"));
		await settle();
		expect(urlEnds(calls, "/command").at(-1)?.body).toEqual({
			op: "set-mode",
			args: { mode: "plan", action: "enter" },
		});
		await click(byText(h.container, "button", "Exit plan mode"));
		await confirmPrimary(h);
		expect(urlEnds(calls, "/command").at(-1)?.body).toEqual({
			op: "set-mode",
			args: { mode: "plan", action: "exit" },
		});
	});

	it("shows an active plan as on with Exit only", async () => {
		mockHub({
			info: () =>
				json({
					...INFO,
					mode: { ...INFO.mode, plan: true },
					modeStatus: { plan: "active", vibe: "inactive", goal: "inactive", loop: "inactive" },
				}),
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("Plan mode On");
		expect(all(h.container, "button").filter(b => b.textContent === "Exit plan mode")).toHaveLength(1);
		expect(byText(h.container, "button", "Resume plan mode")).toBeNull();
	});

	it("re-reads the session's settings on a timer so terminal changes show up", async () => {
		let current: HubSessionInfo = INFO;
		const calls = mockHub({ info: () => json(current) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} refreshMs={30} />);
		await settle();
		expect(valueOf(all(h.container, "select")[0])).toBe("anthropic/claude-opus");
		current = {
			...INFO,
			model: { provider: "anthropic", id: "claude-haiku" },
			mode: { ...INFO.mode, plan: true },
			modeStatus: { plan: "paused", vibe: "inactive", goal: "inactive", loop: "inactive" },
		};
		await settle(100);
		expect(valueOf(all(h.container, "select")[0])).toBe("anthropic/claude-haiku");
		expect(text(h.container)).toContain("Plan mode Paused");
		expect(urlEnds(calls, "/session-info").length).toBeGreaterThan(2);
	});

	it("refreshes one read at a time and not while the tab is hidden", async () => {
		let inflight = 0;
		let max = 0;
		const calls = mockHub({
			info: async () => {
				inflight++;
				max = Math.max(max, inflight);
				await Bun.sleep(50);
				inflight--;
				return json(INFO);
			},
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} refreshMs={10} />);
		await settle(200);
		expect(max).toBe(1);
		const doc = globalThis.document as unknown as { hidden: boolean };
		Object.defineProperty(doc, "hidden", { configurable: true, value: true });
		await settle(120);
		const frozen = urlEnds(calls, "/session-info").length;
		await settle(150);
		expect(urlEnds(calls, "/session-info").length).toBe(frozen);
		Reflect.deleteProperty(doc, "hidden");
	});

	it("never overwrites a pending confirmation or a select being edited", async () => {
		let current: HubSessionInfo = INFO;
		mockHub({ info: () => json(current) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} refreshMs={30} />);
		await settle();
		const changed: HubSessionInfo = {
			...INFO,
			model: { provider: "anthropic", id: "claude-haiku" },
			thinkingLevel: "high",
		};
		// a confirmation is open: the shown settings stay put
		await type(all(h.container, "select")[1], "low");
		expect(h.body.querySelector("[role=dialog]")).not.toBeNull();
		current = changed;
		await settle(120);
		expect(valueOf(all(h.container, "select")[0])).toBe("anthropic/claude-opus");
		expect(h.body.querySelector("[role=dialog]")).not.toBeNull();
		// answered: the next read shows the new state
		await click(byText(h.body.querySelector("[role=dialog]") as Element, "button", "Cancel"));
		await settle(120);
		expect(valueOf(all(h.container, "select")[0])).toBe("anthropic/claude-haiku");
		// a focused select is left alone
		current = INFO;
		const select = all(h.container, "select")[0] as unknown as { focus: () => void };
		Object.defineProperty(globalThis.document, "activeElement", { configurable: true, value: select });
		await settle(120);
		expect(valueOf(all(h.container, "select")[0])).toBe("anthropic/claude-haiku");
		Reflect.deleteProperty(globalThis.document, "activeElement");
		await settle(120);
		expect(valueOf(all(h.container, "select")[0])).toBe("anthropic/claude-opus");
	});

	it("re-reads after a successful terminal send", async () => {
		const sessions = [session({ terminal: { available: true, waiting: null, unknown: false } })];
		const calls = mockHub({ sessions: () => json({ sessions, now: Date.now() }) });
		const h = mount();
		(globalThis.window as unknown as Record<string, unknown>).matchMedia = () => ({
			matches: true,
			addEventListener() {},
			removeEventListener() {},
		});
		await h.render(<SessionsRoute active selected="sess-1" onSelect={() => {}} />);
		await settle();
		const reads = () => urlEnds(calls, "/session-info").length;
		await click(byText(h.body, "[role=tab]", "Terminal"));
		await click(h.body.querySelector(".term-toggle"));
		await settle(40);
		const before = reads();
		await click(all(h.body, ".term-keys button").find(b => b.getAttribute("aria-label") === "Down") as Element);
		await settle(60);
		expect(urlEnds(calls, "/keys")).toHaveLength(1);
		expect(reads()).toBe(before + 1);
	});

	it("runs no background refresh during a pending compaction, and never two reads at once", async () => {
		let inflight = 0;
		let max = 0;
		const calls = mockHub({
			info: async () => {
				inflight++;
				max = Math.max(max, inflight);
				await Bun.sleep(25);
				inflight--;
				return json({ ...INFO, compacting: true });
			},
		});
		const h = mount();
		await h.render(
			<SessionCommandsPanel
				session={session()}
				onChanged={() => {}}
				refreshMs={10}
				compactPollMs={90}
				maxPolls={50}
			/>,
		);
		await settle(60);
		expect(text(h.container)).toContain("Compacting…");
		const reads = () => urlEnds(calls, "/session-info").length;
		const start = reads();
		// the compaction poll runs every 90 ms; a 10 ms background refresh would add many more reads
		await settle(260);
		expect(reads() - start).toBeLessThanOrEqual(4);
		expect(max).toBe(1);
	});

	it("runs no background refresh after a timeout: only Check again resumes reads", async () => {
		const sid = { sessionId: "sess-timeout3", instanceId: "inst-timeout3" };
		const calls = mockHub({ info: () => json({ ...INFO, compacting: true }) });
		const reads = () => urlEnds(calls, "/session-info").length;
		const h = mount();
		await h.render(
			<SessionCommandsPanel
				session={session(sid)}
				onChanged={() => {}}
				refreshMs={10}
				compactPollMs={15}
				maxPolls={2}
			/>,
		);
		await settle(200);
		expect(byText(h.container, "button", "Check again")).not.toBeNull();
		const frozen = reads();
		await settle(200);
		expect(reads()).toBe(frozen);
		await click(byText(h.container, "button", "Check again"));
		await settle(60);
		expect(reads()).toBeGreaterThan(frozen);
	});

	it("stops background reads when the page is left and resumes when it is back", async () => {
		let current: HubSessionInfo = INFO;
		const calls = mockHub({ info: () => json(current) });
		const reads = () => urlEnds(calls, "/session-info").length;
		const h = mount();
		const card = (active: boolean, token = 0) => (
			<SessionCommandsPanel
				session={session()}
				onChanged={() => {}}
				refreshMs={20}
				active={active}
				refreshToken={token}
			/>
		);
		await h.render(card(true));
		await settle(100);
		expect(reads()).toBeGreaterThan(2);
		await h.render(card(false));
		await settle(30);
		const away = reads();
		await settle(150);
		expect(reads()).toBe(away);
		// a terminal send while away does not read either
		await h.render(card(false, 1));
		await settle(60);
		expect(reads()).toBe(away);
		// back: it reads again at once and shows what changed meanwhile
		current = { ...INFO, model: { provider: "anthropic", id: "claude-haiku" } };
		await h.render(card(true, 1));
		await settle(60);
		expect(valueOf(all(h.container, "select")[0])).toBe("anthropic/claude-haiku");
		expect(reads()).toBeGreaterThan(away);
	});

	it("a read that started before the compact was acknowledged can't finish the compaction", async () => {
		let reads = 0;
		let releaseOld: (r: Response) => void = () => {};
		let compacting = false;
		const calls = mockHub({
			command: () => json({ outcome: "pending" }, 202),
			info: () => {
				reads++;
				// the second read is a background refresh whose answer is held back
				if (reads === 2) return new Promise<Response>(resolve => (releaseOld = resolve));
				return json({ ...INFO, compacting });
			},
		});
		const h = mount();
		await h.render(
			<SessionCommandsPanel
				session={session()}
				onChanged={() => {}}
				refreshMs={60}
				compactPollMs={20}
				maxPolls={50}
			/>,
		);
		await settle(90);
		expect(reads).toBe(2);
		await click(byText(h.container, "button", "Compact"));
		compacting = true; // the session is compacting now
		await confirmPrimary(h);
		expect(text(h.container)).toContain("Compacting…");
		await settle(60);
		// the old read ends with the pre-compaction answer
		releaseOld(json({ ...INFO, compacting: false }));
		await settle(100);
		expect(text(h.container)).toContain("Compacting…");
		expect(text(h.container)).not.toContain("Compacted.");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(true);
		// only a read that began after the acknowledgement may end it
		const before = urlEnds(calls, "/session-info").length;
		expect(before).toBeGreaterThan(2);
		compacting = false;
		await settle(100);
		expect(text(h.container)).toContain("Compacted.");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
	});

	it("never shows the settings from before a command once it was acknowledged", async () => {
		let reads = 0;
		let releaseOld: (r: Response) => void = () => {};
		let current: HubSessionInfo = INFO;
		mockHub({
			info: () => {
				reads++;
				if (reads === 2) return new Promise<Response>(resolve => (releaseOld = resolve));
				return json(current);
			},
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} refreshMs={100} />);
		await settle(130);
		expect(reads).toBe(2);
		await click(byText(h.container, "button", "Enter plan mode"));
		current = {
			...INFO,
			mode: { ...INFO.mode, plan: true },
			modeStatus: { plan: "active", vibe: "inactive", goal: "inactive", loop: "inactive" },
		};
		await confirmPrimary(h);
		releaseOld(json(INFO)); // pre-command state
		await settle(25);
		expect(text(h.container)).toContain("Plan mode On");
		expect(text(h.container)).not.toContain("Plan mode Off");
	});

	it("shows the compacting text while the request is out", async () => {
		let release: (r: Response) => void = () => {};
		mockHub({ command: () => new Promise<Response>(resolve => (release = resolve)) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		await click(byText(h.container, "button", "Compact"));
		await confirmPrimary(h);
		expect(text(h.container)).toContain("Compacting… this can take a few minutes");
		release(json({ outcome: "ok", result: {} }));
		await settle();
		expect(text(h.container)).not.toContain("Compacting…");
	});

	it("offers Stop next to a failed compact, and Stop uses the existing stop route", async () => {
		const calls = mockHub({
			command: () => json({ error: "the agent is busy; stop the turn before compacting", code: "failed" }, 502),
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(byText(h.container, "button", "Stop the turn")).toBeNull();
		await click(byText(h.container, "button", "Compact"));
		await confirmPrimary(h);
		expect(text(h.container)).toContain("the agent is busy; stop the turn before compacting");
		await click(byText(h.container, "button", "Stop the turn"));
		await settle();
		expect(calls.filter(c => c.url.endsWith("/sessions/sess-1/stop"))).toHaveLength(1);
		expect(calls.at(-1)).toBeDefined();
		expect(byText(h.container, "button", "Stop the turn")).toBeNull();
	});

	it("offers no Stop for a failed change that isn't a compact", async () => {
		mockHub({ command: () => json({ error: "nope", code: "failed" }, 502) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		await click(byText(h.container, "button", "Enter plan mode"));
		await confirmPrimary(h);
		expect(byText(h.container, "button", "Stop the turn")).toBeNull();
	});

	it("needs an objective for a goal, and caps instructions", async () => {
		mockHub();
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(isDisabled(byText(h.container, "button", "Enter goal"))).toBe(true);
		await type(h.container.querySelector("textarea[id^=cmd-compact]"), "x".repeat(2001));
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(true);
		await type(h.container.querySelector("textarea[id^=cmd-compact]"), "😀".repeat(1000));
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
	});

	it("runs one change at a time", async () => {
		let release: (r: Response) => void = () => {};
		const calls = mockHub({ command: () => new Promise<Response>(resolve => (release = resolve)) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		await click(byText(h.container, "button", "Enter plan mode"));
		const dialog = h.body.querySelector("[role=dialog]") as Element;
		const primary = dialog.querySelector("button[data-variant=primary]");
		await click(primary);
		await click(primary);
		await settle();
		expect(urlEnds(calls, "/command")).toHaveLength(1);
		expect(
			all(h.container, "button")
				.filter(b => b.textContent !== "Retry")
				.every(b => isDisabled(b)),
		).toBe(true);
		release(json({ outcome: "ok", result: { changed: true } }));
		await settle();
		expect(isDisabled(byText(h.container, "button", "Enter plan mode"))).toBe(false);
	});

	for (const [code, status, expected] of [
		["restart_needed", 409, RESTART_FOR_COMMANDS],
		["changed", 409, "The session changed"],
		["stale_session", 409, "restarted or replaced"],
		["invalid", 400, "refused that value"],
		["socket", 502, "could not reach the session's control plugin"],
		["failed", 502, "boom"],
		["busy", 409, "Another change is still running in this session."],
	] as const) {
		it(`says what a ${code} reply means, and refetches`, async () => {
			const calls = mockHub({ command: () => json({ error: "boom", code }, status) });
			const h = mount();
			await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
			await settle();
			await click(byText(h.container, "button", "Compact"));
			await confirmPrimary(h);
			expect(text(h.container)).toContain(expected);
			expect(urlEnds(calls, "/session-info")).toHaveLength(2);
		});
	}

	it("shows the restart hint and no controls when the plugin is old", async () => {
		mockHub({ info: () => json({ error: "old", code: "restart_needed" }, 409) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain(RESTART_FOR_COMMANDS);
		expect(h.container.querySelector("select")).toBeNull();
		expect(byText(h.container, "button", "Compact")).toBeNull();
	});

	it("shows an error with Retry when the settings can't be read", async () => {
		let fail = true;
		mockHub({ info: () => (fail ? json({ error: "down" }, 502) : json(INFO)) });
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("down");
		fail = false;
		await click(byText(h.container, "button", "Retry"));
		await settle();
		expect(h.container.querySelector("select")).not.toBeNull();
	});
});

describe("Sessions page with a terminal dialog", () => {
	function withMedia(h: ReturnType<typeof mount>) {
		(globalThis.window as unknown as Record<string, unknown>).matchMedia = () => ({
			matches: true,
			addEventListener() {},
			removeEventListener() {},
		});
		return h;
	}
	const waiting = { kind: "confirm" as const, line: "Exit plan mode? (y/n)", observedAt: "2026-11-16T10:00:00Z" };

	it("counts a terminal dialog as needing you and pins its row", async () => {
		expect(needsYou(session())).toBe(false);
		expect(needsYou(session({ terminal: { available: true, waiting: null, unknown: true } }))).toBe(false);
		expect(needsYou(session({ terminal: { available: true, waiting, unknown: false } }))).toBe(true);

		const sessions = [
			session({ instanceId: "inst-2", sessionId: "sess-2", sessionName: "Quiet" }),
			session({
				terminal: { available: true, waiting, unknown: false },
				waitingSince: Date.now() - 120_000,
				waitingObserved: true,
			}),
		];
		mockHub({ sessions: () => json({ sessions, now: Date.now() }) });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		const pinned = all(h.container, "tbody tr[data-pinned=true]");
		expect(pinned).toHaveLength(1);
		expect(text(pinned[0])).toContain("Needs you");
		expect(text(pinned[0])).not.toContain("Quiet");
	});

	it("shows the terminal line, and the Terminal tab locked", async () => {
		const sessions = [session({ terminal: { available: true, waiting, unknown: false } })];
		const calls = mockHub({ sessions: () => json({ sessions, now: Date.now() }) });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected="sess-1" onSelect={() => {}} />);
		await settle();
		expect(text(h.body)).toContain("Waiting in terminal: Exit plan mode? (y/n)");
		await click(byText(h.body, "[role=tab]", "Terminal"));
		await settle();
		expect(h.body.querySelector(".term-toggle")).not.toBeNull();
		expect(h.body.querySelector(".term-keys")).toBeNull();
		expect(urlEnds(calls, "/screen")).toHaveLength(0);
	});

	it("keeps the Terminal tab when the terminal isn't available and says why, without the terminal itself", async () => {
		const sessions = [
			session({ terminal: { available: false, waiting: null, unknown: false } }),
			session({ instanceId: "i2", sessionId: "s2", terminal: undefined }),
		];
		mockHub({ sessions: () => json({ sessions, now: Date.now() }) });
		const h = withMedia(mount());
		const tabs = () => all(h.body, "[role=tab]").map(t => text(t));
		await h.render(<SessionsRoute active selected="sess-1" onSelect={() => {}} />);
		await settle();
		// The tab stays (N14): it explains why, and no screen is read or keys offered.
		expect(tabs()).toContain("Terminal");
		await click(byText(h.body, "[role=tab]", "Terminal"));
		expect(text(h.body)).toContain("hasn't matched this session to a herdr pane yet; it checks every 15 seconds");
		expect(h.body.querySelector(".term-toggle, .term-screen")).toBeNull();
		await h.render(<SessionsRoute active selected="s2" onSelect={() => {}} />);
		await settle();
		expect(tabs()).toContain("Terminal");
		await click(byText(h.body, "[role=tab]", "Terminal"));
		expect(text(h.body)).toContain("hub doesn't report terminals");
	});

	it("points the plan-review restart hint at the Terminal tab only when it is there", async () => {
		const sessions = [
			session({ planControl: "restart_needed", terminal: { available: true, waiting: null, unknown: false } }),
			session({
				instanceId: "i2",
				sessionId: "s2",
				planControl: "restart_needed",
				terminal: { available: false, waiting: null, unknown: false },
			}),
		];
		mockHub({ sessions: () => json({ sessions, now: Date.now() }) });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected="sess-1" onSelect={() => {}} />);
		await settle();
		expect(text(h.body)).toContain(RESTART_FOR_PLAN_OR_TERMINAL);
		await h.render(<SessionsRoute active selected="s2" onSelect={() => {}} />);
		await settle();
		expect(text(h.body)).toContain(RESTART_FOR_PLAN);
		expect(text(h.body)).not.toContain("Terminal tab");
	});
});

describe("terminal panel: only a fresh screen allows a send", () => {
	const gap = (ms: number) => Bun.sleep(ms);
	const keyDisabled = (h: ReturnType<typeof mount>) => all(h.container, ".term-keys button").every(b => isDisabled(b));

	it("keeps the keys off until the first screen of this unlock arrives", async () => {
		let release: (r: Response) => void = () => {};
		const calls = mockHub({ screen: () => new Promise<Response>(resolve => (release = resolve)) });
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		expect(keyDisabled(h)).toBe(true);
		await click(keyButton(h, "Enter"));
		expect(urlEnds(calls, "/keys")).toHaveLength(0);
		release(json(SCREEN));
		await settle();
		expect(keyDisabled(h)).toBe(false);
	});

	it("takes the permission back after each send until a read that began after it arrives", async () => {
		const reads: ((r: Response) => void)[] = [];
		let first = true;
		const calls = mockHub({
			screen: () =>
				first ? ((first = false), json(SCREEN)) : new Promise<Response>(resolve => reads.push(resolve)),
		});
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		expect(keyDisabled(h)).toBe(false);
		await click(keyButton(h, "Enter"));
		await settle();
		expect(urlEnds(calls, "/keys")).toHaveLength(1);
		// the follow-up read is pending: still off
		expect(reads).toHaveLength(1);
		expect(keyDisabled(h)).toBe(true);
		await click(keyButton(h, "Enter"));
		expect(urlEnds(calls, "/keys")).toHaveLength(1);
		reads[0](json(SCREEN));
		await settle();
		expect(keyDisabled(h)).toBe(false);
	});

	it("is off after the screen goes stale and while the tab is hidden", async () => {
		let hang = false;
		const calls = mockHub({ screen: () => (hang ? new Promise<Response>(() => {}) : json(SCREEN)) });
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={20} staleMs={80} />);
		await unlock(h);
		expect(keyDisabled(h)).toBe(false);
		hang = true;
		await settle(200);
		expect(keyDisabled(h)).toBe(true);
		await click(keyButton(h, "Enter"));
		expect(urlEnds(calls, "/keys")).toHaveLength(0);
		await unmount();

		hang = false;
		const calls2 = mockHub();
		const h2 = mount();
		await h2.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h2);
		expect(keyDisabled(h2)).toBe(false);
		const doc = globalThis.document as unknown as { hidden: boolean; dispatchEvent: (e: unknown) => void };
		Object.defineProperty(doc, "hidden", { configurable: true, value: true });
		const Event = (globalThis.window as unknown as { Event: typeof globalThis.Event }).Event;
		await act(async () => doc.dispatchEvent(new Event("visibilitychange")));
		expect(keyDisabled(h2)).toBe(true);
		await click(keyButton(h2, "Enter"));
		expect(urlEnds(calls2, "/keys")).toHaveLength(0);
		Reflect.deleteProperty(doc, "hidden");
		await gap(0);
	});

	it("does not carry the unlock to another session when the panel is re-rendered for it", async () => {
		const calls = mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		const oldEnter = keyButton(h, "Enter");
		expect(urlEnds(calls, "/screen").every(c => c.url.includes("/sess-1/"))).toBe(true);
		await h.render(<TerminalPanel session={session({ sessionId: "sess-2", instanceId: "inst-2" })} pollMs={500} />);
		// at once: locked, no keys, no old screen, no read for the new session
		expect(h.container.querySelector(".term-keys")).toBeNull();
		expect(h.container.querySelector(".term-screen")).toBeNull();
		expect(toggle(h)?.getAttribute("aria-checked")).toBe("false");
		await click(oldEnter);
		await settle(60);
		expect(urlEnds(calls, "/keys")).toHaveLength(0);
		expect(urlEnds(calls, "/screen").some(c => c.url.includes("/sess-2/"))).toBe(false);
	});
});

describe("terminal panel: a late screen is not fresh", () => {
	it("does not enable sending when the response arrives after staleMs", async () => {
		let slow = true;
		const calls = mockHub({
			screen: async () => {
				if (slow) {
					slow = false;
					await Bun.sleep(150);
				}
				return json(SCREEN);
			},
		});
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={400} staleMs={60} />);
		await unlock(h);
		await settle(150);
		// the screen is shown, but it was read 150 ms ago: older than staleMs
		expect(h.container.querySelector(".term-screen")?.textContent).toContain("Exit plan mode?");
		expect(all(h.container, ".term-keys button").every(b => isDisabled(b))).toBe(true);
		await click(keyButton(h, "Enter"));
		expect(urlEnds(calls, "/keys")).toHaveLength(0);
		// the next, quick read is fresh
		let enabled = false;
		for (let i = 0; i < 30 && !enabled; i++) {
			await settle(30);
			enabled = all(h.container, ".term-keys button").some(b => !isDisabled(b));
		}
		expect(enabled).toBe(true);
	});

	it("shows when the hub read the screen from the numeric capturedAt", async () => {
		mockHub();
		const h = mount();
		await h.render(<TerminalPanel session={session()} pollMs={500} />);
		await unlock(h);
		expect(text(h.container)).toContain(`Screen read at ${new Date(1_795_000_000_000).toLocaleTimeString()}`);
	});
});

describe("session commands panel: a late completion from another session", () => {
	it("does not overwrite the new session's settings, notice or busy state", async () => {
		let release: (r: Response) => void = () => {};
		const infoFor: Record<string, HubSessionInfo> = {
			"sess-1": INFO,
			"sess-2": { ...INFO, thinkingLevel: "high", mode: { ...INFO.mode, plan: true } },
		};
		const calls = mockHub({
			command: () => new Promise<Response>(resolve => (release = resolve)),
			info: url => json(infoFor[url.match(/sessions\/([^/]+)\/session-info/)?.[1] ?? ""]),
		});
		const h = mount();
		await h.render(<SessionCommandsPanel session={session()} onChanged={() => {}} />);
		await settle();
		await click(byText(h.container, "button", "Compact"));
		await click((h.body.querySelector("[role=dialog]") as Element).querySelector("button[data-variant=primary]"));
		await h.render(
			<SessionCommandsPanel session={session({ sessionId: "sess-2", instanceId: "inst-2" })} onChanged={() => {}} />,
		);
		await settle();
		const infoReads = () => calls.filter(c => c.url.endsWith("/session-info")).length;
		const before = infoReads();
		expect(urlEnds(calls, "/command")).toHaveLength(1);
		expect(valueOf(all(h.container, "select")[1])).toBe("high");
		expect(isDisabled(byText(h.container, "button", "Compact"))).toBe(false);
		release(json({ outcome: "ok", result: {} }));
		await settle();
		expect(valueOf(all(h.container, "select")[1])).toBe("high");
		expect(text(h.container)).not.toContain("Compacted.");
		expect(infoReads()).toBe(before);
		expect(byText(h.container, "button", "Exit plan mode")).not.toBeNull();
	});
});
