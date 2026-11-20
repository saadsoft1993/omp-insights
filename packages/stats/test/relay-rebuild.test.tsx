import { afterEach, expect, it, vi } from "bun:test";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { RelayRoute } from "../src/client/routes/RelayRoute";
import { all, byText, click, mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

function setup(options: { capability?: boolean; error?: string | null; state?: string; status?: number } = {}) {
	setFleet(parseMachines([{ id: "server", name: "Server", self: true, ok: true }]));
	selectMachine("server");
	const posts: { url: string; body: unknown }[] = [];
	const relay = {
		ok: false,
		error: options.error === undefined ? "web UI not built; rebuild it" : options.error,
		needsUpdate: true,
		viewers: null,
		rebuild: {
			runId: "1",
			state: options.state ?? "idle",
			step: "",
			startedAt: null,
			finishedAt: Date.now() / 1000,
			exitCode: null,
			message: "build broke",
			tail: ["last line"],
		},
	};
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") {
			posts.push({ url, body: JSON.parse(String(init.body)) });
			return Response.json(options.status ? { error: "refused" } : relay.rebuild, { status: options.status ?? 202 });
		}
		if (url.endsWith("/version"))
			return Response.json({ capabilities: { relayViewers: true, relayRebuild: options.capability ?? true } });
		return Response.json(relay);
	}) as typeof fetch);
	return { posts, relay };
}

it("confirms and posts a rebuild to the affected machine", async () => {
	const { posts } = setup();
	const h = mount();
	await h.render(<RelayRoute active />);
	await settle();
	await click(byText(h.container, "button", "Rebuild web client and restart relay"));
	const dialog = all(h.body, '[role="dialog"]')[0];
	expect(text(dialog)).toContain("usually under a minute; longer the first time after an omp upgrade");
	await click(byText(dialog, "button", "Rebuild web client and restart relay"));
	await settle();
	expect(posts).toEqual([{ url: "/m/server/api/hub/relay/rebuild", body: { confirm: true } }]);
});

it("requires both a matching problem and the capability", async () => {
	setup({ capability: false });
	const h = mount();
	await h.render(<RelayRoute active />);
	await settle();
	expect(text(h.container)).not.toContain("Rebuild web client and restart relay");
});

it("does not offer a rebuild for an unrelated error", async () => {
	setup({ error: "some other problem" });
	const h = mount();
	await h.render(<RelayRoute active />);
	await settle();
	expect(text(h.container)).not.toContain("Rebuild web client and restart relay");
});

it("polls every two seconds during a rebuild", async () => {
	setup({ state: "building" });
	const intervals: number[] = [];
	const original = globalThis.setInterval;
	vi.spyOn(globalThis, "setInterval").mockImplementation(((
		callback: TimerHandler,
		delay?: number,
		...args: unknown[]
	) => {
		intervals.push(delay ?? 0);
		return original(callback, delay, ...args);
	}) as typeof setInterval);
	const h = mount();
	await h.render(<RelayRoute active />);
	await settle();
	expect(text(h.container)).toContain("Rebuilding…");
	expect(intervals).toContain(2000);
	expect(byText(h.container, "button", "Rebuild web client and restart relay")?.hasAttribute("disabled")).toBe(true);
});

it("shows failure, log, and restart retry states", async () => {
	setup({ state: "failed" });
	const h = mount();
	await h.render(<RelayRoute active />);
	await settle();
	expect(text(h.container)).toContain("Failed: build broke");
	await click(byText(h.container, "button", "Show log"));
	expect(text(h.container)).toContain("last line");
});

it("keeps done visible when the warning clears", async () => {
	setup({ state: "done", error: null });
	const h = mount();
	await h.render(<RelayRoute active />);
	await settle();
	expect(text(h.container)).toContain("Done at");
});

it("offers retry when a restart is needed", async () => {
	const { posts } = setup({ state: "restart-needed" });
	const h = mount();
	await h.render(<RelayRoute active />);
	await settle();
	expect(text(h.container)).toContain("Web client installed; relay restart needed");
	await click(byText(h.container, "button", "Retry"));
	const dialog = all(h.body, '[role="dialog"]')[0];
	await click(byText(dialog, "button", "Rebuild web client and restart relay"));
	await settle();
	expect(posts).toEqual([{ url: "/m/server/api/hub/relay/rebuild", body: { confirm: true } }]);
});

for (const [status, sentence] of [
	[409, "A rebuild is already in progress."],
	[429, "Please wait 30 seconds after the last rebuild before trying again."],
	[503, "This machine's relay isn't the omp-private-relay plugin."],
] as const) {
	it(`explains a ${status} refusal`, async () => {
		setup({ status });
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		await click(byText(h.container, "button", "Rebuild web client and restart relay"));
		const dialog = all(h.body, '[role="dialog"]')[0];
		await click(byText(dialog, "button", "Rebuild web client and restart relay"));
		await settle();
		expect(text(dialog)).toContain(sentence);
		expect(all(dialog, '[role="alert"]').length).toBe(1);
	});
}
