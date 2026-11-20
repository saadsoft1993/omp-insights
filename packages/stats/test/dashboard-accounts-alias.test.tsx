import { afterEach, expect, it, vi } from "bun:test";
import { Dashboard } from "../src/client/App";
import { parseMachines, resetFleetForTests, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { installGlobal, mount, settle, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});
for (const alias of ["providers", "connections"]) {
	it(`renders Accounts & quota for ${alias} bookmarks`, async () => {
		const view = mount();
		const location = { hash: `#/${alias}?range=7d&m=mini` };
		Object.defineProperty(window, "location", { configurable: true, value: location });
		installGlobal("history", {
			replaceState: (_: unknown, __: string, hash: string) => {
				location.hash = hash;
			},
			pushState: (_: unknown, __: string, hash: string) => {
				location.hash = hash;
			},
		});
		setFleet(
			parseMachines([
				{ id: "server", self: true, ok: true },
				{ id: "mini", ok: true },
			]),
		);
		const requests: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
			const url = String(input);
			requests.push(url);
			if (url.includes("/accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.endsWith("/version"))
				return Response.json({ hub: { commit: null, dirty: false, startedAt: 0 }, ui: null });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			if (url.includes("/stats/providers")) return Response.json({ providers: [], series: [], hourly: [] });
			if (url.includes("provider-windows")) return Response.json({ windowInsights: [], usageSeries: [] });
			if (url.includes("/connections")) return Response.json({ providers: [], login: null });
			return Response.json({});
		});
		await view.render(<Dashboard />);
		await settle();
		expect(view.container.querySelector("h1")?.textContent).toBe("Accounts & quota");
		expect(requests.some(url => url.includes("/m/mini/api/stats/accounts?range=7d"))).toBe(true);
		expect(requests.some(url => url.includes("/m/mini/api/hub/connections"))).toBe(true);
	});
}
