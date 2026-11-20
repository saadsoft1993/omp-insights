import { afterEach, expect, it, vi } from "bun:test";
import { act } from "react";
import { clearQueryCache } from "../src/client/data/query-store";
import { parseMachines, resetFleetForTests, selection, selectMachine, setFleet } from "../src/client/app/machine";
import { MachinesRoute } from "../src/client/routes/MachinesRoute";
import { click, mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	resetFleetForTests();
});

it("shows machine health, scoped session counts, pairing links and the selected row", async () => {
	const machines = [
		{
			id: "server",
			name: "Server",
			self: true,
			ok: true,
			latencyMs: 0,
			lastOkAt: 1794978455294,
			dashboardUrl: "https://server.example/",
		},
		{
			id: "mini",
			name: "Mini",
			self: false,
			ok: true,
			latencyMs: 12,
			lastOkAt: 1794978455294,
			dashboardUrl: "https://mini.example/",
		},
	];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (url: RequestInfo | URL) => {
		const body = String(url).endsWith("/machines")
			? { machines }
			: {
					sessions: [{ machine: "server" }, { machine: "mini" }, { machine: "mini", stale: true }],
					machines: [
						{ id: "server", ok: true },
						{ id: "mini", ok: true },
					],
					now: Date.now(),
				};
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch);
	setFleet(parseMachines({ machines }));
	selectMachine("mini");
	const h = mount();
	await h.render(<MachinesRoute active />);
	await settle();
	const rows = Array.from(h.container.querySelectorAll("tbody tr"));
	expect(rows).toHaveLength(2);
	const mini = rows.find(row => text(row).includes("Mini"));
	expect(mini?.getAttribute("data-selected")).toBe("true");
	expect(text(mini!)).toContain("Reachable");
	expect(text(mini!)).toContain("12 ms");
	expect(text(mini!)).toContain("1");
	// Node dashboards are only a "Managed machine" stub now: no links to them, picking a machine selects it here.
	expect(h.container.querySelector("a[href]")).toBeNull();
	expect(text(mini!)).toContain("Selected");
	const server = rows.find(row => text(row).includes("Server"));
	await click(server!.querySelector('button[aria-label="View Server"]'));
	expect(selection()).toBe("server");
	expect(text(h.container)).not.toContain("Pair this browser");
});

it("shows the session count as unknown, with a warning, when the session list refresh fails", async () => {
	clearQueryCache();
	const timers: (() => void)[] = [];
	vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
		if (ms === 15_000) timers.push(callback);
		return 1;
	}) as unknown as typeof setInterval);
	const machines = [{ id: "a", name: "A", self: true, ok: true }];
	let fail = false;
	vi.spyOn(globalThis, "fetch").mockImplementation((async (url: RequestInfo | URL) => {
		const body = String(url).endsWith("/machines")
			? { machines }
			: fail
				? { error: "session list offline" }
				: { sessions: [{ machine: "a" }, { machine: "a" }], machines: [{ id: "a", ok: true }], now: Date.now() };
		return new Response(JSON.stringify(body), {
			status: fail && !String(url).endsWith("/machines") ? 400 : 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch);
	setFleet(parseMachines({ machines }));
	const h = mount();
	await h.render(<MachinesRoute active />);
	await settle();
	const count = () => text(h.container.querySelector('td[data-kind="number"]')!);
	expect(count()).toBe("2");
	fail = true;
	await act(async () => timers.forEach(fn => fn()));
	await settle();
	expect(count()).toContain("unknown");
	expect(count()).not.toContain("2");
	expect(text(h.container)).toContain("session counts are unknown");
	// The session list really polls every 15 s, so the retry claim is true here.
	expect(timers.length).toBeGreaterThan(0);
	expect(text(h.container)).toContain("Retrying every 15 seconds.");
});

it("says it is checking, not 0 of 0 reachable, until the machine list answers (D18)", async () => {
	clearQueryCache();
	vi.spyOn(globalThis, "fetch").mockImplementation((() => new Promise<Response>(() => {})) as typeof fetch);
	const h = mount();
	await h.render(<MachinesRoute active />);
	await settle();
	expect(text(h.container)).toMatch(/Loading…|Checking each machine…/);
	expect(text(h.container)).not.toContain("0 of 0 reachable");
});

it("shows a machine in the hub's grace period as Last known, not Reachable", async () => {
	clearQueryCache();
	const machines = [
		{ id: "a", name: "A", self: true, ok: true, latencyMs: 0, lastOkAt: 1794978455294 },
		{ id: "b", name: "B", ok: true, stale: true, staleSince: 1794978455294, latencyMs: 300, lastOkAt: 1794978455294 },
	];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (url: RequestInfo | URL) => {
		const body = String(url).endsWith("/machines")
			? { machines }
			: {
					sessions: [],
					machines: [
						{ id: "a", ok: true },
						{ id: "b", ok: true },
					],
					now: Date.now(),
				};
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch);
	setFleet(parseMachines({ machines }));
	const h = mount();
	await h.render(<MachinesRoute active />);
	await settle();
	const b = Array.from(h.container.querySelectorAll("tbody tr")).find(row => text(row).includes("B"));
	expect(text(b!)).toContain("Last known");
	expect(text(b!)).not.toContain("Reachable");
	expect(b?.querySelector('[title^="last known as of"]')).not.toBeNull();
	expect(b?.querySelector('.std-unreachable[data-state="last-known"]')).not.toBeNull();
	expect(text(b!)).not.toContain("Unreachable");
	expect(text(h.container)).toContain("2 of 2 reachable (1 last known)");
});

it.each([
	[
		403,
		"forbidden",
		"Couldn't check the machines. This browser isn't allowed to read the machine list; pair it again.",
	],
	[
		502,
		"machine identity check failed",
		"Couldn't check the machines. The hub's identity check failed; it may be a different version until it's updated.",
	],
	[502, "bad answer", "Couldn't check the machines. The hub sent an unexpected answer."],
	[502, "no answer in time", "Couldn't check the machines. This hub didn't answer in time; it may be restarting."],
	[502, "machine unreachable", "Couldn't check the machines. This hub didn't answer; it may be restarting."],
	[500, "something odd", "Couldn't check the machines."],
] as const)(
	"words a failed machine list by its cause (%i %s), raw reason in the tooltip",
	async (status, reason, shown) => {
		clearQueryCache();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(JSON.stringify({ error: reason }), {
					status,
					headers: { "Content-Type": "application/json" },
				})) as typeof fetch,
		);
		const h = mount();
		await h.render(<MachinesRoute active />);
		await settle();
		const message = Array.from(h.container.querySelectorAll("[title]")).find(el =>
			text(el).startsWith("Couldn't check the machines."),
		);
		expect(text(message!)).toBe(shown);
		expect(message?.getAttribute("title")).toBe(reason);
		if (status !== 403 && !reason.includes("unreachable") && !reason.includes("in time"))
			expect(text(message!)).not.toContain("didn't answer");
	},
);
