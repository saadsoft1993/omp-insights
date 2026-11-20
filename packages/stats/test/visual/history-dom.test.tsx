import { afterEach, expect, test, vi } from "bun:test";
import { act } from "react";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../../src/client/app/machine";
import { resetFleetQueryForTests } from "../../src/client/data/fleet-query";
import { clearQueryCache } from "../../src/client/data/query-store";
import { HistoryRoute } from "../../src/client/routes/HistoryRoute";
import { byText, click, mount, settle, text, unmount, valueOf } from "../helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	resetFleetQueryForTests();
	clearQueryCache();
});

test("expanding a machine's live history row loads its subagents and opens its transcript", async () => {
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", self: true, ok: true },
			{ id: "mini", ok: true },
		]),
	);
	selectMachine("mini");
	const transcript = vi.fn();
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		urls.push(url);
		if (url.includes("hub/sessions"))
			return Response.json({ sessions: [{ instanceId: "i", sessionId: "id", machine: "mini" }] });
		if (url.includes("session/subagents"))
			return Response.json([
				{
					id: "child",
					agent: "worker",
					title: "Child",
					models: [],
					startedAt: 1,
					endedAt: 2,
					durationMs: 1,
					costTotal: 0,
					requests: 1,
					status: "done",
					toolErrors: 2,
				},
			]);
		if (url.includes("/sessions"))
			return Response.json([
				{
					file: "/transcript.jsonl",
					sessionId: "id",
					title: "Session title",
					firstMessage: "hello",
					folder: "/work",
					cwd: "/work",
					startedAt: 1,
					endedAt: 2,
					missing: false,
					requests: 1,
					toolCalls: 0,
					subagents: 1,
					totalTokens: 0,
					costTotal: 0,
					unpricedRequests: 0,
					models: [],
				},
			]);
		return Response.json({});
	});
	await view.render(<HistoryRoute active range="all" onTranscript={transcript} onLive={() => {}} />);
	await settle();
	await settle();
	await settle();
	const row = Array.from(view.container.querySelectorAll("tr")).find(el => el.textContent?.includes("Session title"));
	expect(row).toBeDefined();
	await click(row);
	await settle();
	await settle();
	expect(urls.some(url => url.includes("/m/mini/api/session/subagents?") && url.includes("parentLive=1"))).toBe(true);
	expect(view.container.textContent).toContain("Errors 2");
	const open = Array.from(view.container.querySelectorAll("button")).find(
		button => button.textContent === "Open transcript",
	);
	expect(open).toBeDefined();
	await click(open);
	expect(transcript).toHaveBeenCalledWith("/transcript.jsonl", "mini");
});

test("names a reachable machine whose history request fails", async () => {
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", name: "Server", self: true, ok: true },
			{ id: "mini", name: "Mini", ok: true },
		]),
	);
	selectMachine("*");
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		if (url.includes("/m/mini/api/sessions")) return Response.json({ error: "stats unavailable" }, { status: 503 });
		if (url.includes("/api/hub/sessions")) return Response.json({ sessions: [] });
		if (url.includes("/api/sessions")) return Response.json([]);
		return Response.json({});
	});
	await view.render(<HistoryRoute active range="all" onTranscript={() => {}} onLive={() => {}} />);
	await settle();
	await settle();
	await settle();
	expect(view.container.textContent).toContain("Mini's stats server isn't answering; numbers may be missing.");
});

const historyRow = {
	file: "/server/session.jsonl",
	sessionId: "id",
	title: "Server session",
	firstMessage: "full initial message",
	folder: "/work",
	cwd: "/work",
	startedAt: 1,
	endedAt: 2,
	missing: false,
	requests: 1,
	toolCalls: 2,
	subagents: 1,
	totalTokens: 20,
	costTotal: 1,
	unpricedRequests: 0,
	models: ["test-model"],
};

test("renders known rows while naming a machine whose first response is pending", async () => {
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", name: "Server", self: true, ok: true },
			{ id: "mini", name: "Mini", ok: true },
		]),
	);
	selectMachine("*");
	const mini = Promise.withResolvers<Response>();
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		if (url.includes("/m/mini/api/sessions")) return mini.promise;
		if (url.includes("/api/hub/sessions")) return Response.json({ sessions: [] });
		if (url.includes("/api/sessions")) return Response.json([historyRow]);
		return Response.json({});
	});
	await view.render(<HistoryRoute active range="all" onTranscript={() => {}} onLive={() => {}} />);
	await settle();
	await settle();
	expect(view.container.textContent).toContain("Server session");
	expect(view.container.textContent).toContain("Loading Mini");
	expect(view.container.textContent).not.toContain("No sessions in this range");
	const metadata = view.container.querySelector(".history-compact-meta");
	expect(metadata?.textContent).toContain("Server");
	await act(async () => {
		mini.resolve(Response.json([]));
	});
	await settle();
	expect(view.container.textContent).not.toContain("Loading Mini");
});

test("clears toolbar and filtered empty state", async () => {
	const view = mount();
	vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
		String(input).includes("/hub/sessions") ? Response.json({ sessions: [] }) : Response.json([]),
	);
	await view.render(<HistoryRoute active range="all" onTranscript={() => {}} onLive={() => {}} />);
	await settle();
	const search = view.container.querySelector('input[placeholder^="Search title"]');
	const propsKey = Object.keys(search!).find(key => key.startsWith("__reactProps$"))!;
	const change = (value: string) =>
		act(async () => {
			(search as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey].onChange({
				target: { value },
			});
		});
	await change("missing");
	await settle();
	expect(view.container.textContent).toContain("No sessions match");
	await click(byText(view.container, "button", "Clear filters"));
	expect(valueOf(search)).toBe("");
	await change("another");
	await click(byText(view.container, "button", "Clear"));
	expect(valueOf(search)).toBe("");
});

test("failed live refresh clears parentLive and reports unavailable", async () => {
	const view = mount();
	setFleet(parseMachines([{ id: "mini", name: "Mini", self: true, ok: true }]));
	selectMachine("mini");
	const urls: string[] = [];
	let liveCalls = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		urls.push(url);
		if (url.includes("/hub/sessions"))
			return ++liveCalls === 1
				? Response.json({ sessions: [{ instanceId: "i", sessionId: "id", machine: "mini" }] })
				: Response.json({ error: "offline" }, { status: 503 });
		if (url.includes("/session/subagents")) return Response.json([]);
		if (url.includes("/api/sessions")) return Response.json([historyRow]);
		return Response.json({});
	});
	await view.render(<HistoryRoute active range="all" onTranscript={() => {}} onLive={() => {}} />);
	await settle();
	await settle();
	await click(byText(view.container, "tr", "Server session"));
	await settle();
	expect(urls.some(url => url.includes("parentLive=1"))).toBe(true);
	await settle(5200);
	await settle();
	expect(view.container.textContent).toContain("Live status unavailable for Mini");
	expect(urls.some(url => url.includes("/session/subagents") && !url.includes("parentLive"))).toBe(true);
	// Live status unknown: a quiet "—", never "Unknown" and never a guessed Running or Ended.
	expect(view.container.textContent).not.toContain("Unknown");
	expect(text(byText(view.container, "tr", "Server session")!)).not.toMatch(/Running|Ended/);
	expect(text(byText(view.container, "tr", "Server session")!)).toContain("—");
}, 10000);
