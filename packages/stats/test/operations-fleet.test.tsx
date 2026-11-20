import { afterEach, expect, it, vi } from "bun:test";
import { ALL_MACHINES, parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { DevicesRoute } from "../src/client/routes/DevicesRoute";
import { JobsRoute } from "../src/client/routes/JobsRoute";
import { RelayRoute } from "../src/client/routes/RelayRoute";
import { clearQueryCache } from "../src/client/data/query-store";
import { all, byText, click, mount, settle, type, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

it("runs the selected machine's job and reads logs under All machines", async () => {
	const h = mount();
	const posts: string[] = [];
	const gets: string[] = [];
	setFleet(
		parseMachines([
			{ id: "server", name: "Server", self: true, ok: true },
			{ id: "mini", name: "Mini", ok: true },
		]),
	);
	selectMachine(ALL_MACHINES);
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") {
			posts.push(url);
			return Response.json({ outcome: "accepted" });
		}
		gets.push(url);
		if (url.endsWith("/version")) return Response.json({ capabilities: { jobsActions: true } });
		if (url.includes("/jobs/logs?")) return Response.json({ stdout: "ok", stderr: "", truncated: false });
		if (url.endsWith("/jobs")) {
			const id = url.includes("/mini/") ? "mini" : "server";
			return Response.json({
				now: Date.now(),
				gaps: [],
				jobs: [
					{
						label: `${id}.job`,
						file: id,
						readable: true,
						note: null,
						schedule: null,
						status: "ok",
						exit: "ok",
						pid: null,
						lastLogWrite: null,
						kind: "scheduled",
						loaded: true,
					},
				],
			});
		}
		return Response.json({ error: "unexpected" }, { status: 404 });
	}) as typeof fetch);
	await h.render(<JobsRoute active />);
	await settle();
	for (const [machine, name] of [
		["server", "Server"],
		["mini", "Mini"],
	]) {
		await click(h.container.querySelector(`button[aria-label="Logs of ${machine}.job on ${name}"]`));
		await settle();
		expect(gets.some(url => url === `/m/${machine}/api/hub/jobs/logs?label=${machine}.job`)).toBe(true);
		await click(h.body.querySelector('[role="dialog"] button[aria-label="Close"]'));
		await click(h.container.querySelector(`button[aria-label="Run now ${machine}.job on ${name}"]`));
		await type(h.body.querySelector('input[aria-label="Job name"]'), `${machine}.job`);
		const dialogs = all(h.body, '[role="dialog"]');
		await click(byText(dialogs[dialogs.length - 1], "button", "Run now"));
		await settle();
		expect(posts).toContain(`/m/${machine}/api/hub/jobs/run`);
	}
});

it("disconnects each viewer on its own machine under All machines", async () => {
	const h = mount();
	const posts: string[] = [];
	setFleet(
		parseMachines([
			{ id: "alpha", name: "Alpha", self: true, ok: true },
			{ id: "beta", name: "Beta", ok: true },
		]),
	);
	selectMachine(ALL_MACHINES);
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") {
			posts.push(url);
			return Response.json({ ok: true });
		}
		if (url.endsWith("/version")) return Response.json({ capabilities: { relayViewers: true } });
		const id = url.includes("/beta/") ? "beta" : "alpha";
		return Response.json({
			ok: true,
			canUnpair: true,
			viewers: [{ room: id, peer: 1, device8: id, connectedAt: Date.now(), ua: "browser" }],
		});
	}) as typeof fetch);
	await h.render(<RelayRoute active />);
	await settle();
	for (const machine of ["alpha", "beta"]) {
		const row = all(h.container, "tr").find(
			el => el.textContent?.includes(machine) && el.textContent?.includes("browser"),
		);
		await click(byText(row!, "button", "Disconnect"));
		const dialogs = all(h.body, '[role="dialog"]');
		await click(byText(dialogs[dialogs.length - 1], "button", "Disconnect"));
		await settle();
		expect(posts).toContain(`/m/${machine}/api/hub/relay/disconnect`);
	}
});

it("unpairs the selected device on each row's machine", async () => {
	const h = mount();
	const posts: string[] = [];
	setFleet(
		parseMachines([
			{ id: "north", name: "North", self: true, ok: true },
			{ id: "south", name: "South", ok: true },
		]),
	);
	selectMachine(ALL_MACHINES);
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") {
			posts.push(url);
			return Response.json({ revoked: 1, self: false });
		}
		const id = url.includes("/south/") ? "south" : "north";
		return Response.json({
			devices: [
				{ id, label: `${id} browser`, scope: "tailnet", pairedAt: 1, expiresAt: null, auto: false, current: false },
			],
			autoPair: false,
			scope: "tailnet",
			canLink: false,
		});
	}) as typeof fetch);
	await h.render(<DevicesRoute active />);
	await settle();
	for (const machine of ["north", "south"]) {
		const row = all(h.container, "tr").find(el => el.textContent?.includes(`${machine} browser`));
		await click(byText(row!, "button", "Unpair"));
		const dialogs = all(h.body, '[role="dialog"]');
		await click(byText(dialogs[dialogs.length - 1], "button", "Unpair"));
		await settle();
		expect(posts).toContain(`/m/${machine}/api/hub/devices/revoke`);
	}
});
