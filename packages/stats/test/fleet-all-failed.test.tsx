import { afterEach, expect, test, vi } from "bun:test";
import { act } from "react";
import fixture from "./visual/fixture-models.json";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import {
	ALL_MACHINES_FAILED,
	FleetFailedError,
	fleetQueryState,
	resetFleetQueryForTests,
} from "../src/client/data/fleet-query";
import { clearQueryCache } from "../src/client/data/query-store";
import { ModelsRoute } from "../src/client/routes/ModelsRoute";
import { QueryView } from "../src/client/ui/States";
import { mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	resetFleetQueryForTests();
	clearQueryCache();
});

const machine = (id: string, error: string | null) => ({
	id,
	name: id,
	ok: error === null,
	error,
	stale: false,
	outdated: false,
	lastKnown: false,
});

test("fleetQueryState: failed only when every machine failed and none has data", () => {
	expect(fleetQueryState({ data: null, machines: [machine("a", "timeout"), machine("b", "unreachable")] })).toBe(
		"failed",
	);
	expect(fleetQueryState({ data: null, machines: [machine("a", "timeout"), machine("b", null)] })).toBe("loading");
	expect(fleetQueryState({ data: null, machines: [machine("a", null), machine("b", null)] })).toBe("loading");
	expect(fleetQueryState({ data: { x: 1 }, machines: [machine("a", "timeout"), machine("b", null)] })).toBe("ready");
	expect(fleetQueryState({ data: null, machines: [] })).toBe("loading");
});

test("QueryView shows the all-failed line with Try again, never a skeleton", async () => {
	const view = mount();
	let retried = 0;
	await view.render(
		<QueryView
			query={{ data: null, error: new FleetFailedError(), loading: false, refetch: () => retried++ }}
			skeleton={<p className="skeleton">loading</p>}
		>
			{() => <p>data</p>}
		</QueryView>,
	);
	const message = view.container.querySelector(".error-state-message")!;
	expect(text(message)).toBe(ALL_MACHINES_FAILED);
	expect(message.getAttribute("title")).toBeNull();
	expect(view.container.querySelector(".skeleton")).toBeNull();
	const button = view.container.querySelector(".error-state button") as unknown as { click: () => void };
	expect(text(button as unknown as Element)).toBe("Try again");
	await act(async () => button.click());
	expect(retried).toBe(1);
});

/** Models under All machines with a per-machine answer: data, a failure, or no answer yet. */
async function renderModels(answer: (machine: string) => "data" | "fail" | "hang") {
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("*");
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input);
		const id = /\/m\/([a-z]+)\//.exec(url)?.[1] ?? "server";
		const kind = answer(id);
		if (kind === "hang") return new Promise<Response>(() => {});
		if (kind === "fail") return Response.json({ error: "no answer in time" }, { status: 502 });
		return Response.json(fixture.machines.server);
	}) as typeof fetch);
	const view = mount();
	await view.render(<ModelsRoute active range="24h" />);
	await settle(50);
	await act(async () => settle(50));
	return view;
}

test("All machines, every machine failed: one failed line, no skeletons", async () => {
	const view = await renderModels(() => "fail");
	expect(view.container.querySelectorAll(".error-state")).toHaveLength(1);
	// The headline, with each machine's reason folded in under it (N8).
	expect(text(view.container.querySelector(".error-state-message")!)).toStartWith(ALL_MACHINES_FAILED);
	expect(view.container.querySelector(".skeleton")).toBeNull();
	expect(text(view.container)).toContain("Ada Server's stats didn't answer in time");
});

test("All machines, one machine answered: its data shows, no failed line", async () => {
	const view = await renderModels(id => (id === "server" ? "data" : "fail"));
	expect(view.container.querySelector(".error-state")).toBeNull();
	expect(text(view.container)).toContain("Models used");
	expect(text(view.container)).not.toContain(ALL_MACHINES_FAILED);
});

test("All machines, nothing answered yet: skeletons, no failed line", async () => {
	const view = await renderModels(() => "hang");
	expect(view.container.querySelector(".error-state")).toBeNull();
	expect(view.container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
});

test("Traces under All machines, every machine failed: one failed line, no skeletons", async () => {
	const { TracesRoute } = await import("../src/client/routes/TracesRoute");
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("*");
	vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
		Response.json({ error: "no answer in time" }, { status: 502 })) as typeof fetch);
	const view = mount();
	await view.render(<TracesRoute active session={null} sessionMachine={null} onOpenSession={() => {}} />);
	await settle(50);
	await act(async () => settle(50));
	expect(view.container.querySelectorAll(".error-state")).toHaveLength(1);
	// The headline, with each machine's reason folded in under it (N8).
	expect(text(view.container.querySelector(".error-state-message")!)).toStartWith(ALL_MACHINES_FAILED);
	expect(view.container.querySelector(".skeleton")).toBeNull();
	expect(text(view.container)).not.toContain("All machines are unreachable");
});

test("fleetQueryState: a held machine is reconnecting, not failed; with last-known data it is ready", () => {
	const held = { ...machine("macbook", "timeout"), lastKnown: true, stale: true };
	const failed = machine("mini", "unreachable");
	expect(fleetQueryState({ data: null, machines: [held, failed] })).toBe("loading");
	expect(fleetQueryState({ data: null, machines: [held] })).toBe("loading");
	expect(fleetQueryState({ data: { old: true }, machines: [held, failed] })).toBe("ready");
	expect(fleetQueryState({ data: null, machines: [failed] })).toBe("failed");
});

test("Try again with every machine unreachable refreshes the machine list, says Checking…, then asks", async () => {
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: false },
			{ id: "macbook", name: "Ada MacBook", ok: false },
		]),
	);
	selectMachine("*");
	const urls: string[] = [];
	let releaseMachines: () => void = () => {};
	const machinesAnswered = new Promise<void>(resolve => {
		releaseMachines = resolve;
	});
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith("/api/hub/machines")) {
			await machinesAnswered;
			return Response.json({
				machines: [
					{ id: "server", name: "Ada Server", self: true, ok: true },
					{ id: "macbook", name: "Ada MacBook", ok: false },
				],
			});
		}
		return Response.json(fixture.machines.server);
	}) as typeof fetch);
	const view = mount();
	await view.render(<ModelsRoute active range="24h" />);
	await settle(30);
	// The headline, with each machine's reason folded in under it (N8).
	expect(text(view.container.querySelector(".error-state-message")!)).toStartWith(ALL_MACHINES_FAILED);
	expect(urls.filter(url => url.includes("/model-dashboard"))).toEqual([]);
	const button = view.container.querySelector(".error-state button") as unknown as HTMLButtonElement;
	await act(async () => button.click());
	expect(urls).toContain("/api/hub/machines");
	expect(text(view.container.querySelector(".error-state button")!)).toBe("Checking…");
	expect(view.container.querySelector(".error-state button")?.hasAttribute("disabled")).toBe(true);
	await act(async () => {
		releaseMachines();
		await settle(50);
	});
	await act(async () => settle(50));
	expect(urls.filter(url => url.includes("/model-dashboard"))).toEqual([
		"/m/server/api/stats/model-dashboard?range=24h",
	]);
	expect(view.container.querySelector(".error-state")).toBeNull();
	expect(text(view.container)).toContain("Models used");
});

test("Spotlight: a machine's Retry asks it again through the fleet query and its panel recovers", async () => {
	const { SpotlightRoute } = await import("../src/client/routes/SpotlightRoute");
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("*");
	const empty = { sessions: 0, recent: [], experimentStart: null };
	let macbookUp = false;
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith("/api/hub/machines"))
			return Response.json({
				machines: [
					{ id: "server", name: "Ada Server", self: true, ok: true },
					{ id: "macbook", name: "Ada MacBook", ok: true },
				],
			});
		if (url.includes("/m/macbook/") && !macbookUp)
			return Response.json({ error: "no answer in time" }, { status: 502 });
		return Response.json(empty);
	}) as typeof fetch);
	const view = mount();
	await view.render(<SpotlightRoute active range="24h" />);
	await settle(50);
	await act(async () => settle(50));
	const panels = () => [...view.container.querySelectorAll("section")];
	const macbook = () => panels().find(section => text(section).startsWith("Ada MacBook"))!;
	expect(text(macbook())).toContain("Ada MacBook's stats didn't answer in time");
	macbookUp = true;
	const before = urls.length;
	await act(async () => (macbook().querySelector(".error-state button") as unknown as HTMLButtonElement).click());
	await act(async () => settle(80));
	await act(async () => settle(50));
	const asked = urls.slice(before);
	expect(asked.some(url => url.startsWith("/m/macbook/api/stats/spotlight"))).toBe(true);
	// Never the panel's idle local query, and only the machine whose Retry was pressed.
	expect(asked.some(url => url.startsWith("/api/stats/spotlight"))).toBe(false);
	expect(asked.some(url => url.startsWith("/m/server/api/stats/spotlight"))).toBe(false);
	expect(macbook().querySelector(".error-state")).toBeNull();
});

test("Gain under All machines, every machine failed: one failed line, no skeletons", async () => {
	const { GainRoute } = await import("../src/client/routes/GainRoute");
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("*");
	vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
		Response.json({ error: "no answer in time" }, { status: 502 })) as typeof fetch);
	const view = mount();
	await view.render(<GainRoute active range="24h" />);
	await settle(50);
	await act(async () => settle(50));
	expect(view.container.querySelectorAll(".error-state")).toHaveLength(1);
	// The headline, with each machine's reason folded in under it (N8).
	expect(text(view.container.querySelector(".error-state-message")!)).toStartWith(ALL_MACHINES_FAILED);
	expect(view.container.querySelector(".skeleton")).toBeNull();
});

test("refetch passed straight to a click handler still asks every machine", async () => {
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("*");
	let up = false;
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith("/api/hub/machines"))
			return Response.json({
				machines: [
					{ id: "server", name: "Ada Server", self: true, ok: true },
					{ id: "macbook", name: "Ada MacBook", ok: true },
				],
			});
		return up ? Response.json(fixture.machines.server) : Response.json({ error: "busy" }, { status: 503 });
	}) as typeof fetch);
	const { useFleetQuery } = await import("../src/client/data/fleet-query");
	function Probe() {
		const fleet = useFleetQuery(
			["probe-click"],
			async (id, signal) => {
				const response = await fetch(`/m/${id}/api/stats/probe`, { signal });
				if (!response.ok) throw new Error("busy");
				return id;
			},
			ids => ids.join(","),
		);
		return (
			<button type="button" onClick={fleet.refetch as unknown as () => void}>
				{fleet.data ?? "none"}
			</button>
		);
	}
	const view = mount();
	await view.render(<Probe />);
	await act(async () => settle(30));
	up = true;
	const before = urls.length;
	await act(async () => (view.container.querySelector("button") as unknown as HTMLButtonElement).click());
	await act(async () => settle(50));
	const asked = urls.slice(before).filter(url => url.includes("/probe"));
	expect(asked.sort()).toEqual(["/m/macbook/api/stats/probe", "/m/server/api/stats/probe"]);
});

test("changing the range while Try again waits for the machine list never leaves Checking… stuck", async () => {
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("*");
	let releaseList: () => void = () => {};
	const listPending = new Promise<void>(resolve => {
		releaseList = resolve;
	});
	const listSignals: AbortSignal[] = [];
	let up = false;
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/hub/machines")) {
			listSignals.push(init?.signal as AbortSignal);
			await listPending;
			return Response.json({
				machines: [
					{ id: "server", name: "Ada Server", self: true, ok: true },
					{ id: "macbook", name: "Ada MacBook", ok: true },
				],
			});
		}
		return up ? Response.json(fixture.machines.server) : Response.json({ error: "busy" }, { status: 503 });
	}) as typeof fetch);
	const view = mount();
	await view.render(<ModelsRoute active range="24h" />);
	await act(async () => settle(30));
	// The headline, with each machine's reason folded in under it (N8).
	expect(text(view.container.querySelector(".error-state-message")!)).toStartWith(ALL_MACHINES_FAILED);
	// Try again: the machine list request hangs, so the button says Checking….
	await act(async () => (view.container.querySelector(".error-state button") as unknown as HTMLButtonElement).click());
	expect(text(view.container.querySelector(".error-state button")!)).toBe("Checking…");
	// The range changes while the list is still pending: that retry is cancelled with it.
	up = true;
	await view.render(<ModelsRoute active range="7d" />);
	await act(async () => settle(50));
	expect(listSignals[0]?.aborted).toBe(true);
	// The list answers late; the old retry must not claim the new range's requests.
	await act(async () => {
		releaseList();
		await settle(50);
	});
	expect(text(view.container)).not.toContain("Checking…");
	expect(view.container.querySelector(".error-state")).toBeNull();
	expect(text(view.container)).toContain("Models used");
});

test("unmounting mid Try again aborts the machine list request and leaves nothing running", async () => {
	setFleet(parseMachines([{ id: "server", name: "Ada Server", self: true, ok: true }]));
	selectMachine("*");
	const listSignals: AbortSignal[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/hub/machines")) {
			listSignals.push(init?.signal as AbortSignal);
			return new Promise<Response>(() => {});
		}
		return Response.json({ error: "busy" }, { status: 503 });
	}) as typeof fetch);
	const view = mount();
	await view.render(<ModelsRoute active range="24h" />);
	await act(async () => settle(30));
	await act(async () => (view.container.querySelector(".error-state button") as unknown as HTMLButtonElement).click());
	expect(listSignals).toHaveLength(1);
	await view.render(null);
	expect(listSignals[0]?.aborted).toBe(true);
});

test("refetch resolves once the machine list refresh is done, and also when superseded", async () => {
	setFleet(parseMachines([{ id: "server", name: "Ada Server", self: true, ok: true }]));
	selectMachine("*");
	const releases: (() => void)[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/api/hub/machines")) {
			await new Promise<void>(resolve => releases.push(resolve));
			return Response.json({ machines: [{ id: "server", name: "Ada Server", self: true, ok: true }] });
		}
		return Response.json(fixture.machines.server);
	}) as typeof fetch);
	const { useFleetQuery } = await import("../src/client/data/fleet-query");
	let refetch: (machine?: string) => Promise<void> = async () => {};
	function Probe() {
		refetch = useFleetQuery(
			["probe-promise"],
			async id => id,
			ids => ids.join(","),
		).refetch;
		return null;
	}
	const view = mount();
	await view.render(<Probe />);
	let first = false;
	let second = false;
	const one = refetch().then(() => {
		first = true;
	});
	await settle(10);
	expect(first).toBe(false);
	// A second Try again supersedes the first: both still resolve, neither rejects.
	const two = refetch().then(() => {
		second = true;
	});
	await settle(10);
	for (const release of releases) release();
	await act(async () => {
		await Promise.all([one, two]);
	});
	expect(first).toBe(true);
	expect(second).toBe(true);
});

test("Models for one machine, busy: no retrying wording, Try again asks once more", async () => {
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("server");
	let asked = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		if (String(input).includes("/model-dashboard")) asked++;
		return Response.json({ error: "busy" }, { status: 503 });
	}) as typeof fetch);
	const view = mount();
	await view.render(<ModelsRoute active range="24h" />);
	await act(async () => settle(60));
	expect(asked).toBe(1);
	expect(text(view.container.querySelector(".error-state-message")!)).toBe("Ada Server's stats are busy; try again.");
	expect(text(view.container)).not.toContain("retrying");
	await act(async () => (view.container.querySelector(".error-state button") as unknown as HTMLButtonElement).click());
	await act(async () => settle(40));
	expect(asked).toBe(2);
});

test("All machines banner keeps retrying: the fleet query asks failed machines again", async () => {
	const view = await renderModels(id => (id === "server" ? "data" : "fail"));
	expect(text(view.container)).toContain("Ada MacBook's stats didn't answer in time");
	const { missingMachinesText } = await import("../src/client/app/MachineBanner");
	expect(
		missingMachinesText([
			{ id: "m", name: "M", ok: false, error: "busy", stale: false, outdated: false, lastKnown: false },
		]),
	).toEqual(["M's stats are busy; retrying."]);
});

test("N8: when every machine failed, one red line carries the reasons and the amber banner hides", async () => {
	const view = await renderModels(() => "fail");
	expect(view.container.querySelector(".missing-machines")).toBeNull();
	const message = view.container.querySelector(".error-state-message")!;
	expect(text(message)).toContain(ALL_MACHINES_FAILED);
	const reasons = [...message.querySelectorAll(".error-state-reasons > span")].map(span => text(span));
	expect(reasons).toEqual([
		"Ada Server's stats didn't answer in time; numbers may be missing.",
		"Ada MacBook's stats didn't answer in time; numbers may be missing.",
	]);
	expect(message.querySelector(".error-state-reasons > span")?.getAttribute("title")).toBe(
		"Details: no answer in time",
	);
});

test("N8: with one machine answering, the amber banner still names the other", async () => {
	const view = await renderModels(id => (id === "server" ? "data" : "fail"));
	expect(text(view.container.querySelector(".missing-machines")!)).toContain(
		"Ada MacBook's stats didn't answer in time",
	);
	expect(view.container.querySelector(".error-state")).toBeNull();
});

test("N7: a machine slower than 6 s is waited for, never declared failed", async () => {
	vi.useFakeTimers();
	try {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
			]),
		);
		selectMachine("*");
		let answer: () => void = () => {};
		const slow = new Promise<void>(resolve => {
			answer = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = String(input);
			// The server's stats are a different version (expected); the MacBook is slow but answering.
			if (url.includes("/m/server/"))
				return Response.json(
					{ error: "the stats port answered without the dashboard's proof; nothing was passed on" },
					{ status: 502 },
				);
			await slow;
			return Response.json(fixture.machines.server);
		}) as typeof fetch);
		const view = mount();
		await view.render(<ModelsRoute active range="24h" />);
		await act(async () => {
			vi.advanceTimersByTime(9_000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
		});
		expect(text(view.container)).not.toContain(ALL_MACHINES_FAILED);
		expect(view.container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
		await act(async () => {
			answer();
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		expect(text(view.container)).toContain("Models used");
		expect(text(view.container)).not.toContain(ALL_MACHINES_FAILED);
	} finally {
		vi.useRealTimers();
	}
});

test("N7: a slow first machine-list answer keeps fleet mode instead of falling back to one machine", async () => {
	const { useFleetReady, getFleet, selection } = await import("../src/client/app/machine");
	vi.useFakeTimers();
	try {
		let answer: () => void = () => {};
		const slow = new Promise<void>(resolve => {
			answer = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			await slow;
			return Response.json({
				machines: [
					{ id: "server", name: "Ada Server", self: true, ok: true },
					{ id: "macbook", name: "Ada MacBook", ok: true },
				],
			});
		}) as typeof fetch);
		let ready = false;
		function Probe() {
			ready = useFleetReady();
			return null;
		}
		const view = mount();
		await view.render(<Probe />);
		await act(async () => {
			vi.advanceTimersByTime(7_000);
			for (let i = 0; i < 4; i++) await Promise.resolve();
		});
		expect(ready).toBe(false);
		await act(async () => {
			answer();
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		expect(ready).toBe(true);
		expect(getFleet()?.map(m => m.id)).toEqual(["server", "macbook"]);
		expect(selection()).toBe("*");
	} finally {
		vi.useRealTimers();
	}
});
