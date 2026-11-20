import { afterEach, expect, it, vi } from "bun:test";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { TraceView } from "../src/client/traces/TraceView";
import type { SessionTrace } from "../src/client/types";
import { click, installGlobal, mount, settle, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

it("loads a clicked span from the trace machine while All machines is selected", async () => {
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
	const canvasPrototype = Object.getPrototypeOf(document.createElement("canvas"));
	canvasPrototype.getContext = () => null;
	window.clearTimeout = globalThis.clearTimeout;
	window.setTimeout = globalThis.setTimeout;
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
	selectMachine("*");

	const trace: SessionTrace = {
		file: "/mini/session.jsonl",
		title: "Remote session",
		cwd: "/mini",
		startedAt: 1,
		endedAt: 2,
		mtimeMs: 2,
		etag: "1:2",
		tracks: [
			{
				id: "main",
				parentId: null,
				label: "Main",
				agent: null,
				model: null,
				file: "/mini/session.jsonl",
				markers: [],
				spans: [{ id: "main:entry", kind: "model", entryId: "entry", start: 1, end: 2, label: "Remote span" }],
			},
		],
		summary: {
			wallMs: 1,
			modelMs: 1,
			toolMs: 0,
			idleMs: 0,
			turns: 0,
			requests: 1,
			toolCalls: 0,
			subagents: 0,
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
		return Response.json(url.includes("/session/entry?") ? { entry: {} } : trace);
	});

	await view.render(<TraceView file={trace.file} machine="mini" active onBack={() => {}} />);
	await settle();
	const row = view.container.querySelector("button.traces-row");
	expect(row?.textContent).toContain("Remote span");
	await click(row);
	await settle();
	expect(urls).toContain("/m/mini/api/session/trace?file=%2Fmini%2Fsession.jsonl");
	expect(urls.filter(url => url.includes("/session/entry?"))).toEqual([
		"/m/mini/api/session/entry?file=%2Fmini%2Fsession.jsonl&id=entry",
	]);
});
