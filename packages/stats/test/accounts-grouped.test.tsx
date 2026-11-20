import { afterEach, expect, it, vi } from "bun:test";
import { AccountsRoute } from "../src/client/routes/AccountsRoute";
import { parseMachines, resetFleetForTests, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { resetFleetQueryForTests } from "../src/client/data/fleet-query";
import { mount, settle, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	resetFleetForTests();
	clearQueryCache();
	resetFleetQueryForTests();
	vi.restoreAllMocks();
});

it("shows each machine's accounts under all machines", async () => {
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", name: "Server", self: true, ok: true },
			{ id: "macbook", name: "MacBook", ok: true },
			{ id: "mini", name: "Mini", ok: true },
		]),
	);
	const ids = ["server", "macbook", "mini"];
	const connections = Object.fromEntries(
		await Promise.all(
			ids.map(async id => [
				id,
				await Bun.file(new URL(`./fixtures/accounts-fleet/connections-${id}.json`, import.meta.url)).json(),
			]),
		),
	);
	const stats = Object.fromEntries(
		await Promise.all(
			ids.map(async id => [
				id,
				await Bun.file(new URL(`./fixtures/accounts-fleet/stats-accounts-${id}.json`, import.meta.url)).json(),
			]),
		),
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		const id = /\/m\/(server|macbook|mini)\//.exec(url)?.[1] ?? "server";
		if (url.includes("/hub/connections")) return Response.json(connections[id]);
		if (url.includes("/stats/provider-windows")) return Response.json({ windowInsights: [], usageSeries: [] });
		if (url.includes("/stats/accounts/flow")) return Response.json({ series: [], points: [] });
		if (url.includes("/stats/accounts")) return Response.json(stats[id]);
		return Response.json({});
	});
	await view.render(<AccountsRoute active range="24h" />);
	await settle(100);
	const text = view.container.textContent ?? "";
	for (const name of ["Server", "MacBook", "Mini"]) expect(text).toContain(name);
	expect(text).not.toContain("Pick a machine");
	expect(view.container.querySelectorAll(".table--std tbody tr").length).toBeGreaterThan(3);
});

it("loads quota independently for every machine", async () => {
	const { QuotaCard } = await import("../src/client/routes/QuotaCard");
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", name: "Server", self: true, ok: true },
			{ id: "mini", name: "Mini", ok: true },
		]),
	);
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		urls.push(url);
		const label = url.includes("/m/mini/") ? "mini@example.com" : "server@example.com";
		return Response.json({
			generatedAt: Date.now(),
			cacheAgeMs: 0,
			cacheStale: false,
			source: "test",
			providers: {},
			accounts: [{ provider: "anthropic", label, state: "active", windows: [] }],
		});
	});
	await view.render(<QuotaCard active wide />);
	await settle(100);
	expect(urls).toContain("/m/server/api/hub/quota");
	expect(urls).toContain("/m/mini/api/hub/quota");
	expect(view.container.textContent).toContain("server@example.com");
	expect(view.container.textContent).toContain("mini@example.com");
});
