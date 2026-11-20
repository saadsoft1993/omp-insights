import { afterEach, expect, it } from "bun:test";
import {
	ALL_MACHINES,
	concreteMachine,
	fleetIds,
	isAllMachines,
	machinePath,
	parseMachines,
	reloadSelection,
	resetFleetForTests,
	selectMachine,
	selection,
	setFleet,
} from "../src/client/app/machine";
import { buildHash, parseHash } from "../src/client/data/useHashRoute";

afterEach(resetFleetForTests);

it("defaults to all machines and retains an explicit selection", () => {
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
	expect(selection()).toBe(ALL_MACHINES);
	expect(isAllMachines()).toBe(true);
	expect(concreteMachine()).toBeUndefined();
	expect(fleetIds()).toEqual(["server", "mini"]);
	selectMachine("mini");
	expect(concreteMachine()).toBe("mini");
	expect(machinePath("/api/events", "mini")).toBe("/m/mini/api/events");
});

it("persists and reloads the all-machines sentinel", () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		},
	});
	try {
		setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
		selectMachine(ALL_MACHINES);
		expect(values.get("omp.machine")).toBe("*");
		selectMachine("mini");
		values.set("omp.machine", "*");
		reloadSelection();
		expect(selection()).toBe("*");
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});

it("round trips a machine on any section", () => {
	const route = parseHash("#/jobs?range=24h&m=mini");
	expect(route.machine).toBe("mini");
	expect(parseHash(buildHash(route)).machine).toBe("mini");
});

it("requires an explicit machine for jobs and relay actions", async () => {
	const { hubFetch } = await import("../src/client/data/hub");
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
	for (const name of ["jobs/run", "jobs/restart", "relay/disconnect"]) {
		await expect(hubFetch(name)).rejects.toThrow("Pick a machine");
	}
});
