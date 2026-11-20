import { afterEach, describe, expect, it, vi } from "bun:test";
import { Dashboard } from "../src/client/App";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { all, click, installGlobal, mount, settle, text, unmount } from "./helpers/memory-dom";

const fleet = [
	{ id: "server", name: "Server test", self: true, ok: true },
	{ id: "mini", name: "Mini test", self: false, ok: true },
];

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

describe("dashboard all-machine routes", () => {
	for (const section of ["flow", "devices", "alerts"] as const) {
		it(`renders ${section} for both machines instead of the pick-machine notice`, async () => {
			const view = mount();
			const location = { hash: `#/${section}?range=24h&m=*` };
			Object.defineProperty(window, "location", { configurable: true, value: location });
			installGlobal("history", {
				replaceState: (_: unknown, __: string, hash: string) => {
					location.hash = hash;
				},
				pushState: (_: unknown, __: string, hash: string) => {
					location.hash = hash;
				},
			});
			setFleet(parseMachines(fleet));
			selectMachine("*");
			vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
				const url = String(input);
				if (url.endsWith("/version"))
					return Response.json({ hub: { commit: null, dirty: false, startedAt: 0 }, ui: null });
				if (url.endsWith("/model-flow"))
					return Response.json({
						path: "config.yml",
						revision: "1",
						models: [],
						roles: [
							{
								role: "plan",
								value: "test-model",
								model: "test-model",
								thinking: null,
								editable: true,
								usedBy: [],
							},
						],
					});
				if (url.endsWith("/devices"))
					return Response.json({ devices: [], scope: "tailnet", autoPair: false, canLink: false });
				if (url.endsWith("/alerts")) return Response.json({ enabled: false, topic: null });
				return Response.json({});
			});
			await view.render(<Dashboard />);
			await settle();
			await settle();
			const content = text(view.container);
			expect(content).not.toContain("Combined view coming; pick a machine");
			expect(content).toContain("Server test");
			expect(content).toContain("Mini test");
			if (section === "flow") {
				await click(view.container.querySelector('button[aria-haspopup="menu"][aria-label^="Actions for"]'));
				expect(text(view.container)).toContain("Apply Server test's value to all");
				expect(content).toContain("test-model");
			} else if (section === "devices") {
				// One status strip cell per machine above one table (grouped by machine once rows exist).
				expect(all(view.container, ".ops-strip > div small").map(node => text(node))).toEqual([
					"Server test",
					"Mini test",
				]);
				expect(content).toContain("Browsers paired with each machine's hub.");
			} else {
				// One channel row per machine in a single Channels table.
				expect(all(view.container, ".table--std")[0]?.querySelectorAll("tbody tr")).toHaveLength(2);
				expect(content).toContain("Each machine sends its own phone alerts");
			}
		});
	}
});

it("does not expose the legacy machine status strip", async () => {
	const view = mount();
	Object.defineProperty(window, "location", { configurable: true, value: { hash: "#/alerts?range=24h&m=*" } });
	installGlobal("history", { replaceState: () => {}, pushState: () => {} });
	setFleet(parseMachines(fleet));
	selectMachine("*");
	vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
		String(input).endsWith("/version")
			? Response.json({ hub: { commit: null, dirty: false, startedAt: 0 }, ui: null })
			: Response.json({ enabled: false, topic: null }),
	);
	await view.render(<Dashboard />);
	expect(view.container.querySelector('[aria-label="Machine status"]')).toBeNull();
});
