import { afterEach, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseMachines, resetFleetForTests, setFleet } from "../src/client/app/machine";
import {
	FLEET_REQUEST_TIMEOUT_MS,
	type FleetQueryResult,
	updateStatsVersions,
	useFleetQuery,
} from "../src/client/data/fleet-query";

const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
function install(name: string, value: unknown) {
	originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
function mount() {
	const window = parseHTML('<html><body><div id="root"></div></body></html>').window;
	for (const name of ["window", "document", "navigator", "Node", "Element", "HTMLElement"] as const)
		install(name, name === "window" ? window : window[name]);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	root = createRoot(window.document.getElementById("root") as unknown as Element);
	return root;
}
afterEach(async () => {
	vi.useRealTimers();
	if (root) await act(async () => root?.unmount());
	root = undefined;
	resetFleetForTests();
	for (const [name, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originals.clear();
});

it("merges partial answers, skips down nodes and refetches only changed versions", async () => {
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }, { id: "macbook", ok: false }]));
	updateStatsVersions([
		{ id: "server", ok: true, version: 10 },
		{ id: "mini", ok: true, version: 10 },
	]);
	const calls: string[] = [];
	let result: FleetQueryResult<string> | undefined;
	function Probe() {
		result = useFleetQuery(
			["fleet-test-partial"],
			async id => {
				calls.push(id);
				if (id === "mini") throw new Error("offline");
				return id;
			},
			values => values.join(","),
		);
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe />);
		await Promise.resolve();
	});
	expect(result?.data).toBe("server");
	expect(result?.machines.find(m => m.id === "mini")?.error).toBe("offline");
	expect(result?.machines.find(m => m.id === "macbook")?.error).toBe("unreachable");
	expect(calls).toEqual(["server", "mini"]);
	calls.length = 0;
	await act(async () => {
		updateStatsVersions([
			{ id: "server", ok: true, version: 1 },
			{ id: "mini", ok: true, version: 10 },
		]);
		await Promise.resolve();
	});
	expect(calls).toEqual(["server"]);
});

it("times out a request even if its fetcher ignores the abort signal", async () => {
	vi.useFakeTimers();
	setFleet(parseMachines([{ id: "server", self: true }]));
	let error: string | null | undefined;
	let aborted = false;
	function Probe() {
		const result = useFleetQuery(
			["fleet-test-timeout"],
			async (_id, signal) => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				return await Promise.withResolvers<string>().promise;
			},
			values => values.join(","),
		);
		error = result.machines[0]?.error;
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe />);
	});
	await act(async () => {
		// Just short of the deadline (longer than the hub's own, N7): still waiting.
		vi.advanceTimersByTime(FLEET_REQUEST_TIMEOUT_MS - 1000);
		await Promise.resolve();
	});
	expect(aborted).toBe(false);
	await act(async () => {
		vi.advanceTimersByTime(1000);
		await Promise.resolve();
	});
	expect(aborted).toBe(true);
	expect(error).toBe("timeout");
}, 10000);

it("retries a failed machine after five seconds and recovers", async () => {
	vi.useFakeTimers();
	setFleet(parseMachines([{ id: "server", self: true }]));
	let calls = 0;
	let result: FleetQueryResult<string> | undefined;
	function Probe() {
		result = useFleetQuery(
			["retry-failure"],
			async () => {
				if (++calls === 1) throw new Error("temporary");
				return "recovered";
			},
			values => values.join(","),
		);
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe />);
		await Promise.resolve();
	});
	expect(result?.machines[0].error).toBe("temporary");
	await act(async () => {
		vi.advanceTimersByTime(5000);
		await Promise.resolve();
	});
	expect(result?.data).toBe("recovered");
	expect(result?.machines[0].error).toBeNull();
});

it("polls each reachable machine without waiting for a version change", async () => {
	vi.useFakeTimers();
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
	const calls: string[] = [];
	function Probe() {
		useFleetQuery(
			["poll-test"],
			async machine => {
				calls.push(machine);
				return machine;
			},
			values => values,
			{ pollMs: 2000 },
		);
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe />);
		await Promise.resolve();
	});
	expect(calls).toEqual(["server", "mini"]);
	await act(async () => {
		vi.advanceTimersByTime(2000);
		await Promise.resolve();
	});
	expect(calls).toEqual(["server", "mini", "server", "mini"]);
});

it("keeps errors separate across query keys", async () => {
	setFleet(parseMachines([{ id: "server", self: true }]));
	let result: FleetQueryResult<string> | undefined;
	const pending = Promise.withResolvers<string>();
	function Probe({ range }: { range: string }) {
		result = useFleetQuery(
			["range-isolation", range],
			async () => {
				if (range === "old") throw new Error("old error");
				return pending.promise;
			},
			values => values.join(","),
		);
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe range="old" />);
		await Promise.resolve();
	});
	expect(result?.machines[0].error).toBe("old error");
	await act(async () => {
		view.render(<Probe range="new" />);
		await Promise.resolve();
	});
	expect(result?.machines[0].error).toBeNull();
	await act(async () => {
		pending.resolve("new data");
		await Promise.resolve();
	});
	expect(result?.data).toBe("new data");
});

it("marks stats out of date only on a 404 or a version-less stats server", async () => {
	const { ApiError } = await import("../src/client/api");
	const { resetFleetQueryForTests } = await import("../src/client/data/fleet-query");
	resetFleetQueryForTests();
	setFleet(
		parseMachines([
			{ id: "server", self: true },
			{ id: "macbook" },
			{ id: "mini" },
			{ id: "old" },
			{ id: "down", ok: false },
		]),
	);
	updateStatsVersions([
		{ id: "server", ok: true, version: 3 },
		{ id: "macbook", ok: true, version: 3 },
		{ id: "mini", ok: true, version: 3 },
		{ id: "old", ok: true, version: null },
		{ id: "down", ok: false, version: null },
	]);
	let result: FleetQueryResult<string> | undefined;
	function Probe() {
		result = useFleetQuery(
			["fleet-test-outdated"],
			async id => {
				if (id === "server") throw new ApiError(404, "/api/stats/x", "not found");
				if (id === "macbook") throw new ApiError(503, "/api/stats/x", "stats unavailable");
				if (id === "mini") throw new Error("timeout");
				return id;
			},
			values => values.join(","),
		);
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe />);
		await Promise.resolve();
	});
	const outdated = Object.fromEntries(result?.machines.map(m => [m.id, m.outdated]) ?? []);
	expect(outdated).toEqual({ server: true, macbook: false, mini: false, old: true, down: false });
});

it("notifies subscribers when a stats server loses or regains its version", async () => {
	const { resetFleetQueryForTests } = await import("../src/client/data/fleet-query");
	resetFleetQueryForTests();
	setFleet(parseMachines([{ id: "server", self: true }]));
	updateStatsVersions([{ id: "server", ok: true, version: 4 }]);
	let renders = 0;
	let result: FleetQueryResult<string> | undefined;
	function Probe() {
		renders++;
		result = useFleetQuery(
			["fleet-test-versionless"],
			async id => id,
			values => values.join(","),
		);
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe />);
		await Promise.resolve();
	});
	expect(result?.machines[0]?.outdated).toBe(false);
	const before = renders;
	await act(async () => {
		updateStatsVersions([{ id: "server", ok: true, version: null }]);
		await Promise.resolve();
	});
	expect(renders).toBeGreaterThan(before);
	expect(result?.machines[0]?.outdated).toBe(true);
	const middle = renders;
	await act(async () => {
		updateStatsVersions([{ id: "server", ok: true, version: 4 }]);
		await Promise.resolve();
	});
	expect(renders).toBeGreaterThan(middle);
	expect(result?.machines[0]?.outdated).toBe(false);
});

it("reports a machine in the hub's grace period as last known, still ok", async () => {
	const { resetFleetQueryForTests } = await import("../src/client/data/fleet-query");
	resetFleetQueryForTests();
	setFleet(
		parseMachines([
			{ id: "server", self: true },
			{ id: "macbook", ok: true, stale: true },
			{ id: "mini", ok: false, stale: true },
		]),
	);
	let result: FleetQueryResult<string> | undefined;
	function Probe() {
		result = useFleetQuery(
			["fleet-test-grace"],
			async id => id,
			values => values.join(","),
		);
		return null;
	}
	const view = mount();
	await act(async () => {
		view.render(<Probe />);
		await Promise.resolve();
	});
	const macbook = result?.machines.find(m => m.id === "macbook");
	expect(macbook).toMatchObject({ ok: true, lastKnown: true, error: null });
	expect(result?.machines.find(m => m.id === "server")?.lastKnown).toBe(false);
	expect(result?.machines.find(m => m.id === "mini")).toMatchObject({
		ok: false,
		lastKnown: false,
		error: "unreachable",
	});
});
