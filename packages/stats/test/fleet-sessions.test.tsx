import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { SessionsRoute } from "../src/client/routes/SessionsRoute";
import { all, click, isDisabled, mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

const FLEET = [
	{ id: "server", name: "Ada Server", self: true, ok: true, dashboardUrl: "https://srv.example:8794/" },
	{ id: "macbook", name: "Ada MacBook", self: false, ok: true, dashboardUrl: "https://mb.example:8794/" },
];

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function withMedia(h: ReturnType<typeof mount>) {
	(globalThis.window as unknown as Record<string, unknown>).matchMedia = () => ({
		matches: true,
		addEventListener() {},
		removeEventListener() {},
	});
	return h;
}

const row = (machine: string, id: string) => ({
	instanceId: `inst-${id}`,
	sessionId: `sess-${id}`,
	sessionName: id,
	cwd: "/p",
	busy: false,
	relay: "tailnet" as const,
	machine,
});

/** Fleet fetch stub; `projects` decides each machine's answer (a never-settling promise models a slow machine). */
function mockFleet(projects: Record<string, () => Promise<Response>>) {
	const calls: Array<{ url: string; method: string }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET" });
		if (url === "/api/hub/sessions") {
			return json({
				sessions: [row("server", "a"), row("macbook", "b")],
				machines: FLEET.map(m => ({ id: m.id, name: m.name, ok: true })),
				now: Date.now(),
			});
		}
		if (url === "/m/macbook/api/hub/link") {
			return json({ url: "https://relay.example/session", pairUrl: "https://mb.example/pair" });
		}
		const match = /^\/m\/([a-z]+)\/api\/hub\/projects$/.exec(url);
		if (match) return projects[match[1]]();
		if (url.endsWith("/api/hub/quota")) {
			return json({
				generatedAt: null,
				cacheAgeMs: null,
				cacheStale: false,
				source: "",
				providers: {},
				accounts: [],
			});
		}
		return json({});
	}) as typeof fetch);
	return calls;
}

const projectsOf = (name: string) => () =>
	Promise.resolve(
		json({ projects: [{ path: `/${name}/proj`, name: `${name}-proj`, label: `${name}-proj`, last_used: null }] }),
	);

async function openStart(h: ReturnType<typeof mount>) {
	await click(all(h.container, "button").find(b => text(b).includes("Start a session")));
	await settle();
}

describe("Start across machines", () => {
	it("requires a machine before loading projects or starting in all mode", async () => {
		setFleet(parseMachines([...FLEET, { id: "mini", name: "Ada Mini", self: false, ok: true }]));
		const calls = mockFleet({ mini: projectsOf("mini") });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		await openStart(h);
		expect(text(h.body)).toContain("Pick a machine");
		expect(calls.some(c => c.url.endsWith("/projects") || c.url.endsWith("/start"))).toBe(false);
		const chip = all(h.body, '[aria-label="Start on machine"] button').find(b => text(b).includes("Mini"));
		await click(chip);
		await settle();
		expect(calls.some(c => c.url === "/m/mini/api/hub/projects")).toBe(true);
		await click(all(h.body, ".hub-project button")[0]);
		await settle();
		expect(calls.some(c => c.url === "/m/mini/api/hub/start" && c.method === "POST")).toBe(true);
	});
	it("shows no project and offers no Start while the new machine's list is loading", async () => {
		setFleet(parseMachines(FLEET));
		const calls = mockFleet({ server: projectsOf("server"), macbook: () => new Promise<Response>(() => {}) });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		selectMachine("*");
		await settle();
		await openStart(h);
		const server = all(h.body, '[aria-label="Start on machine"] button').find(b => text(b).includes("Server"));
		await click(server);
		await settle();
		expect(text(h.body)).toContain("server-proj");
		const start = () => all(h.body, ".hub-project button");
		expect(start().length).toBe(1);
		expect(isDisabled(start()[0])).toBe(false);

		const chip = all(h.body, '[aria-label="Start on machine"] button').find(b => text(b).includes("MacBook"));
		await click(chip);
		await settle();
		expect(text(h.body)).not.toContain("server-proj");
		expect(start().length).toBe(0);
		expect(calls.some(c => c.url === "/m/macbook/api/hub/projects")).toBe(true);
		expect(calls.some(c => c.method === "POST")).toBe(false);
	});

	it("starts on the machine whose list is shown", async () => {
		setFleet(parseMachines(FLEET));
		const calls = mockFleet({ server: projectsOf("server"), macbook: projectsOf("macbook") });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		selectMachine("*");
		await settle();
		await openStart(h);
		const chip = all(h.body, '[aria-label="Start on machine"] button').find(b => text(b).includes("MacBook"));
		await click(chip);
		await settle();
		expect(text(h.body)).toContain("macbook-proj");
		await click(all(h.body, ".hub-project button")[0]);
		await settle();
		expect(calls.filter(c => c.method === "POST").map(c => c.url)).toEqual(["/m/macbook/api/hub/start"]);
	});
});

describe("Start follows the header machine", () => {
	it("starts on the header machine without asking for one", async () => {
		setFleet(parseMachines(FLEET));
		selectMachine("macbook");
		const calls = mockFleet({ server: projectsOf("server"), macbook: projectsOf("macbook") });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		await openStart(h);
		expect(h.body.querySelector('[aria-label="Start on machine"]')).toBeNull();
		expect(text(h.body)).toContain("Start a session on Ada MacBook");
		await click(all(h.body, ".hub-project button")[0]);
		await settle();
		expect(calls.filter(c => c.method === "POST").map(c => c.url)).toEqual(["/m/macbook/api/hub/start"]);
	});
});

describe("Pair link", () => {
	const pairLinks = (h: ReturnType<typeof mount>) => all(h.body, "a").filter(a => text(a) === "Pair");

	it("opens the returned pairing URL instead of the relay URL", async () => {
		setFleet(parseMachines(FLEET));
		const calls = mockFleet({ server: projectsOf("server"), macbook: projectsOf("macbook") });
		const h = withMedia(mount());
		const replace = vi.fn();
		const open = vi.fn(() => ({ opener: null, location: { replace } }));
		(globalThis.window as unknown as Record<string, unknown>).open = open;
		await h.render(<SessionsRoute active selected="sess-b" onSelect={() => {}} />);
		await settle();
		await click(all(h.body, "button").find(button => text(button).includes("Open & control")));
		await settle();
		expect(calls.some(c => c.url === "/m/macbook/api/hub/link" && c.method === "POST")).toBe(true);
		expect(open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(replace).toHaveBeenCalledWith("https://mb.example/pair");
	});

	it("is not shown for a session of this hub's own machine", async () => {
		setFleet(parseMachines(FLEET));
		mockFleet({ server: projectsOf("server"), macbook: projectsOf("macbook") });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected="sess-a" onSelect={() => {}} />);
		await settle();
		expect(pairLinks(h).length).toBe(0);
	});
});
