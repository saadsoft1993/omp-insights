import { afterEach, expect, it, vi } from "bun:test";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { TraceView } from "../src/client/traces/TraceView";
import type { SessionTrace, TraceTrack } from "../src/client/types";
import { click, installGlobal, mount, settle, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

async function setup(fail: boolean) {
	const view = mount();
	installGlobal("devicePixelRatio", 1);
	installGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
	installGlobal(
		"MutationObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	installGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
		setTimeout(() => callback(performance.now()), 0),
	);
	installGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	Object.getPrototypeOf(document.createElement("canvas")).getContext = () => null;
	window.clearTimeout = globalThis.clearTimeout;
	window.setTimeout = globalThis.setTimeout;
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
	selectMachine("*");
	const child: TraceTrack = {
		id: "Scout1",
		parentId: "main",
		label: "Scout1",
		agent: null,
		model: null,
		file: "/mini/child.jsonl",
		markers: [],
		spans: [1, 2, 3].map(n => ({
			id: `child:${n}`,
			kind: "model",
			entryId: `${n}`,
			start: n,
			end: n + 1,
			label: `Child span ${n}`,
		})),
	};
	const trace: SessionTrace = {
		file: "/mini/session.jsonl",
		title: "Session",
		cwd: "/mini",
		startedAt: 1,
		endedAt: 4,
		mtimeMs: 4,
		etag: "test",
		tracks: [
			{
				id: "main",
				parentId: null,
				label: "Main",
				agent: null,
				model: null,
				file: "/mini/session.jsonl",
				markers: [],
				spans: [],
			},
			{ ...child, spans: [], omittedSpans: 3 },
		],
		summary: {
			wallMs: 3,
			modelMs: 3,
			toolMs: 0,
			idleMs: 0,
			turns: 0,
			requests: 3,
			toolCalls: 0,
			subagents: 1,
			totalTokens: 0,
			costTotal: 0,
			unpricedRequests: 0,
			toolStats: [],
		},
	};
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		urls.push(url);
		if (url.includes("/session/trace-track?"))
			return fail ? Response.json({ error: "not found" }, { status: 404 }) : Response.json({ track: child });
		return Response.json(trace);
	});
	await view.render(<TraceView file={trace.file} machine="mini" active onBack={() => {}} />);
	await settle();
	return { view, urls };
}

it("loads child spans on demand from the trace machine", async () => {
	const { view, urls } = await setup(false);
	const button = view.container.querySelector("button.traces-gutter-load");
	expect(button?.textContent).toBe("Load 3 spans");
	await click(button);
	await settle();
	expect(urls).toContain("/m/mini/api/session/trace-track?file=%2Fmini%2Fsession.jsonl&track=Scout1");
	expect(view.container.querySelector("button.traces-gutter-load")).toBeNull();
	for (const n of [1, 2, 3]) expect(view.container.textContent).toContain(`Child span ${n}`);
});

it("offers Try again after a child track request fails, saying why in plain words", async () => {
	const { view, urls } = await setup(true);
	await click(view.container.querySelector("button.traces-gutter-load"));
	await settle();
	const button = view.container.querySelector("button.traces-gutter-load");
	expect(button?.textContent).toBe("Try again");
	// Plain wording with the raw cause only as Details; no "retrying", since a track loads only when asked.
	// The fleet names this machine "mini" (no display name in the fixture): the sentence says whose stats failed.
	expect(button?.getAttribute("title")).toBe(
		"Couldn't load these spans: mini's stats didn't answer. Details: not found",
	);
	expect(button?.getAttribute("title")).not.toContain("retrying");
	// Try again asks once more.
	const before = urls.filter(url => url.includes("/session/trace-track?")).length;
	await click(button);
	await settle();
	expect(urls.filter(url => url.includes("/session/trace-track?")).length).toBe(before + 1);
});

it("a loaded track whose refresh fails keeps its spans, says so, offers Try again, and recovers on the next parent refresh", async () => {
	const view = mount();
	installGlobal("devicePixelRatio", 1);
	installGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
	installGlobal(
		"MutationObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	installGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
		setTimeout(() => callback(performance.now()), 0),
	);
	installGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	Object.getPrototypeOf(document.createElement("canvas")).getContext = () => null;
	window.clearTimeout = globalThis.clearTimeout;
	window.setTimeout = globalThis.setTimeout;
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
	selectMachine("*");
	const spans = (count: number) =>
		Array.from({ length: count }, (_, i) => ({
			id: `child:${i + 1}`,
			kind: "model" as const,
			entryId: `${i + 1}`,
			start: i + 1,
			end: i + 2,
			label: `Child span ${i + 1}`,
		}));
	const child = (count: number): TraceTrack => ({
		id: "Scout1",
		parentId: "main",
		label: "Scout1",
		agent: null,
		model: null,
		file: "/mini/child.jsonl",
		markers: [],
		spans: spans(count),
	});
	let version = 1;
	let trackFails = false;
	const parent = (): SessionTrace => ({
		file: "/mini/session.jsonl",
		title: "Session",
		cwd: "/mini",
		startedAt: 1,
		endedAt: 5,
		mtimeMs: version,
		etag: `v${version}`,
		tracks: [
			{
				id: "main",
				parentId: null,
				label: "Main",
				agent: null,
				model: null,
				file: "/mini/session.jsonl",
				markers: [],
				spans: [],
			},
			{ ...child(version + 2), spans: [], omittedSpans: version + 2 },
		],
		summary: {
			wallMs: 4,
			modelMs: 4,
			toolMs: 0,
			idleMs: 0,
			turns: 0,
			requests: 4,
			toolCalls: 0,
			subagents: 1,
			totalTokens: 0,
			costTotal: 0,
			unpricedRequests: 0,
			toolStats: [],
		},
	});
	let trackAsks = 0;
	let parent304s = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (!url.includes("/session/trace-track?")) {
			// The parent revalidates by ETag: unchanged means 304 (the same object on the page).
			const etag = `"v${version}"`;
			const sent = new Headers(init?.headers).get("If-None-Match");
			if (sent === etag) {
				parent304s++;
				return new Response(null, { status: 304, headers: { ETag: etag } });
			}
			return Response.json(parent(), { headers: { ETag: etag } });
		}
		trackAsks++;
		return trackFails
			? Response.json(
					{ error: "the stats port answered without the dashboard's proof; nothing was passed on" },
					{ status: 502 },
				)
			: Response.json({ track: child(version + 2) });
	});
	await view.render(<TraceView file="/mini/session.jsonl" machine="mini" active onBack={() => {}} />);
	await settle();
	// 1. Load Scout1 (v1: 3 spans).
	await click(view.container.querySelector("button.traces-gutter-load"));
	await settle();
	expect(view.container.textContent).toContain("Child span 3");
	// 2-3. The parent moves on (4 spans now) and Scout1's refresh fails.
	version = 2;
	trackFails = true;
	await click(view.container.querySelector('button[aria-label="Refresh trace"]'));
	await settle();
	await settle();
	// The last good spans stay, with a marked Try again that says why in plain words.
	expect(view.container.textContent).toContain("Child span 3");
	const retry = view.container.querySelector("button.traces-gutter-load[data-stale]");
	expect(retry?.textContent).toBe("Try again");
	expect(retry?.getAttribute("title")).toStartWith(
		"Couldn't refresh these spans: mini's stats server is a different version until it's updated.",
	);
	expect(retry?.getAttribute("title")).toContain("Details: the stats port answered without the dashboard's proof");
	expect(retry?.getAttribute("title")).not.toContain("retrying");
	// Try again asks the track once more.
	const before = trackAsks;
	await click(retry);
	await settle();
	expect(trackAsks).toBe(before + 1);
	expect(view.container.querySelector("button.traces-gutter-load[data-stale]")).not.toBeNull();
	// 4. The track recovers; the parent's next refresh is an unchanged 304, which still asks it again.
	trackFails = false;
	const before304 = parent304s;
	await click(view.container.querySelector('button[aria-label="Refresh trace"]'));
	await settle();
	await settle();
	expect(parent304s).toBe(before304 + 1);
	expect(view.container.querySelector("button.traces-gutter-load[data-stale]")).toBeNull();
	expect(view.container.textContent).toContain("Child span 4");
});
