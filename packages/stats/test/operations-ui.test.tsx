import { afterEach, describe, expect, it, vi } from "bun:test";
import { ALL_MACHINES, parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { AlertsRoute } from "../src/client/routes/AlertsRoute";
import { DevicesRoute } from "../src/client/routes/DevicesRoute";
import { JobsRoute } from "../src/client/routes/JobsRoute";
import { RelayRoute } from "../src/client/routes/RelayRoute";
import { all, byText, click, type Harness, isDisabled, mount, settle, text, type, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;
interface Call {
	url: string;
	method: string;
	body: unknown;
}

/** Two machines, server (self) and mini; every request is recorded and routed to `handler`. */
function fleet(selected: string, handler: Handler): Call[] {
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "mini", name: "Ada Mac mini", ok: true, dashboardUrl: "https://machine.example.com:8794/" },
		]),
	);
	selectMachine(selected);
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({
			url,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return handler(url, init) ?? Response.json({ error: `unexpected ${url}` }, { status: 404 });
	}) as typeof fetch);
	return calls;
}

const machineOf = (url: string) => (url.includes("/m/mini/") ? "mini" : "server");

function job(label: string, over: Record<string, unknown> = {}) {
	return {
		label,
		file: `${label}.service`,
		readable: true,
		note: null,
		schedule: "daily 06:00",
		status: "ok",
		exit: "last exit ok",
		pid: null,
		lastLogWrite: Date.now() - 60_000,
		kind: "scheduled",
		loaded: true,
		impact: null,
		nextRun: Date.now() + 3_600_000,
		...over,
	};
}

function version(caps: Record<string, boolean>) {
	return Response.json({ hub: { commit: "abc", dirty: false, startedAt: 0 }, ui: null, capabilities: caps });
}

const allCaps = { jobsActions: true, relayViewers: true, devicesLastSeen: true, alertsPerRule: true };

function jobsHandler(
	jobsFor: (machine: string) => unknown[],
	post: (url: string, body: unknown) => Response = () => Response.json({ outcome: "accepted" }),
	capsFor: (machine: string) => Record<string, boolean> = () => allCaps,
	logs: Response = Response.json({ stdout: "out", stderr: "", truncated: false }),
): Handler {
	return (url, init) => {
		if (init?.method === "POST") return post(url, JSON.parse(String(init.body)));
		if (url.endsWith("/version")) return version(capsFor(machineOf(url)));
		if (url.includes("/jobs/logs?")) return logs.clone();
		if (url.endsWith("/jobs")) return Response.json({ now: Date.now(), jobs: jobsFor(machineOf(url)), gaps: [] });
		return undefined;
	};
}

function dialog(body: Element): Element {
	const dialogs = all(body, '[role="dialog"]');
	const last = dialogs[dialogs.length - 1];
	if (!last) throw new Error("no dialog");
	return last;
}

async function runJob(h: Harness, label: string, machine: string, typed = label) {
	await click(h.container.querySelector(`button[aria-label="Run now ${label} on ${machine}"]`));
	await type(h.body.querySelector('input[aria-label="Job name"]'), typed);
	await click(byText(dialog(h.body), "button", "Run now"));
	await settle();
}

describe("Jobs page", () => {
	it("groups rows by machine under All machines in one table", async () => {
		fleet(
			ALL_MACHINES,
			jobsHandler(m => [job(`${m}.job`)]),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const groups = all(h.container, ".std-group").map(row => text(row));
		expect(groups).toHaveLength(2);
		expect(groups[0]).toContain("Ada Server");
		expect(groups[1]).toContain("Ada Mac mini");
		expect(all(h.container, ".table--std")).toHaveLength(1);
	});

	it("shows one ungrouped table with only that machine's rows when one machine is selected", async () => {
		const calls = fleet(
			"mini",
			jobsHandler(m => [job(`${m}.job`)]),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		expect(all(h.container, ".std-group")).toHaveLength(0);
		expect(text(h.container)).toContain("mini.job");
		expect(text(h.container)).not.toContain("server.job");
		expect(calls.some(c => c.url === "/m/server/api/hub/jobs")).toBe(false);
	});

	it("puts every failed job in a Needs attention group on the first page, ahead of the machines", async () => {
		fleet(
			ALL_MACHINES,
			jobsHandler(m =>
				m === "server"
					? Array.from({ length: 25 }, (_, i) => job(`server.job${String(i).padStart(2, "0")}`))
					: [job("mini.broken", { status: "failed", exit: "last exit 2" })],
			),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const groups = all(h.container, ".std-group").map(row => text(row));
		expect(groups[0]).toContain("Needs attention");
		expect(groups[0]).toContain("1 failed on 1 of 2 machines");
		const first = all(h.container, "tbody tr:not(.std-group)")[0] as Element;
		expect(text(first)).toContain("mini.broken");
		expect(text(first)).toContain("Mac mini");
		expect(first.getAttribute("data-pinned")).toBe("true");
	});

	it("keeps Run now disabled until the name the row shows is typed, and asks for the impact", async () => {
		const calls = fleet(
			"server",
			jobsHandler(() => [job("com.ada.backup", { impact: "Dumps the database; search slows for a minute." })]),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Run now com.ada.backup on Ada Server"]'));
		const confirm = () => byText(dialog(h.body), "button", "Run now");
		expect(text(dialog(h.body))).toContain("Run backup now on Ada Server?");
		expect(isDisabled(confirm())).toBe(true);
		expect(text(dialog(h.body))).toContain("Type backup to confirm · full label com.ada.backup");
		await type(h.body.querySelector('input[aria-label="Job name"]'), "backu");
		expect(isDisabled(confirm())).toBe(true);
		expect(text(dialog(h.body))).not.toContain("Doesn't match yet");
		await type(h.body.querySelector('input[aria-label="Job name"]'), "com.ada.backup");
		expect(isDisabled(confirm())).toBe(true);
		expect(text(dialog(h.body))).toContain("Doesn't match yet: type backup exactly.");
		await type(h.body.querySelector('input[aria-label="Job name"]'), "backup");
		expect(isDisabled(confirm())).toBe(true);
		expect(text(dialog(h.body))).toContain("I understand: Dumps the database");
		await click(h.body.querySelector('input[aria-label="I understand the impact"]'));
		expect(isDisabled(confirm())).toBe(false);
		await click(confirm());
		await settle();
		const post = calls.find(c => c.method === "POST");
		expect(post?.url).toBe("/m/server/api/hub/jobs/run");
		expect(post?.body).toEqual({ label: "com.ada.backup", confirm: "com.ada.backup", confirmImpact: true });
		expect(text(h.container)).toContain("Run of com.ada.backup accepted on Ada Server.");
	});

	it("restarts keep-running services and turns protected and unloaded jobs off with the reason", async () => {
		const calls = fleet(
			"mini",
			jobsHandler(() => [
				job("sms-prototype", { kind: "keepalive", schedule: "keep alive", status: "running", pid: 4 }),
				job("herdr-server", { kind: "keepalive", schedule: "keep alive", status: "running", pid: 5 }),
				job("old.job", { status: "not loaded", loaded: false, note: "disabled, enable it first" }),
			]),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const herdr = h.container.querySelector('button[aria-label="Restart herdr-server on Ada Mac mini"]');
		expect(isDisabled(herdr)).toBe(true);
		expect(herdr?.getAttribute("title")).toContain("Protected");
		const old = h.container.querySelector('button[aria-label="Run now old.job on Ada Mac mini"]');
		expect(isDisabled(old)).toBe(true);
		expect(old?.getAttribute("title")).toBe("Not loaded: disabled, enable it first");
		await click(h.container.querySelector('button[aria-label="Restart sms-prototype on Ada Mac mini"]'));
		await type(h.body.querySelector('input[aria-label="Job name"]'), "sms-prototype");
		await click(byText(dialog(h.body), "button", "Restart"));
		await settle();
		expect(calls.find(c => c.method === "POST")?.url).toBe("/m/mini/api/hub/jobs/restart");
	});

	const errors: [number, string, string][] = [
		[
			403,
			"this job cannot be controlled from the dashboard",
			"Protected on Ada Mac mini: this job cannot be controlled from the dashboard.",
		],
		[409, "disabled, enable it first", "Not loaded or disabled on Ada Mac mini: disabled, enable it first."],
		[429, "try again in 12 seconds", "Cooling down on Ada Mac mini: try again in 12 seconds."],
		[404, "job not found", "Not found on Ada Mac mini: job not found. The list was refreshed."],
		[502, "job action failed", "The command failed on Ada Mac mini: job action failed."],
	];
	for (const [status, message, shown] of errors)
		it(`maps a ${status} answer to a plain explanation in the dialog`, async () => {
			const calls = fleet(
				ALL_MACHINES,
				jobsHandler(
					m => [job(`${m}.job`)],
					() => Response.json({ error: message }, { status }),
				),
			);
			const h = mount();
			await h.render(<JobsRoute active />);
			await settle();
			const before = calls.filter(c => c.url === "/m/mini/api/hub/jobs").length;
			await runJob(h, "mini.job", "Ada Mac mini");
			expect(calls.filter(c => c.method === "POST").map(c => c.url)).toEqual(["/m/mini/api/hub/jobs/run"]);
			const alert = dialog(h.body).querySelector('[role="alert"]');
			expect(text(alert as Element)).toContain(shown);
			if (status === 404) expect(calls.filter(c => c.url === "/m/mini/api/hub/jobs").length).toBeGreaterThan(before);
		});

	it("hides actions on a machine whose hub lacks jobsActions and says to update it", async () => {
		fleet(
			ALL_MACHINES,
			jobsHandler(
				m => [job(`${m}.job`)],
				undefined,
				m => (m === "mini" ? {} : allCaps),
			),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		expect(h.container.querySelector('button[aria-label="Run now server.job on Ada Server"]')).not.toBeNull();
		expect(h.container.querySelector('button[aria-label="Run now mini.job on Ada Mac mini"]')).toBeNull();
		expect(h.container.querySelector('button[aria-label="Logs of mini.job on Ada Mac mini"]')).toBeNull();
		const miniGroup = all(h.container, ".std-group").find(row => text(row).includes("Ada Mac mini"));
		expect(text(miniGroup as Element)).toContain("Update the hub on Ada Mac mini to run jobs and read their logs.");
	});

	it("shows the update hint above the table when one machine is selected", async () => {
		fleet(
			"mini",
			jobsHandler(
				m => [job(`${m}.job`)],
				undefined,
				() => ({}),
			),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		expect(text(h.container)).toContain("Update the hub on Ada Mac mini to run jobs and read their logs.");
		expect(byText(h.container, "button", "Run now")).toBeNull();
	});

	it("opens the Logs drawer for the row's machine, with the truncated note and the journal", async () => {
		const calls = fleet(
			ALL_MACHINES,
			jobsHandler(
				m => [job(`${m}.job`)],
				undefined,
				undefined,
				Response.json({ journal: "line one\nline two", truncated: true }),
			),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Logs of mini.job on Ada Mac mini"]'));
		await settle();
		expect(calls.some(c => c.url === "/m/mini/api/hub/jobs/logs?label=mini.job")).toBe(true);
		const drawer = dialog(h.body);
		expect(text(drawer)).toContain("Logs · mini.job");
		expect(text(drawer)).toContain("mini.job on Ada Mac mini");
		expect(text(drawer)).toContain("Truncated: only the newest part of the log is shown.");
		expect(text(drawer)).toContain("Journal");
		expect(drawer.querySelector("pre")?.textContent).toBe("line one\nline two");
		const before = calls.filter(c => c.url.includes("/jobs/logs?")).length;
		await click(byText(drawer, "button", "Refresh"));
		await settle();
		expect(calls.filter(c => c.url.includes("/jobs/logs?")).length).toBeGreaterThan(before);
	});

	it("shows stdout and stderr without a truncated note for launchd logs", async () => {
		fleet(
			"server",
			jobsHandler(
				() => [job("a.job")],
				undefined,
				undefined,
				Response.json({ stdout: "hello", stderr: "", truncated: false }),
			),
		);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Logs of a.job on Ada Server"]'));
		await settle();
		const drawer = dialog(h.body);
		expect(all(drawer, "h3").map(el => el.textContent)).toEqual(["stdout", "stderr"]);
		expect(all(drawer, "pre").map(el => el.textContent)).toEqual(["hello", "No output"]);
		expect(text(drawer)).not.toContain("Truncated");
	});

	it("keeps the other machine's rows and says which one did not answer", async () => {
		fleet(ALL_MACHINES, (url, init) => {
			if (url === "/m/mini/api/hub/jobs") return Response.json({ error: "machine unreachable" }, { status: 502 });
			return jobsHandler(m => [job(`${m}.job`)])(url, init);
		});
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		expect(text(h.container)).toContain("Ada Mac mini didn't answer the jobs list: it's unreachable.");
		expect(text(h.container)).not.toContain("machine unreachable");
		expect(h.container.querySelector(".ops-problem span")?.getAttribute("title")).toBe("machine unreachable");
		expect(text(h.container)).toContain("server.job");
	});
});

const viewer = (machine: string, over: Record<string, unknown> = {}) => ({
	room: `room-${machine}`,
	peer: 7,
	device8: machine === "mini" ? "aaaaaaaa" : "bbbbbbbb",
	connectedAt: Date.now() - 60_000,
	ua: "Mozilla/5.0 (iPad; CPU OS 27_2_0 like Mac OS X) AppleWebKit/605.1.15",
	...over,
});

function relayHandler(
	relayFor: (machine: string) => Record<string, unknown>,
	post: (url: string, body: unknown) => Response = () => Response.json({ ok: true }),
	capsFor: (machine: string) => Record<string, boolean> = () => allCaps,
): Handler {
	return (url, init) => {
		if (init?.method === "POST") return post(url, JSON.parse(String(init.body)));
		if (url.endsWith("/version")) return version(capsFor(machineOf(url)));
		if (url.endsWith("/relay"))
			return Response.json({
				ok: true,
				error: null,
				rooms: 1,
				guests: 1,
				uptime_s: 3600,
				build: "v18.19.0 (bun 1.4.4)",
				needsUpdate: false,
				canUnpair: true,
				viewers: [viewer(machineOf(url))],
				...relayFor(machineOf(url)),
			});
		return undefined;
	};
}

describe("Relay page", () => {
	it("lists relays one row per machine and groups viewers by machine", async () => {
		fleet(
			ALL_MACHINES,
			relayHandler(() => ({})),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		const tables = all(h.container, ".table--std");
		expect(tables).toHaveLength(2);
		expect(all(tables[0], ".std-group")).toHaveLength(0);
		const groups = all(tables[1], ".std-group").map(row => text(row));
		expect(groups).toHaveLength(2);
		expect(groups[0]).toContain("Ada Server");
		expect(groups[1]).toContain("Ada Mac mini");
		expect(text(h.container)).toContain(
			"Disconnect is a soft kick; reloading rejoins. Only Disconnect and unpair revokes access.",
		);
	});

	it("disconnects and unpairs on the row's machine with the viewer's identity", async () => {
		const calls = fleet(
			ALL_MACHINES,
			relayHandler(() => ({})),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Disconnect and unpair aaaaaaaa on Ada Mac mini"]'));
		expect(text(dialog(h.body))).toContain("loses its pairing with Ada Mac mini");
		await click(byText(dialog(h.body), "button", "Disconnect and unpair"));
		await settle();
		await click(h.container.querySelector('button[aria-label="Disconnect bbbbbbbb on Ada Server"]'));
		await click(byText(dialog(h.body), "button", "Disconnect"));
		await settle();
		expect(calls.filter(c => c.method === "POST")).toEqual([
			{
				url: "/m/mini/api/hub/relay/disconnect",
				method: "POST",
				body: { room: "room-mini", peer: 7, device8: "aaaaaaaa", unpair: true },
			},
			{
				url: "/m/server/api/hub/relay/disconnect",
				method: "POST",
				body: { room: "room-server", peer: 7, device8: "bbbbbbbb", unpair: false },
			},
		]);
		expect(text(h.container)).toContain("Disconnected bbbbbbbb on Ada Server. Reloading its tab rejoins.");
	});

	it("says the viewer already left or changed on a 409 and refreshes the list", async () => {
		const calls = fleet(
			"mini",
			relayHandler(
				() => ({}),
				() => Response.json({ error: "viewer already left or changed" }, { status: 409 }),
			),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		const before = calls.filter(c => c.url === "/m/mini/api/hub/relay").length;
		await click(h.container.querySelector('button[aria-label="Disconnect aaaaaaaa on Ada Mac mini"]'));
		await click(byText(dialog(h.body), "button", "Disconnect"));
		await settle();
		expect(text(dialog(h.body).querySelector('[role="alert"]') as Element)).toContain(
			"The viewer already left or changed. The list was refreshed.",
		);
		expect(calls.filter(c => c.url === "/m/mini/api/hub/relay").length).toBeGreaterThan(before);
	});

	it("points to omp-private-relay revoke when the relay refuses to unpair", async () => {
		fleet(
			"mini",
			relayHandler(
				() => ({}),
				() =>
					Response.json(
						{ error: "relay uses a different pairing store; use omp-private-relay revoke" },
						{ status: 409 },
					),
			),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Disconnect and unpair aaaaaaaa on Ada Mac mini"]'));
		await click(byText(dialog(h.body), "button", "Disconnect and unpair"));
		await settle();
		expect(text(dialog(h.body).querySelector('[role="alert"]') as Element)).toContain(
			"Not unpaired: the relay on Ada Mac mini keeps its own pairings. Run omp-private-relay revoke on Ada Mac mini",
		);
	});

	it("does not offer unpair when canUnpair is false and points to omp-private-relay revoke", async () => {
		fleet(
			ALL_MACHINES,
			relayHandler(m => (m === "mini" ? { canUnpair: false } : {})),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		expect(h.container.querySelector('button[aria-label="Disconnect aaaaaaaa on Ada Mac mini"]')).not.toBeNull();
		expect(
			h.container.querySelector('button[aria-label="Disconnect and unpair aaaaaaaa on Ada Mac mini"]'),
		).toBeNull();
		expect(
			h.container.querySelector('button[aria-label="Disconnect and unpair bbbbbbbb on Ada Server"]'),
		).not.toBeNull();
		expect(text(h.container)).toContain(
			"Ada Mac mini: the relay keeps its own pairings, so Disconnect and unpair is off. Run omp-private-relay revoke there to revoke a browser.",
		);
	});

	it("shows the relay's rebuild reason and dashboard update hint when the hub lacks rebuild support", async () => {
		fleet(
			ALL_MACHINES,
			relayHandler(
				m =>
					m === "mini"
						? {
								ok: false,
								needsUpdate: true,
								viewers: null,
								error: "relay web client predates Disconnect; rebuild it",
							}
						: {},
				undefined,
				// The hub derives relayViewers from the relay's own viewers2: outdated relay, so false.
				m => (m === "mini" ? { ...allCaps, relayViewers: false } : allCaps),
			),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		expect(text(h.container)).toContain(
			"Ada Mac mini: its relay web client predates Disconnect: rebuild it with omp-private-relay rebuild-web, then restart the relay.",
		);
		expect(text(h.container)).toContain("its web client needs a rebuild");
		expect(
			h.container.querySelector('.ops-pc-sub[title="relay web client predates Disconnect; rebuild it"]'),
		).not.toBeNull();
		expect(text(h.container)).toContain("Update the hub on Ada Mac mini to rebuild the relay web client from here.");
		expect(h.container.querySelector('button[aria-label="Disconnect aaaaaaaa on Ada Mac mini"]')).toBeNull();
	});

	it("says to update the relay when it lacks viewers2 without a rebuild reason", async () => {
		fleet(
			"mini",
			relayHandler(
				() => ({ needsUpdate: true, viewers: null }),
				undefined,
				() => ({ ...allCaps, relayViewers: false }),
			),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		expect(text(h.container)).toContain("Ada Mac mini: its relay needs an update to list and disconnect viewers.");
		expect(text(h.container)).not.toContain("Update the hub");
	});

	it("says to update the hub only when the hub predates the viewer list", async () => {
		fleet(
			ALL_MACHINES,
			relayHandler(
				// An older hub: no viewer fields at all, and no relayViewers capability.
				m => (m === "mini" ? { needsUpdate: undefined, canUnpair: undefined, viewers: undefined } : {}),
				undefined,
				m => (m === "mini" ? {} : allCaps),
			),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		expect(text(h.container)).toContain("Update the hub on Ada Mac mini to list and disconnect viewers.");
		expect(h.container.querySelector('button[aria-label="Disconnect aaaaaaaa on Ada Mac mini"]')).toBeNull();
		expect(h.container.querySelector('button[aria-label="Disconnect bbbbbbbb on Ada Server"]')).not.toBeNull();
	});

	it("shows a machine whose refresh failed as not answering, never Running from the cached reading", async () => {
		let miniDown = false;
		fleet(ALL_MACHINES, (url, init) => {
			if (miniDown && url === "/m/mini/api/hub/relay")
				return Response.json({ error: "machine unreachable" }, { status: 502 });
			return relayHandler(() => ({}))(url, init);
		});
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		const miniRow = () =>
			all(all(h.container, ".table--std")[0], "tbody tr").find(row => text(row).includes("Mac mini")) as Element;
		expect(text(miniRow())).toContain("Running");
		miniDown = true;
		await click(h.container.querySelector('button[aria-label="Disconnect bbbbbbbb on Ada Server"]'));
		await click(byText(dialog(h.body), "button", "Disconnect"));
		await settle();
		expect(text(miniRow())).toContain("Didn't answer");
		expect(text(miniRow())).toContain("it's unreachable");
		expect(text(miniRow())).not.toContain("machine unreachable");
		expect(miniRow().querySelector('.ops-pc-sub[title="machine unreachable"]')).not.toBeNull();
		expect(text(miniRow())).not.toContain("Running");
		expect(miniRow().getAttribute("data-stale")).toBe("true");
	});

	it("words the hub's relay problems plainly and keeps its own text, with the fix, in the tooltip", async () => {
		const raw = "web UI not built: run omp_relay/build.sh; relay does not know the owner yet: is Tailscale up?";
		fleet(
			ALL_MACHINES,
			relayHandler(m =>
				m === "mini"
					? { ok: false, error: raw }
					: { ok: false, error: "relay not reachable (ConnectionRefusedError); see omp_relay/README.md" },
			),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		const row = (name: string) =>
			all(all(h.container, ".table--std")[0], "tbody tr").find(r => text(r).includes(name)) as Element;
		expect(text(row("Mac mini"))).toContain(
			"its web page isn't built yet; it doesn't know the owner yet (is Tailscale up?)",
		);
		expect(text(row("Mac mini"))).not.toContain("omp_relay/build.sh");
		expect(row("Mac mini").querySelector(".ops-pc-sub")?.getAttribute("title")).toBe(raw);
		expect(text(row("Server"))).toContain("the relay isn't answering");
		expect(text(row("Server"))).not.toContain("ConnectionRefusedError");
	});

	it("labels the relay numbers for the phone layout", async () => {
		fleet(
			"server",
			relayHandler(() => ({})),
		);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		const labels = all(h.container, ".ops-phone-label").map(node => node.textContent?.trim());
		expect(labels).toEqual(["rooms", "viewers", "up"]);
	});
});

function devicesHandler(capsFor: (machine: string) => Record<string, boolean> = () => allCaps): Handler {
	return (url, init) => {
		if (init?.method === "POST") return Response.json({ revoked: 1, self: false });
		if (url.endsWith("/version")) return version(capsFor(machineOf(url)));
		if (url.endsWith("/devices")) {
			const m = machineOf(url);
			return Response.json({
				devices: [
					{
						id: m === "mini" ? "cccccccc" : "dddddddd",
						scope: "tailnet",
						label: `${m} browser`,
						pairedAt: Date.now() - 3_600_000,
						expiresAt: null,
						auto: false,
						current: false,
						lastSeen: Date.now() - 600_000,
						source: m === "mini" ? "fleet-link" : null,
						originDevice: m === "mini" ? "dddddddd" : null,
					},
				],
				autoPair: m === "server",
				scope: "tailnet",
				canLink: true,
			});
		}
		return undefined;
	};
}

describe("Devices page", () => {
	it("shows the per-machine strip, one grouped table, and the node's fleet-link action", async () => {
		const calls = fleet(ALL_MACHINES, devicesHandler());
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		const strip = all(h.container, ".ops-strip > div").map(cell => text(cell));
		expect(strip).toEqual(["Ada ServerAuto-pair on · 1 paired", "Ada Mac miniAuto-pair off · 1 paired"]);
		expect(all(h.container, ".table--std")).toHaveLength(1);
		const groups = all(h.container, ".std-group");
		expect(groups).toHaveLength(2);
		expect(byText(groups[0], "button", "Unpair fleet links")).toBeNull();
		await click(byText(groups[1], "button", "Unpair fleet links…"));
		expect(text(dialog(h.body))).toContain("Unpair all fleet links on Ada Mac mini?");
		await click(byText(dialog(h.body), "button", "Unpair"));
		await settle();
		expect(calls.filter(c => c.method === "POST")).toEqual([
			{ url: "/m/mini/api/hub/devices/revoke", method: "POST", body: { fleetLinks: true } },
		]);
	});

	it("also removes a server browser's fleet links on the nodes when asked", async () => {
		const calls = fleet(ALL_MACHINES, devicesHandler());
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Unpair dddddddd on Ada Server"]'));
		expect(text(dialog(h.body))).toContain("Also unpair the fleet links it made on Ada Mac mini (1 listed)");
		await click(dialog(h.body).querySelector('input[type="checkbox"]'));
		await click(byText(dialog(h.body), "button", "Unpair"));
		await settle();
		expect(calls.filter(c => c.method === "POST")).toEqual([
			{ url: "/m/mini/api/hub/devices/revoke", method: "POST", body: { originDevice: "dddddddd" } },
			{ url: "/m/server/api/hub/devices/revoke", method: "POST", body: { id: "dddddddd" } },
		]);
		expect(text(h.container)).toContain("Unpaired 2 browsers on Ada Server.");
	});

	it("pairs with this dashboard's hub even with a node picked, and never links to a node's dashboard", async () => {
		const calls = fleet("mini", (url, init) =>
			url === "/api/hub/devices/link"
				? Response.json({ url: "https://server.example/#pair=x", expiresAt: Date.now() + 300_000 })
				: url === "/api/hub/devices"
					? Response.json({ devices: [], autoPair: false, scope: "tailnet", canLink: true })
					: devicesHandler()(url, init),
		);
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(byText(h.container, "button", "Pair a new browser"));
		await settle();
		const box = dialog(h.body);
		expect(text(box)).toContain("Pair a new browser with Ada Server");
		expect(text(box)).toContain("One pairing covers Ada Mac mini too: they are managed from this dashboard.");
		expect(all(box, "a")).toHaveLength(0);
		expect(text(box)).not.toContain("dashboard.example");
		await click(byText(box, "button", "Create pairing link"));
		await settle();
		expect(calls.filter(c => c.method === "POST").map(c => c.url)).toEqual(["/api/hub/devices/link"]);
	});

	it("says why no pairing link can be made when the hub has no Tailscale name", async () => {
		fleet(ALL_MACHINES, (url, init) =>
			url === "/api/hub/devices"
				? Response.json({ devices: [], autoPair: false, scope: "tailnet", canLink: false })
				: devicesHandler()(url, init),
		);
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(byText(h.container, "button", "Pair a new browser"));
		await settle();
		const box = dialog(h.body);
		expect(text(box)).toContain("This hub has no Tailscale name, so no link can be made here.");
		expect(text(box)).not.toContain("not running");
		expect(isDisabled(byText(box, "button", "Create pairing link"))).toBe(true);
	});

	it("pairs with this hub from the dialog under All machines", async () => {
		const calls = fleet(ALL_MACHINES, (url, init) =>
			url === "/api/hub/devices/link"
				? Response.json({ url: "https://server.example/#pair=x", expiresAt: Date.now() + 300_000 })
				: url === "/api/hub/devices"
					? Response.json({ devices: [], autoPair: false, scope: "tailnet", canLink: true })
					: devicesHandler()(url, init),
		);
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(byText(h.container, "button", "Pair a new browser"));
		await settle();
		expect(text(dialog(h.body))).toContain("Pair a new browser with Ada Server");
		await click(byText(dialog(h.body), "button", "Create pairing link"));
		await settle();
		expect(calls.filter(c => c.method === "POST").map(c => c.url)).toEqual(["/api/hub/devices/link"]);
	});

	it("cleans up fleet links on every configured node even when only the server is selected", async () => {
		const calls = fleet("server", devicesHandler());
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Unpair dddddddd on Ada Server"]'));
		expect(text(dialog(h.body))).toContain("Also unpair the fleet links it made on Ada Mac mini");
		await click(dialog(h.body).querySelector('input[type="checkbox"]'));
		await click(byText(dialog(h.body), "button", "Unpair"));
		await settle();
		expect(calls.filter(c => c.method === "POST").map(c => c.url)).toEqual([
			"/m/mini/api/hub/devices/revoke",
			"/m/server/api/hub/devices/revoke",
		]);
	});

	it("shows a machine whose refresh failed as not answering in the strip", async () => {
		let miniDown = false;
		fleet(ALL_MACHINES, (url, init) => {
			if (miniDown && url === "/m/mini/api/hub/devices")
				return Response.json({ error: "machine unreachable" }, { status: 502 });
			return devicesHandler()(url, init);
		});
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		miniDown = true;
		await click(h.container.querySelector('button[aria-label="Unpair dddddddd on Ada Server"]'));
		await click(byText(dialog(h.body), "button", "Unpair"));
		await settle();
		const strip = all(h.container, ".ops-strip > div").map(cell => text(cell));
		expect(strip[1]).toBe("Ada Mac miniDidn't answer");
		const mini = all(h.container, "tbody tr").find(row => text(row).includes("mini browser"));
		expect(mini?.getAttribute("data-stale")).toBe("true");
	});

	it("hides last seen and says to update the hub when it lacks devicesLastSeen", async () => {
		fleet(
			ALL_MACHINES,
			devicesHandler(m => (m === "mini" ? {} : allCaps)),
		);
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		expect(text(h.container)).toContain("Update the hub on Ada Mac mini to see when its browsers were last seen.");
		const mini = all(h.container, "tbody tr").find(row => text(row).includes("mini browser"));
		const server = all(h.container, "tbody tr").find(row => text(row).includes("server browser"));
		expect(text(mini as Element)).not.toContain("10 min ago");
		expect(text(server as Element)).toContain("10 min ago");
	});
});

function alertsHandler(
	capsFor: (machine: string) => Record<string, boolean> = () => allCaps,
	over: (machine: string) => Record<string, unknown> = () => ({}),
): Handler {
	return (url, init) => {
		if (init?.method === "POST") return Response.json({ ok: true });
		if (url.endsWith("/version")) return version(capsFor(machineOf(url)));
		if (url.endsWith("/alerts")) {
			const m = machineOf(url);
			return Response.json({
				enabled: true,
				server: "https://ntfy.sh",
				topic: `omp-${m}-secret-topic`,
				sent: m === "server" ? 4 : 1,
				last_sent_at: null,
				last_error: null,
				watchOkAt: Date.now() - 30_000,
				rules: {
					needs_input: {
						lastFiredAt: m === "server" ? Date.now() - 7_200_000 : null,
						sent: m === "server" ? 3 : 0,
					},
					finished: { lastFiredAt: null, sent: 0 },
					gap: { lastFiredAt: null, sent: 0 },
				},
				...over(m),
			});
		}
		return undefined;
	};
}

describe("Alerts page", () => {
	it("lists one channel per machine with a masked topic and sends the test from each row's machine", async () => {
		const calls = fleet(ALL_MACHINES, alertsHandler());
		const h = mount();
		await h.render(<AlertsRoute active />);
		await settle();
		expect(text(h.container)).toContain("ntfy · omp-mini…");
		expect(text(h.container)).not.toContain("secret-topic");
		for (const [id, name] of [
			["mini", "Ada Mac mini"],
			["server", "Ada Server"],
		]) {
			await click(h.container.querySelector(`button[aria-label="Send test alert from ${name}"]`));
			await settle();
			expect(calls.filter(c => c.method === "POST").map(c => c.url)).toContain(`/m/${id}/api/hub/alerts/test`);
		}
		const rules = all(h.container, ".table--std")[1];
		const needs = all(rules, "tbody tr").find(row => text(row).includes("Session needs you"));
		expect(text(needs as Element)).toMatch(/\[Ada Server\] \S+ needs you/);
		expect(text(needs as Element)).toContain("3");
		expect(text(needs as Element)).toContain("2 h ago");
	});

	it("words a failing channel and a machine that didn't answer plainly, raw text in the tooltip", async () => {
		const sendError = "sending alert: HTTPError: HTTP Error 403: Forbidden";
		fleet(ALL_MACHINES, (url, init) =>
			url === "/m/mini/api/hub/alerts"
				? Response.json({ error: "no answer in time" }, { status: 502 })
				: alertsHandler(undefined, m => (m === "server" ? { last_error: sendError } : {}))(url, init),
		);
		const h = mount();
		await h.render(<AlertsRoute active />);
		await settle();
		const channels = all(h.container, ".table--std")[0];
		const row = (name: string) => all(channels, "tbody tr").find(r => text(r).includes(name)) as Element;
		expect(text(row("Server"))).toContain("the last alert didn't send");
		expect(text(row("Server"))).not.toContain("403");
		expect(row("Server").querySelector(`.ops-pc-sub[title="${sendError}"]`)).not.toBeNull();
		expect(text(row("Mac mini"))).toContain("it didn't answer in time");
		expect(row("Mac mini").querySelector('.ops-pc-sub[title="no answer in time"]')).not.toBeNull();
	});

	it("never shows the full topic when the browser blocks the clipboard", async () => {
		fleet("mini", alertsHandler());
		const h = mount();
		Object.defineProperty(globalThis.navigator, "clipboard", {
			configurable: true,
			value: { writeText: () => Promise.reject(new Error("denied")) },
		});
		await h.render(<AlertsRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Copy Ada Mac mini\'s topic"]'));
		await settle();
		expect(text(h.container)).toContain("Couldn't copy: the browser blocked the clipboard.");
		expect(text(h.container)).not.toContain("secret-topic");
	});

	it("counts rule history from machines whose alerts are now off", async () => {
		fleet(ALL_MACHINES, (url, init) => {
			if (url === "/m/mini/api/hub/alerts")
				return Response.json({
					enabled: false,
					server: "https://ntfy.sh",
					topic: null,
					sent: 0,
					last_sent_at: null,
					last_error: null,
					rules: {
						needs_input: { lastFiredAt: Date.now() - 600_000, sent: 5 },
						finished: { lastFiredAt: null, sent: 0 },
						gap: { lastFiredAt: null, sent: 0 },
					},
				});
			return alertsHandler()(url, init);
		});
		const h = mount();
		await h.render(<AlertsRoute active />);
		await settle();
		const rules = all(h.container, ".table--std")[1];
		const needs = all(rules, "tbody tr").find(row => text(row).includes("Session needs you")) as Element;
		// 3 from the server plus 5 from the mini, whose alerts are off now; the latest is the mini's.
		expect(needs.querySelector('td[data-kind="number"]')?.textContent).toBe("8");
		expect(text(needs)).toContain("10 min ago");
	});

	it("says to update the hub when it lacks per-rule alerts and leaves it out of the counts", async () => {
		fleet(
			ALL_MACHINES,
			alertsHandler(m => (m === "server" ? {} : allCaps)),
		);
		const h = mount();
		await h.render(<AlertsRoute active />);
		await settle();
		expect(text(h.container)).toContain("Update the hub on Ada Server to see when each rule last fired.");
		const rules = all(h.container, ".table--std")[1];
		const needs = all(rules, "tbody tr").find(row => text(row).includes("Session needs you"));
		expect(text(needs as Element)).toContain("never");
	});
});
