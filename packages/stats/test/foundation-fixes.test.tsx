import { afterEach, expect, test, vi } from "bun:test";
import { act } from "react";
import { fleetLiveView, machineStreamState, useFleetStreams } from "../src/client/app/LiveChip";
import { retryDelay, TOO_MANY_STREAMS } from "../src/client/data/live";
import { missingMachinesText } from "../src/client/app/MachineBanner";
import { MachineName } from "../src/client/app/MachineName";
import { MachineSelect } from "../src/client/app/MachineSelect";
import {
	parseMachines,
	resetFleetForTests,
	selectMachine,
	setFleet,
	shortMachineName,
} from "../src/client/app/machine";
import { LOADING_TEXT, loadingText, MachineCell, Table, unreachableTitle } from "../src/client/ui/Table";
import { click, installGlobal, mount, text, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	resetFleetForTests();
});

const fleet = parseMachines([
	{ id: "server", name: "Ada Server", self: true, ok: true },
	{ id: "macbook", name: "Ada MacBook", ok: true },
	{ id: "mini", name: "Ada Mac mini", ok: true },
])!;

test("D9: an unreachable machine is an amber dot with the words in its tooltip", async () => {
	const view = mount();
	const since = Date.UTC(2026, 10, 18, 9, 5);
	await view.render(<MachineCell name="MacBook" color="red" reachable={false} since={since} />);
	expect(text(view.container)).toBe("MacBook");
	const dot = view.container.querySelector(".std-unreachable");
	expect(dot?.getAttribute("aria-label")).toBe("unreachable since 18 Nov at 14:05 PKT");
	expect(view.container.querySelector(".std-machine")?.getAttribute("title")).toBe(
		"MacBook: unreachable since 18 Nov at 14:05 PKT",
	);
	expect(unreachableTitle(null)).toBe("unreachable");
});

test("D16: an open stream is live however quiet; only no open stream is stale", () => {
	const now = 1_000_000;
	const open = { connected: true, receivedAt: now - 5 * 60_000 };
	expect(fleetLiveView(fleet, { server: open, macbook: open, mini: open }, now)).toMatchObject({
		label: "Live",
		count: "3/3",
		tone: "live",
	});
	const errored = { connected: false, receivedAt: now - 3 * 60_000 };
	expect(fleetLiveView(fleet, { server: open, macbook: open, mini: errored }, now)).toMatchObject({
		count: "2/3",
		tone: "warn",
	});
	expect(fleetLiveView(fleet, { server: errored, macbook: errored, mini: errored }, now)).toMatchObject({
		label: "Stale",
		count: "3m ago",
	});
	expect(fleetLiveView(fleet, {}, now)).toMatchObject({ label: "Connecting", tone: "neutral" });
	const down = fleet.map(machine => ({ ...machine, ok: false }));
	expect(fleetLiveView(down, {}, now).label).toBe("No machines reachable");
});

test("D16: streams stay live while idle, drop on error and recover on reconnect", async () => {
	const sources: { url: string; onopen: (() => void) | null; onerror: (() => void) | null }[] = [];
	class FakeEventSource {
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: (() => void) | null = null;
		constructor(readonly url: string) {
			sources.push(this);
		}
		close() {}
	}
	const view = mount();
	installGlobal("EventSource", FakeEventSource);
	setFleet(fleet);
	let latest: Record<string, { connected: boolean }> = {};
	function Probe() {
		latest = useFleetStreams(fleet);
		return null;
	}
	await view.render(<Probe />);
	const fire = async (handler: "onopen" | "onerror", id: string) => {
		const source = sources.find(item => item.url.includes(`/m/${id}/`));
		await act(async () => source?.[handler]?.());
	};
	for (const machine of fleet) await fire("onopen", machine.id);
	const start = Date.now();
	expect(fleetLiveView(fleet, latest as never, start + 5 * 60_000).count).toBe("3/3");
	await fire("onerror", "mini");
	expect(fleetLiveView(fleet, latest as never, start).count).toBe("2/3");
	await fire("onopen", "mini");
	expect(fleetLiveView(fleet, latest as never, start).count).toBe("3/3");
});

test("D16: one machine flapping never reconnects the others", async () => {
	const opened: string[] = [];
	const closed: string[] = [];
	class FakeEventSource {
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: (() => void) | null = null;
		constructor(readonly url: string) {
			opened.push(url);
		}
		close() {
			closed.push(this.url);
		}
	}
	const view = mount();
	installGlobal("EventSource", FakeEventSource);
	setFleet(fleet);
	{
		function Probe({ machines }: { machines: typeof fleet }) {
			useFleetStreams(machines);
			return null;
		}
		const down = fleet.map(machine => (machine.id === "mini" ? { ...machine, ok: false } : machine));
		await view.render(<Probe machines={fleet} />);
		for (let flap = 0; flap < 3; flap++) {
			await view.render(<Probe machines={down} />);
			await view.render(<Probe machines={fleet} />);
		}
		const count = (list: string[], id: string) => list.filter(url => url.includes(`/m/${id}/`)).length;
		expect(count(opened, "server")).toBe(1);
		expect(count(opened, "macbook")).toBe(1);
		expect(count(closed, "server")).toBe(0);
		expect(count(closed, "macbook")).toBe(0);
		expect(count(opened, "mini")).toBe(4);
		expect(count(closed, "mini")).toBe(3);
	}
});

test("D17: only a real version signal says out of date; other failures say why", () => {
	const base = { error: null, ok: true, stale: false, outdated: false };
	expect(
		missingMachinesText([
			{ ...base, id: "server", name: "Ada Server", ok: false, error: "not found", outdated: true },
			{ ...base, id: "mini", name: "Ada Mac mini", ok: false, error: "unreachable" },
			{ ...base, id: "macbook", name: "Ada MacBook", ok: false, error: "timeout" },
		]),
	).toEqual([
		"Ada Mac mini is unreachable; its numbers are missing.",
		"Ada Server's stats are out of date (update the hub).",
		"Ada MacBook's stats didn't answer in time; numbers may be missing.",
	]);
	expect(missingMachinesText([{ ...base, id: "a", name: "A" }])).toEqual([]);
});

test("D18: loading tables say Loading… in subtitle and summary, never zero", async () => {
	const view = mount();
	await view.render(
		<Table
			variant="std"
			loading
			title="Jobs"
			subtitle="0 jobs"
			summary="All 0 · Failed 0"
			columns={[{ key: "name", header: "Name", render: (row: { name: string }) => row.name }]}
			rows={[]}
			rowKey={row => row.name}
		/>,
	);
	expect(text(view.container.querySelector(".std-subtitle")!)).toBe(LOADING_TEXT);
	expect(text(view.container.querySelector(".std-summary")!)).toBe(LOADING_TEXT);
	expect(view.container.querySelectorAll(".std-skeleton-row").length).toBe(5);
	expect(loadingText(true, () => "3 jobs")).toBe("Loading…");
	expect(loadingText(false, () => "3 jobs")).toBe("3 jobs");
});

test("D19: the mobile Sort label and select are separate elements", async () => {
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: (row: { name: string }) => row.name, sort: r => r.name }]}
			rows={[{ name: "a" }]}
			rowKey={row => row.name}
		/>,
	);
	expect(text(view.container.querySelector(".std-mobile-sort > span")!)).toBe("Sort");
});

test("D20: the group header spans every rendered column", async () => {
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={["a", "b", "c", "d"].map(key => ({ key, header: key, render: () => key, priority: 3 as const }))}
			rows={[{ id: 1 }]}
			rowKey={row => row.id}
			group={() => ({ key: "g", label: "Group" })}
		/>,
	);
	expect(view.container.querySelector("tr.std-group th")?.getAttribute("colspan")).toBe("4");
});

test("D24: the popover marks the selected machine; phones get short names", async () => {
	setFleet(fleet);
	selectMachine("macbook");
	const view = mount();
	await view.render(<MachineSelect />);
	await click(view.container.querySelector(".machine-dropdown-trigger"));
	const selected = view.container.querySelector('[role="option"][aria-selected="true"]');
	expect(text(selected!)).toContain("Ada MacBook");
	expect(text(selected!.querySelector(".machine-dropdown-check")!)).toBe("✓");
	expect(view.container.querySelectorAll(".machine-dropdown-check").length).toBe(4);
	expect(shortMachineName("Ada Mac mini")).toBe("Mac mini");
	expect(shortMachineName("Ada Server")).toBe("Server");
	expect(shortMachineName("Ada MacBook")).toBe("MacBook");
	setFleet(parseMachines([{ id: "server", name: "Ada Server", self: true }, { id: "other", name: "Other Mac" }]));
	expect(shortMachineName("Ada MacBook")).toBe("Ada MacBook");
	setFleet(fleet);
	expect(shortMachineName("Ada")).toBe("Ada");
	const name = mount();
	await name.render(<MachineName name="Ada MacBook" />);
	expect(text(name.container.querySelector(".machine-name-owner")!)).toBe("Ada");
});

test("D21 support: empty groups draw a heading and a muted note after the rows", async () => {
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: (row: { name: string }) => row.name }]}
			rows={[{ name: "a" }]}
			rowKey={row => row.name}
			group={() => ({ key: "server", label: "Server" })}
			emptyGroups={[{ key: "mini", label: "Mac mini", note: "No live sessions" }]}
		/>,
	);
	const rows = [...view.container.querySelectorAll("tbody tr")].map(row => text(row));
	expect(rows).toEqual(["Server", "a", "Mac mini", "No live sessions"]);
	expect(view.container.querySelector(".std-group-empty td")?.getAttribute("colspan")).toBe("1");
});

test("D20: a nested table in an expanded row does not widen the outer span", async () => {
	const view = mount();
	const inner = (
		<Table
			variant="std"
			columns={["x", "y", "z"].map(key => ({ key, header: key, render: () => key }))}
			rows={[{ id: 9 }]}
			rowKey={row => row.id}
		/>
	);
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "a", header: "A", render: (row: { id: number }) => row.id }]}
			rows={[{ id: 1 }]}
			rowKey={row => row.id}
			group={() => ({ key: "g", label: "Group" })}
			expanded={() => inner}
		/>,
	);
	expect(view.container.querySelector("tr.std-group th")?.getAttribute("colspan")).toBe("1");
	expect(view.container.querySelector("tr.std-detail td")?.getAttribute("colspan")).toBe("1");
});

test("D21 support: empty groups render even when there are no rows", async () => {
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: (row: { name: string }) => row.name }]}
			rows={[]}
			rowKey={row => row.name}
			empty="Nothing at all"
			emptyGroups={[
				{ key: "server", label: "Server", note: "No live sessions" },
				{ key: "mini", label: "Mac mini", note: "No live sessions" },
			]}
		/>,
	);
	expect([...view.container.querySelectorAll("tbody tr")].map(row => text(row))).toEqual([
		"Server",
		"No live sessions",
		"Mac mini",
		"No live sessions",
	]);
	expect(text(view.container)).not.toContain("Nothing at all");
});

test("D16: single-machine mode is live while the stream is open, however old the last sync", () => {
	const now = 1_000_000;
	expect(machineStreamState(true, now - 3 * 60_000, now)).toEqual({ kind: "live" });
	expect(machineStreamState(true, null, now)).toEqual({ kind: "live" });
	expect(machineStreamState(false, now - 3 * 60_000, now)).toEqual({ kind: "stale", ago: "3m ago" });
	expect(machineStreamState(false, null, now)).toEqual({ kind: "reconnecting" });
});

test("D16: a stream refused for too many tabs backs off 30 s and says why", async () => {
	vi.useFakeTimers();
	const sources: FakeSource[] = [];
	class FakeSource {
		readyState = 0;
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: (() => void) | null = null;
		constructor(readonly url: string) {
			sources.push(this);
		}
		close() {
			this.readyState = 2;
		}
	}
	const view = mount();
	installGlobal("EventSource", FakeSource);
	setFleet(fleet);
	const fetches: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		fetches.push(String(input));
		return Response.json({ error: "too many streams", code: "too_many_streams" }, { status: 503 });
	});
	let latest: Record<string, { connected: boolean; reason?: string | null }> = {};
	function Probe() {
		latest = useFleetStreams(fleet);
		return null;
	}
	try {
		await view.render(<Probe />);
		const mini = () => sources.filter(source => source.url.includes("/m/mini/"));
		expect(mini()).toHaveLength(1);
		await act(async () => {
			const source = mini()[0]!;
			source.readyState = 2;
			source.onerror?.();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(fetches.filter(url => url.includes("/m/mini/"))).toHaveLength(1);
		expect(latest.mini).toMatchObject({ connected: false, reason: TOO_MANY_STREAMS });
		expect(fleetLiveView(fleet, latest as never, Date.now()).title).toContain(
			"Ada Mac mini (too many dashboard tabs open; close some tabs)",
		);
		await act(async () => vi.advanceTimersByTime(29_000));
		expect(mini()).toHaveLength(1);
		await act(async () => vi.advanceTimersByTime(1_500));
		expect(mini()).toHaveLength(2);
		// The other machines were never touched.
		expect(sources.filter(source => !source.url.includes("/m/mini/"))).toHaveLength(2);
	} finally {
		vi.useRealTimers();
	}
});

test("D16: other refusals back off from 2 s doubling to 30 s", () => {
	expect(retryDelay("too_many_streams", 1)).toBe(30_000);
	expect([1, 2, 3, 4, 5, 6].map(n => retryDelay(null, n))).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("single-machine stream backs off when refused, recovers, and goes stale from the last event", async () => {
	const { LiveProvider, useLiveStatus } = await import("../src/client/data/live");
	vi.useFakeTimers();
	const sources: { url: string; readyState: number; onopen: (() => void) | null; onerror: (() => void) | null }[] = [];
	class FakeSource {
		readyState = 0;
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: (() => void) | null = null;
		constructor(readonly url: string) {
			sources.push(this);
		}
		close() {
			this.readyState = 2;
		}
	}
	const view = mount();
	installGlobal("EventSource", FakeSource);
	setFleet(fleet);
	selectMachine("macbook");
	let refusal: "too_many_streams" | "other" = "too_many_streams";
	vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
		refusal === "too_many_streams"
			? Response.json({ code: "too_many_streams" }, { status: 503 })
			: Response.json({ error: "bad gateway" }, { status: 502 }),
	);
	let status: ReturnType<typeof useLiveStatus> | undefined;
	function Probe() {
		status = useLiveStatus();
		return null;
	}
	const refuse = async () =>
		act(async () => {
			const source = sources.at(-1)!;
			source.readyState = 2;
			source.onerror?.();
			for (let i = 0; i < 4; i++) await Promise.resolve();
		});
	try {
		await view.render(
			<LiveProvider>
				<Probe />
			</LiveProvider>,
		);
		expect(sources.map(source => source.url)).toEqual(["/m/macbook/api/events"]);
		await act(async () => sources[0]!.onopen?.());
		const openedAt = Date.now();
		expect(status).toMatchObject({ connected: true, receivedAt: openedAt });
		expect(machineStreamState(status!.connected, status!.receivedAt, openedAt + 5 * 60_000)).toEqual({
			kind: "live",
		});

		await refuse();
		expect(status).toMatchObject({ connected: false, reason: TOO_MANY_STREAMS, receivedAt: openedAt });
		await act(async () => vi.advanceTimersByTime(29_000));
		expect(sources).toHaveLength(1);
		expect(machineStreamState(status!.connected, status!.receivedAt, Date.now())).toEqual({
			kind: "stale",
			ago: "just now",
		});
		await act(async () => vi.advanceTimersByTime(1_500));
		expect(sources).toHaveLength(2);

		// The reopened stream connects (resetting the back-off), then drops for another reason.
		await act(async () => sources[1]!.onopen?.());
		expect(status).toMatchObject({ connected: true, reason: null });
		refusal = "other";
		await refuse();
		expect(status?.reason).toBeNull();
		await act(async () => vi.advanceTimersByTime(1_900));
		expect(sources).toHaveLength(2);
		await act(async () => vi.advanceTimersByTime(200));
		expect(sources).toHaveLength(3);
		await refuse();
		await act(async () => vi.advanceTimersByTime(3_900));
		expect(sources).toHaveLength(3);
		await act(async () => vi.advanceTimersByTime(200));
		expect(sources).toHaveLength(4);

		await act(async () => sources[3]!.onopen?.());
		expect(status).toMatchObject({ connected: true, reason: null });
	} finally {
		vi.useRealTimers();
	}
});

for (const protocol of ["http:", "https:"] as const) {
	test(`All machines over ${protocol} ${protocol === "https:" ? "streams per machine" : "opens no streams and says Auto-refresh"}`, async () => {
		const { LiveChip, AUTO_REFRESH_TITLE } = await import("../src/client/app/LiveChip");
		const urls: string[] = [];
		class FakeSource {
			readyState = 0;
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: (() => void) | null = null;
			constructor(url: string) {
				urls.push(url);
			}
			close() {}
		}
		const view = mount();
		installGlobal("EventSource", FakeSource);
		installGlobal("location", { protocol, hash: "" });
		setFleet(fleet);
		selectMachine("*");
		await view.render(<LiveChip />);
		const chip = view.container.querySelector(".live-chip");
		if (protocol === "https:") {
			expect(urls).toEqual(["/m/server/api/events", "/m/macbook/api/events", "/m/mini/api/events"]);
			expect(text(chip!)).not.toContain("Auto-refresh");
		} else {
			expect(urls).toEqual([]);
			expect(text(chip!)).toBe("Auto-refresh");
			expect(chip?.getAttribute("title")).toBe(AUTO_REFRESH_TITLE);
		}
	});
}

function hangingProbe() {
	const signals: AbortSignal[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		(_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal as AbortSignal;
				signals.push(signal);
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			}),
	);
	return signals;
}

class ProbeSource {
	static made: ProbeSource[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: (() => void) | null = null;
	constructor(readonly url: string) {
		ProbeSource.made.push(this);
	}
	close() {
		this.readyState = 2;
	}
}

async function flush() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

for (const mode of ["single", "fleet"] as const) {
	test(`${mode}: a hanging refusal probe times out after 5 s and still schedules a 2 s retry`, async () => {
		const { LiveProvider } = await import("../src/client/data/live");
		vi.useFakeTimers();
		ProbeSource.made = [];
		const view = mount();
		installGlobal("EventSource", ProbeSource);
		setFleet(fleet);
		selectMachine(mode === "single" ? "macbook" : "*");
		const signals = hangingProbe();
		function Fleet() {
			useFleetStreams(fleet.filter(m => m.id === "macbook"));
			return null;
		}
		try {
			await view.render(mode === "single" ? <LiveProvider>{null}</LiveProvider> : <Fleet />);
			expect(ProbeSource.made).toHaveLength(1);
			await act(async () => {
				ProbeSource.made[0]!.readyState = 2;
				ProbeSource.made[0]!.onerror?.();
				await flush();
			});
			expect(signals).toHaveLength(1);
			await act(async () => {
				vi.advanceTimersByTime(4_900);
				await flush();
			});
			expect(signals[0]!.aborted).toBe(false);
			await act(async () => {
				vi.advanceTimersByTime(200);
				await flush();
			});
			expect(signals[0]!.aborted).toBe(true);
			expect(ProbeSource.made).toHaveLength(1);
			await act(async () => {
				vi.advanceTimersByTime(2_000);
				await flush();
			});
			expect(ProbeSource.made).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test(`${mode}: unmounting mid-probe aborts it and schedules nothing`, async () => {
		const { LiveProvider } = await import("../src/client/data/live");
		vi.useFakeTimers();
		ProbeSource.made = [];
		const view = mount();
		installGlobal("EventSource", ProbeSource);
		setFleet(fleet);
		selectMachine(mode === "single" ? "macbook" : "*");
		const signals = hangingProbe();
		function Fleet() {
			useFleetStreams(fleet.filter(m => m.id === "macbook"));
			return null;
		}
		try {
			await view.render(mode === "single" ? <LiveProvider>{null}</LiveProvider> : <Fleet />);
			await act(async () => {
				ProbeSource.made[0]!.readyState = 2;
				ProbeSource.made[0]!.onerror?.();
				await flush();
			});
			await view.render(null);
			await act(async () => flush());
			expect(signals[0]!.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
			await act(async () => {
				vi.advanceTimersByTime(60_000);
				await flush();
			});
			expect(ProbeSource.made).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
}

test("hub grace: ok with stale reads as last known, not live and not unreachable", async () => {
	const machines = parseMachines([
		{ id: "server", name: "Ada Server", self: true, ok: true },
		{ id: "macbook", name: "Ada MacBook", ok: true, stale: true, lastOkAt: Date.UTC(2026, 10, 18, 9, 5) },
	])!;
	expect(machines.map(m => [m.ok, m.stale])).toEqual([
		[true, false],
		[true, true],
	]);
	const view = mount();
	await view.render(<MachineCell name="MacBook" color="red" lastKnown since={machines[1]!.lastOkAt} />);
	const dot = view.container.querySelector(".std-unreachable");
	expect(dot?.getAttribute("data-state")).toBe("last-known");
	expect(dot?.getAttribute("aria-label")).toBe("last known as of 18 Nov at 14:05 PKT; reconnecting");
	const base = { error: null, ok: true, stale: true, outdated: false, lastKnown: true };
	expect(missingMachinesText([{ ...base, id: "macbook", name: "Ada MacBook" }])).toEqual([
		"Ada MacBook shows last known numbers while the hub reconnects.",
	]);
});

test("hub grace: last known wins in the banner even after a cached refresh times out", () => {
	expect(
		missingMachinesText([
			{
				id: "macbook",
				name: "Ada MacBook",
				ok: false,
				lastKnown: true,
				stale: true,
				error: "timeout",
				outdated: false,
			},
		]),
	).toEqual(["Ada MacBook shows last known numbers while the hub reconnects."]);
});

test("hub field names: staleSince for held machines; ok:false + stale is unreachable, never last known", () => {
	const machines = parseMachines([
		{ id: "server", name: "Ada Server", self: true, ok: true, stale: false, staleSince: null },
		{ id: "macbook", name: "Ada MacBook", ok: true, stale: true, staleSince: 1_763_456_700_000 },
		{ id: "mini", name: "Ada Mac mini", ok: false, stale: true, staleSince: 1_763_456_000_000 },
	])!;
	expect(machines.map(m => [m.id, m.ok, m.stale, m.staleSince])).toEqual([
		["server", true, false, null],
		["macbook", true, true, 1_763_456_700_000],
		["mini", false, false, null],
	]);
});

test("N10: refused again and again, the pill says Not live with the plain reason", () => {
	const now = 1_000_000;
	expect(machineStreamState(false, null, now, 1)).toEqual({ kind: "reconnecting" });
	expect(machineStreamState(false, null, now, 2)).toEqual({ kind: "not-live" });
	expect(machineStreamState(false, now - 60_000, now, 3)).toEqual({ kind: "not-live" });
	expect(machineStreamState(true, null, now, 5)).toEqual({ kind: "live" });
});

test("N10: Ada Server's stream refused for a version mismatch: Not live, never an endless Reconnecting", async () => {
	const { LiveProvider } = await import("../src/client/data/live");
	const { LiveChip } = await import("../src/client/app/LiveChip");
	vi.useFakeTimers();
	const sources: { readyState: number; onerror: (() => void) | null }[] = [];
	class FakeSource {
		readyState = 0;
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: (() => void) | null = null;
		constructor() {
			sources.push(this);
		}
		close() {
			this.readyState = 2;
		}
	}
	const view = mount();
	installGlobal("EventSource", FakeSource);
	setFleet(fleet);
	selectMachine("server");
	vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
		Response.json(
			{ error: "the stats port answered without the dashboard's proof; nothing was passed on" },
			{ status: 502 },
		)) as typeof fetch);
	const refuse = async () =>
		act(async () => {
			const source = sources.at(-1)!;
			source.readyState = 2;
			source.onerror?.();
			for (let i = 0; i < 6; i++) await Promise.resolve();
		});
	try {
		await view.render(
			<LiveProvider>
				<LiveChip />
			</LiveProvider>,
		);
		await refuse();
		expect(text(view.container)).toContain("Reconnecting");
		await act(async () => vi.advanceTimersByTime(2_100));
		await refuse();
		const chip = view.container.querySelector(".live-chip")!;
		expect(text(chip)).toBe("Not live");
		// Phones have no hover: a tap shows the reason under the pill.
		expect(view.container.querySelector(".live-chip-wrap")?.getAttribute("data-state")).toBe("not-live");
		await act(async () => (chip as unknown as HTMLButtonElement).click());
		expect(text(view.container.querySelector(".live-chip-why")!)).toContain(
			"Ada Server's stats server is a different version until it's updated",
		);
		expect(chip.getAttribute("title")).toBe(
			"Live updates unavailable: Ada Server's stats server is a different version until it's updated. Numbers on this page won't update by themselves; use Try again or reload. The live connection is retried in the background.",
		);
	} finally {
		vi.useRealTimers();
	}
});

test("Not live says honestly whether the page refreshes by itself", async () => {
	const { notLiveTitle } = await import("../src/client/app/LiveChip");
	const proof = "the stats port answered without the dashboard's proof; nothing was passed on";
	expect(notLiveTitle(null, proof, 15_000, "Ada Server")).toBe(
		"Live updates unavailable: Ada Server's stats server is a different version until it's updated. This page refreshes every 15 s. The live connection is retried in the background.",
	);
	// Never a bare "its": without a machine name it speaks of "the stats server".
	expect(notLiveTitle(null, proof, null)).toStartWith(
		"Live updates unavailable: the stats server is a different version until it's updated.",
	);
	expect(notLiveTitle(null, proof, null)).toContain(
		"Numbers on this page won't update by themselves; use Try again or reload",
	);
});

test("the page's polling interval comes from its enabled polling queries only", async () => {
	const { useQuery } = await import("../src/client/data/query");
	const { usePagePollMs } = await import("../src/client/data/page-polling");
	vi.spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({})) as typeof fetch);
	let pollMs: number | null = -1;
	function Page({ poll, enabled }: { poll?: number; enabled: boolean }) {
		useQuery(["poll-probe", poll ?? 0], async () => 1, { pollMs: poll, enabled });
		pollMs = usePagePollMs();
		return null;
	}
	const view = mount();
	await view.render(<Page enabled />);
	expect(pollMs).toBeNull();
	await view.render(<Page enabled poll={15_000} />);
	await view.render(<Page enabled poll={15_000} />);
	expect(pollMs).toBe(15_000);
	// A hidden, kept-alive page disables its queries: it no longer counts.
	await view.render(<Page enabled={false} poll={15_000} />);
	await view.render(<Page enabled={false} poll={15_000} />);
	expect(pollMs).toBeNull();
});

test("page polling: metadata queries that opt out never count", async () => {
	const { useQuery } = await import("../src/client/data/query");
	const { usePagePollMs } = await import("../src/client/data/page-polling");
	vi.spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({})) as typeof fetch);
	let pollMs: number | null = -1;
	function Page({ data }: { data: boolean }) {
		useQuery(["meta-probe"], async () => 1, { pollMs: 300_000, countsAsPagePolling: false });
		useQuery(["data-probe"], async () => 1, { pollMs: data ? 30_000 : undefined });
		pollMs = usePagePollMs();
		return null;
	}
	const view = mount();
	await view.render(<Page data={false} />);
	await view.render(<Page data={false} />);
	expect(pollMs).toBeNull();
	await view.render(<Page data />);
	await view.render(<Page data />);
	expect(pollMs).toBe(30_000);
});

test("page polling: a kept-but-hidden page's queries don't count", async () => {
	const { useQuery } = await import("../src/client/data/query");
	const { usePagePollMs } = await import("../src/client/data/page-polling");
	const { PageActiveContext } = await import("../src/client/data/page-active");
	vi.spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({})) as typeof fetch);
	let pollMs: number | null = -1;
	function Polling() {
		useQuery(["hidden-probe"], async () => 1, { pollMs: 15_000 });
		return null;
	}
	function Reader() {
		pollMs = usePagePollMs();
		return null;
	}
	const view = mount();
	const page = (visible: boolean) => (
		<>
			<PageActiveContext.Provider value={visible}>
				<Polling />
			</PageActiveContext.Provider>
			<Reader />
		</>
	);
	await view.render(page(false));
	await view.render(page(false));
	expect(pollMs).toBeNull();
	await view.render(page(true));
	await view.render(page(true));
	expect(pollMs).toBe(15_000);
});

test("Not live stays tappable even when the last status was syncing", async () => {
	const { LiveChip } = await import("../src/client/app/LiveChip");
	const live = await import("../src/client/data/live");
	vi.spyOn(live, "useLiveStatus").mockReturnValue({
		sync: { phase: "syncing", current: 1, total: 4, processed: 0, lastSyncedAt: null, error: null },
		indexingHours: 0,
		connected: false,
		receivedAt: null,
		reason: null,
		failures: 3,
		problem: "the stats port answered without the dashboard's proof; nothing was passed on",
		requestSync: () => {},
	});
	setFleet(fleet);
	selectMachine("server");
	const view = mount();
	await view.render(<LiveChip />);
	const chip = view.container.querySelector(".live-chip")!;
	expect(text(chip)).toBe("Not live");
	expect(chip.hasAttribute("disabled")).toBe(false);
	await act(async () => (chip as unknown as HTMLButtonElement).click());
	expect(view.container.querySelector(".live-chip-why")).not.toBeNull();
});
