import { afterEach, expect, setSystemTime, test, vi } from "bun:test";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../../src/client/app/machine";
import { clearQueryCache } from "../../src/client/data/query-store";
import { ModelsRoute } from "../../src/client/routes/ModelsRoute";
import { mount, settle, unmount } from "../helpers/memory-dom";
import fixture from "./fixture-models.json";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	setSystemTime();
	resetFleetForTests();
	clearQueryCache();
});

test("Models page DOM stays unchanged for a selected machine", async () => {
	setSystemTime(new Date("2026-11-18T08:00:00Z"));
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", self: true, ok: true },
			{ id: "mini", ok: true },
		]),
	);
	selectMachine("server");
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(fixture.machines.server));
	await view.render(<ModelsRoute active range="24h" />);
	await settle();
	await settle();
	const table = view.container.querySelector(".table");
	expect(table).not.toBeNull();
	expect(table?.outerHTML).toMatchSnapshot();
});
