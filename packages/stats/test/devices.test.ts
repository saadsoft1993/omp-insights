import { expect, it } from "bun:test";
import { resetFleetForTests, setFleet } from "../src/client/app/machine";
import { revokeFleetLinks } from "../src/client/data/devices";

it("targets the originating device or all fleet links on the selected node", async () => {
	const original = globalThis.fetch;
	const calls: { url: string; body: unknown; headers: Headers }[] = [];
	setFleet([
		{
			id: "node",
			name: "Node",
			self: false,
			ok: true,
			latencyMs: null,
			version: null,
			lastOkAt: null,
			dashboardUrl: null,
		},
	]);
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
		return Response.json({ revoked: 1, self: false });
	}) as typeof fetch;
	try {
		await revokeFleetLinks("node", "abcdef12");
		await revokeFleetLinks("node");
		expect(calls.map(({ url, body }) => ({ url, body }))).toEqual([
			{ url: "/m/node/api/hub/devices/revoke", body: { originDevice: "abcdef12" } },
			{ url: "/m/node/api/hub/devices/revoke", body: { fleetLinks: true } },
		]);
		expect(calls.every(call => call.headers.get("X-Omp-Hub") === "1")).toBe(true);
	} finally {
		globalThis.fetch = original;
		resetFleetForTests();
	}
});
