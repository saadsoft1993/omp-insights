import { expect, it } from "bun:test";
import { resetFleetForTests, setFleet, parseMachines } from "../src/client/app/machine";
import { disconnectHubViewer, getHubJobLogs, runHubJob } from "../src/client/data/hub";
import { ApiError } from "../src/client/api";
import { jobActionError } from "../src/client/routes/JobsRoute";

it("sends job and viewer actions to the row's machine with the expected body", async () => {
	const original = globalThis.fetch;
	const calls: { url: string; body: unknown }[] = [];
	setFleet(parseMachines([{ id: "server", self: true }, { id: "mini" }]));
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
		return Response.json({ ok: true });
	}) as typeof fetch;
	try {
		await runHubJob("mini", "run", "my.job", "my.job", true);
		await runHubJob("server", "restart", "other", "other", false);
		await getHubJobLogs("mini", "my.job");
		await disconnectHubViewer(
			"mini",
			{ room: "room", peer: 4, device8: "12345678", connectedAt: 0, ua: "browser" },
			true,
		);
		expect(calls).toEqual([
			{ url: "/m/mini/api/hub/jobs/run", body: { label: "my.job", confirm: "my.job", confirmImpact: true } },
			{ url: "/m/server/api/hub/jobs/restart", body: { label: "other", confirm: "other", confirmImpact: false } },
			{ url: "/m/mini/api/hub/jobs/logs?label=my.job", body: null },
			{
				url: "/m/mini/api/hub/relay/disconnect",
				body: { room: "room", peer: 4, device8: "12345678", unpair: true },
			},
		]);
	} finally {
		globalThis.fetch = original;
		resetFleetForTests();
	}
});

it("explains protected, unloaded and cooling-down jobs", () => {
	expect(jobActionError(new ApiError(403, "", "protected"))).toContain("herdr");
	expect(jobActionError(new ApiError(409, "", "disabled"))).toContain("disabled");
	expect(jobActionError(new ApiError(429, "", "retry in 12 seconds"))).toContain("12 seconds");
});
