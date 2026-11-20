import { afterEach, describe, expect, test, vi } from "bun:test";
import { MachineSelect } from "../src/client/app/MachineSelect";
import { parseMachines, resetFleetForTests, selection, setFleet } from "../src/client/app/machine";
import { resetFleetQueryForTests } from "../src/client/data/fleet-query";
import { clearQueryCache } from "../src/client/data/query-store";
import { useHashRoute } from "../src/client/data/useHashRoute";
import { compactAge, historyStatus, historySubtitle, subagentCount, type HistoryRow } from "../src/client/data/history";
import { HistoryRoute } from "../src/client/routes/HistoryRoute";
import { SessionsRoute } from "../src/client/routes/SessionsRoute";
import type { SessionSummary } from "../src/client/types";
import { byText, click, installGlobal, isDisabled, mount, settle, text, unmount } from "./helpers/memory-dom";

const ID = "12345678-1234-1234-1234-123456789abc";
const row: SessionSummary = {
	file: "/home/me/sessions/test.jsonl",
	folder: "/home/me/projects/test",
	title: "Test session",
	sessionId: ID,
	cwd: "/home/me/projects/test",
	firstMessage: null,
	parentSession: null,
	continuationOf: null,
	missing: false,
	startedAt: 100,
	endedAt: 200,
	requests: 1,
	toolCalls: 0,
	subagents: 0,
	totalTokens: 0,
	costTotal: 0,
	unpricedRequests: 0,
	models: [],
};
let serial = 0;
/** Answers a request before the default stub (per test; reset after each). */
let override: ((url: string) => Response | undefined) | null = null;

function App() {
	const route = useHashRoute();
	return (
		<>
			<MachineSelect />
			{route.section === "history" ? (
				<HistoryRoute active range="all" onTranscript={route.openTranscript} onLive={route.setHubSession} />
			) : route.section === "sessions" ? (
				<SessionsRoute active selected={route.hubSession} onSelect={route.setHubSession} />
			) : (
				<div data-section={route.section}>{route.traceMachine}</div>
			)}
		</>
	);
}

async function setup(
	result: { status: number; body: unknown },
	missing = false,
	rows?: SessionSummary[],
	missingLiveId = false,
	running = false,
) {
	const machine = `node${++serial}`;
	const view = mount();
	const location = { hash: "#/history" };
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
	});
	Object.defineProperty(window, "location", { configurable: true, value: location });
	installGlobal("history", {
		replaceState: (_state: unknown, _title: string, hash: string) => {
			location.hash = hash;
		},
		pushState: (_state: unknown, _title: string, hash: string) => {
			location.hash = hash;
		},
	});
	setFleet(
		parseMachines([
			{ id: "server", name: "Server", self: true },
			{ id: machine, name: "Node" },
		]),
	);
	const requests: { url: string; init?: RequestInit }[] = [];
	let resumed = false;
	installGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			const own = override?.(url);
			if (own) return own;
			if (url.includes("/api/hub/resume")) {
				if (result.status === 200) {
					resumed = true;
					clearQueryCache();
				}
				return Response.json(result.body, { status: result.status });
			}
			if (url.includes("/api/hub/sessions"))
				return Response.json({
					sessions:
						resumed || running
							? [{ instanceId: "instance", sessionId: ID, sessionName: "Resumed session", machine }]
							: missingLiveId
								? [{ instanceId: "other", machine }]
								: [],
					now: Date.now(),
				});
			if (url.includes("/api/session/subagents")) return Response.json([]);
			if (url.includes("/api/sessions"))
				return Response.json(url.startsWith(`/m/${machine}/`) ? (rows ?? [{ ...row, missing }]) : []);
			return Response.json({});
		}),
	);
	await view.render(<App />);
	await settle();
	return { ...view, machine, requests, location };
}

afterEach(async () => {
	override = null;
	resetFleetQueryForTests();
	await unmount();
	resetFleetForTests();
	clearQueryCache();
});

describe("Old sessions page", () => {
	test("does not match live records when both session ids are missing", async () => {
		const withoutId = { ...row } as Partial<SessionSummary>;
		delete withoutId.sessionId;
		const view = await setup({ status: 200, body: {} }, false, [withoutId as SessionSummary], true);
		const sessionRow = byText(view.container, "tr", "Test session")!;
		expect(text(sessionRow)).toContain("Ended");
		expect(byText(sessionRow, "button", "Open live")).toBeNull();
	});

	test("shows 15 of 500 loaded rows and reveals the next page without fetching", async () => {
		const rows = Array.from({ length: 500 }, (_, i) => ({
			...row,
			file: `/session/${i}.jsonl`,
			title: `Session ${i}`,
		}));
		const view = await setup({ status: 200, body: {} }, false, rows);
		expect(view.container.querySelectorAll("tbody tr").length).toBe(15);
		const requested = view.requests.filter(call => call.url.includes("/api/sessions")).length;
		const values = Map.prototype.values;
		let largeMapScans = 0;
		const spy = vi.spyOn(Map.prototype, "values").mockImplementation(function (this: Map<unknown, unknown>) {
			if (this.size === 500) largeMapScans++;
			return values.call(this);
		});
		await click(byText(view.container, "button", "Show 15 more"));
		expect(view.container.querySelectorAll("tbody tr").length).toBe(30);
		expect(largeMapScans).toBeLessThanOrEqual(1);
		spy.mockRestore();
		expect(view.requests.filter(call => call.url.includes("/api/sessions")).length).toBe(requested);
	});
	test("resumes on the row machine and navigates to its highlighted session", async () => {
		const view = await setup({ status: 200, body: { sessionId: ID } });
		await click(byText(view.container, "tr", "Test session"));
		await click(byText(view.container, "button", "Resume"));
		await settle();
		const request = view.requests.find(call => call.url === `/m/${view.machine}/api/hub/resume`);
		expect(request?.init?.method).toBe("POST");
		expect(new Headers(request?.init?.headers).get("X-Omp-Hub")).toBe("1");
		expect(JSON.parse(String(request?.init?.body))).toEqual({ sessionId: ID });
		expect(view.location.hash).toContain(`#/sessions/${ID}`);
		expect(view.container.querySelector('tbody tr[data-selected="true"]')?.textContent).toContain("Resumed session");
	});

	for (const [status, message, shown] of [
		[400, "invalid session id", "invalid session id"],
		[404, "not found", "update this machine's hub"],
		[404, "archived or deleted", "archived or deleted"],
		[409, "already running", "already running"],
		[409, "continued as another session", "continued as another session"],
		[400, "folder no longer exists", "folder no longer exists"],
		[400, "folder is outside the project roots", "folder is outside the project roots"],
		[409, "pane cwd does not match", "pane cwd does not match"],
	] as const) {
		test(`renders ${status} ${message} on its row`, async () => {
			const view = await setup({ status, body: { error: message } });
			await click(byText(view.container, "tr", "Test session"));
			await click(byText(view.container, "button", "Resume"));
			await settle();
			expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(shown);
			expect(view.location.hash).toContain("#/history");
		});
	}

	test("missing rows explain archival without actions", async () => {
		const view = await setup({ status: 200, body: {} }, true);
		await click(byText(view.container, "tr", "Test session"));
		expect(text(view.container)).toContain("archived or deleted");
		expect(byText(view.container, "button", "Open transcript")).toBeNull();
		expect(byText(view.container, "button", "Resume")).toBeNull();
	});

	test("transcript navigation retains the All machines selection", async () => {
		const view = await setup({ status: 200, body: {} });
		expect(view.container.querySelector('button[aria-label="Machine"]')?.textContent).toContain("All machines");
		await click(byText(view.container, "tr", "Test session"));
		await click(byText(view.container, "button", "Open transcript"));
		expect(view.location.hash).toContain(`tm=${view.machine}`);
		expect(view.location.hash).not.toContain(`m=${view.machine}&`);
		expect(selection()).toBe("*");
		expect(view.container.querySelector('button[aria-label="Machine"]')?.textContent).toContain("All machines");
		expect(text(view.container.querySelector('[data-section="traces"]')!)).toBe(view.machine);
	});

	test("shows a quiet — with one line naming the machine when live status is unavailable, never a guess", async () => {
		const now = Date.now();
		const rows = [
			{ ...row, file: "/s/recent.jsonl", title: "Recent", startedAt: now - 3_600_000, endedAt: now - 60_000 },
			{ ...row, file: "/s/old.jsonl", title: "Old", startedAt: now - 7_200_000, endedAt: now - 3_600_000 },
		];
		const view = await setup({ status: 200, body: {} }, false, rows);
		// Make the hub's live list fail.
		const stub = globalThis.fetch;
		installGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
				String(input).includes("/api/hub/sessions")
					? Response.json({ error: "busy" }, { status: 503 })
					: stub(input, init),
			),
		);
		clearQueryCache();
		await settle(5200);
		const rowText = (title: string) => text(byText(view.container, "tr", title)!);
		for (const title of ["Recent", "Old"]) {
			expect(rowText(title)).toContain("—");
			expect(rowText(title)).not.toMatch(/Running|Ended|Unknown/);
		}
		expect(
			byText(view.container, "tr", "Recent")!.querySelector('[title="Live status unavailable for Node"]'),
		).not.toBeNull();
		const lines = Array.from(view.container.querySelectorAll('[role="status"]')).filter(el =>
			text(el).startsWith("Live status unavailable for"),
		);
		expect(lines.map(el => text(el))).toEqual([
			"Live status unavailable for Node; its sessions show “—” until the hub answers.",
		]);
		expect(rowText("Old")).toContain("2h ago");
	}, 15_000);

	test("names the unreachable machine instead of loading subagents", async () => {
		const view = await setup({ status: 200, body: {} });
		setFleet(
			parseMachines([
				{ id: "server", name: "Server", self: true },
				{ id: view.machine, name: "Node", ok: false },
			]),
		);
		await settle();
		const before = view.requests.filter(call => call.url.includes("/api/session/subagents")).length;
		await click(byText(view.container, "tr", "Test session"));
		await settle();
		expect(text(view.container)).toContain("Node unreachable; subagents unavailable");
		expect(view.requests.filter(call => call.url.includes("/api/session/subagents")).length).toBe(before);
	});

	test("trusts the hub's fresher stale flag over the fleet list before asking for subagents", async () => {
		const view = await setup({ status: 200, body: {} });
		const stub = globalThis.fetch;
		installGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
				String(input).includes("/api/hub/sessions")
					? Response.json({
							sessions: [],
							machines: [
								{ id: "server", name: "Server", ok: true },
								{ id: view.machine, name: "Node", ok: false, staleSince: Date.now() - 30_000 },
							],
							now: Date.now(),
						})
					: stub(input, init),
			),
		);
		clearQueryCache();
		await settle(5200);
		const before = view.requests.filter(call => call.url.includes("/api/session/subagents")).length;
		await click(byText(view.container, "tr", "Test session"));
		await settle();
		expect(text(view.container)).toContain("Node unreachable; subagents unavailable");
		expect(view.requests.filter(call => call.url.includes("/api/session/subagents")).length).toBe(before);
	}, 15_000);

	test("a held machine (ok, stale) stays reachable: last known cell, — status, subagents asked without parentLive", async () => {
		const view = await setup({ status: 200, body: {} });
		const stub = globalThis.fetch;
		installGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
				String(input).includes("/api/hub/sessions")
					? Response.json({
							sessions: [{ instanceId: "i", sessionId: ID, machine: view.machine, stale: true }],
							machines: [
								{ id: "server", name: "Server", ok: true, stale: false },
								{ id: view.machine, name: "Node", ok: true, stale: true, staleSince: Date.now() - 20_000 },
							],
							now: Date.now(),
						})
					: stub(input, init),
			),
		);
		clearQueryCache();
		await settle(5200);
		const sessionRow = byText(view.container, "tr", "Test session")!;
		expect(sessionRow.querySelector('[data-state="last-known"]')).not.toBeNull();
		expect(text(sessionRow)).toContain("—");
		const before = view.requests.length;
		await click(sessionRow);
		await settle();
		expect(text(view.container)).not.toContain("subagents unavailable");
		const asked = view.requests.slice(before).filter(call => call.url.includes("/api/session/subagents"));
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.every(call => !call.url.includes("parentLive"))).toBe(true);
	}, 15_000);

	test("keeps each row's subagent list and error on its own machine when one machine fails (N2)", async () => {
		const NO_PROOF = "the stats port answered without the dashboard's proof; nothing was passed on";
		override = url => {
			if (url.startsWith("/m/server/api/sessions"))
				return Response.json([{ ...row, file: "/srv/s.jsonl", title: "Server row", sessionId: "srv" }]);
			if (url.startsWith("/m/server/api/session/subagents"))
				return Response.json({ error: NO_PROOF }, { status: 502 });
			if (/^\/m\/node\d+\/api\/session\/subagents/.test(url))
				return Response.json([
					{
						id: "node-child",
						agent: null,
						title: "Node child",
						models: [],
						startedAt: 1,
						endedAt: 2,
						durationMs: 1,
						costTotal: 0,
						requests: 1,
						status: "done",
						toolErrors: 0,
					},
				]);
			return undefined;
		};
		const view = await setup({ status: 200, body: {} });
		await click(byText(view.container, "tr", "Server row"));
		await settle();
		expect(text(view.container)).toContain(
			"Could not list the subagents: Server's stats server is a different version until it's updated.",
		);
		expect(view.container.querySelector(`[title="${NO_PROOF}"]`)).not.toBeNull();
		await click(byText(view.container, "tr", "Test session"));
		await settle();
		const detail = text(view.container.querySelector("tr.std-detail")!);
		expect(detail).toContain("Node child");
		expect(detail).not.toContain(NO_PROOF);
		const asked = view.requests.filter(call => call.url.includes("/api/session/subagents"));
		expect(asked.every(call => call.url.startsWith("/m/server/") || call.url.startsWith(`/m/${view.machine}/`))).toBe(
			true,
		);
		expect(asked.some(call => call.url.startsWith(`/m/${view.machine}/`))).toBe(true);
	}, 15_000);

	for (const running of [false, true])
		test(`says retrying for a ${running ? "running" : "ended"} session only when its list refreshes by itself`, async () => {
			override = url =>
				url.includes("/api/session/subagents") ? Response.json({ error: "busy" }, { status: 503 }) : undefined;
			const view = await setup({ status: 200, body: {} }, false, undefined, false, running);
			await click(byText(view.container, "tr", "Test session"));
			await settle();
			expect(text(view.container)).toContain(
				`Could not list the subagents: Node's stats are busy${running ? "; retrying" : ""}.`,
			);
			if (!running) expect(text(view.container)).not.toContain("retrying");
			expect(byText(view.container, "button", "Try again")).not.toBeNull();
		});

	for (const held of [false, true])
		test(`${held ? "waits for a held machine" : "says every machine failed"} when no machine's sessions answer`, async () => {
			let machines: unknown[] = [];
			override = url =>
				url === "/api/hub/machines"
					? Response.json(machines)
					: url.includes("/api/sessions")
						? Response.json({ error: "stats unavailable" }, { status: 503 })
						: undefined;
			const view = await setup({ status: 200, body: {} });
			machines = [
				{ id: "server", name: "Server", self: true },
				{ id: view.machine, name: "Node", ok: true, stale: held, staleSince: held ? Date.now() - 10_000 : null },
			];
			setFleet(parseMachines(machines));
			await settle(2600);
			const failed = "Could not load sessions from any machine.";
			if (held) {
				expect(text(view.container)).not.toContain(failed);
				expect(view.container.querySelector(".std-skeleton")).not.toBeNull();
			} else {
				expect(text(view.container)).toContain(failed);
				// Each machine's reason sits under the line, as on the stats pages.
				// Headline and reasons share one message column; Try again is its own item beside (or below) it.
				const state = view.container.querySelector(".std-state[role=alert]")!;
				const message = Array.from(state.children).find(child => child.classList.contains("history-failed"))!;
				expect(text(message)).toContain(failed);
				expect(message.querySelector(".error-state-reasons")).not.toBeNull();
				expect(Array.from(state.children).map(c => c.tagName)).toEqual(["SPAN", "BUTTON"]);
				// Try again asks the hub for the machine list first, then every machine again.
				const before = view.requests.length;
				// While the machines are checked again, the same error stays with a disabled "Checking…".
				let answer = () => {};
				const gate = new Promise<void>(resolve => (answer = resolve));
				const stub = globalThis.fetch;
				installGlobal(
					"fetch",
					vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
						if (String(input) === "/api/hub/machines") {
							view.requests.push({ url: "/api/hub/machines", init });
							await gate;
							return Response.json(machines);
						}
						return stub(input, init);
					}),
				);
				await click(byText(view.container, "button", "Try again"));
				await settle(40);
				expect(text(view.container)).toContain(failed);
				const checking = byText(view.container, "button", "Checking…");
				expect(checking).not.toBeNull();
				expect(isDisabled(checking)).toBe(true);
				answer();
				await settle(200);
				const after = view.requests.slice(before).map(call => call.url);
				const list = after.indexOf("/api/hub/machines");
				expect(list).toBeGreaterThanOrEqual(0);
				expect(after.slice(list).some(url => url.startsWith(`/m/${view.machine}/api/sessions`))).toBe(true);
			}
		});

	test("subtitle counts only fresh rows, names last known ones, and offers a row only when there is one", () => {
		const none = { rows: 0, machines: [] };
		const base = { loading: false, rows: 0, lastKnown: none, fleet: null, failedMachine: null };
		const fleet = (answered: number, held: number, failed: number) => ({
			answered,
			held,
			failed,
			total: answered + held + failed,
		});
		expect(historySubtitle({ ...base, loading: true })).toBe("Loading sessions…");
		expect(historySubtitle({ ...base, fleet: fleet(0, 0, 3) })).toBe("Sessions unavailable · no machine answered");
		expect(historySubtitle({ ...base, rows: 12, fleet: fleet(2, 0, 1) })).toBe(
			"12 sessions from 2 of 3 machines · 1 didn't answer · select a row for details",
		);
		// Rows kept from the machine that failed are not counted as answered (review: "2 sessions from 1 of 2").
		expect(
			historySubtitle({
				...base,
				rows: 2,
				lastKnown: { rows: 1, machines: ["Ada Server"] },
				fleet: fleet(1, 0, 1),
			}),
		).toBe(
			"1 session from 1 of 2 machines · 1 last known from Ada Server · 1 didn't answer · select a row for details",
		);
		expect(
			historySubtitle({
				...base,
				rows: 3,
				lastKnown: { rows: 3, machines: ["Ada Server", "Ada MacBook"] },
				fleet: fleet(0, 1, 1),
			}),
		).toBe(
			"No machine answered just now · 3 last known from Ada Server, Ada MacBook · 1 didn't answer · select a row for details",
		);
		expect(historySubtitle({ ...base, rows: 0, fleet: fleet(2, 0, 1) })).toBe(
			"0 sessions from 2 of 3 machines · 1 didn't answer",
		);
		expect(historySubtitle({ ...base, rows: 1, fleet: fleet(3, 0, 0) })).toBe("1 session · select a row for details");
		expect(historySubtitle({ ...base, rows: 0 })).toBe("0 sessions");
		expect(historySubtitle({ ...base, failedMachine: "Ada Mac mini" })).toBe(
			"Sessions unavailable · Ada Mac mini didn't answer",
		);
		expect(historySubtitle({ ...base, rows: 4, failedMachine: "Ada Mac mini" })).toBe(
			"4 last known · Ada Mac mini didn't answer · select a row for details",
		);
	});

	test("subtitle on the page names a held machine's rows as last known", async () => {
		let machines: unknown[] = [];
		override = url =>
			url === "/api/hub/machines"
				? Response.json(machines)
				: url.startsWith("/m/server/api/sessions")
					? Response.json({ error: "no answer in time" }, { status: 502 })
					: undefined;
		const view = await setup({ status: 200, body: {} });
		machines = [
			{ id: "server", name: "Server", self: true },
			{ id: view.machine, name: "Node", ok: true, stale: true, staleSince: Date.now() - 10_000 },
		];
		setFleet(parseMachines(machines));
		await settle(2600);
		expect(text(view.container)).toContain(
			"No machine answered just now · 1 last known from Node · 1 didn't answer · select a row for details",
		);
	});

	for (const failing of ["all", "server"] as const)
		test(`subtitle on the page when ${failing === "all" ? "every machine" : "one machine"} didn't answer`, async () => {
			override = url =>
				/^\/m\/[^/]+\/api\/sessions/.test(url) && (failing === "all" || url.startsWith("/m/server/"))
					? Response.json({ error: "no answer in time" }, { status: 502 })
					: undefined;
			const view = await setup({ status: 200, body: {} });
			await settle(2600);
			if (failing === "all") {
				expect(text(view.container)).toContain("Sessions unavailable · no machine answered");
				expect(text(view.container)).not.toContain("select a row for details");
				// The failed line lists the reasons, so the amber banner stays hidden.
				expect(view.container.querySelector(".missing-machines")).toBeNull();
			} else {
				expect(text(view.container)).toContain(
					"1 session from 1 of 2 machines · 1 didn't answer · select a row for details",
				);
				// Only one machine failed: no failed line, so the amber banner names it.
				expect(view.container.querySelector(".missing-machines")).not.toBeNull();
			}
		});

	test("singular subagent count and compact ages", () => {
		expect(subagentCount(1)).toBe("1 subagent");
		expect(subagentCount(3)).toBe("3 subagents");
		const now = Date.UTC(2026, 10, 18, 12);
		expect(compactAge(now - 59 * 60_000, now)).toBe("59m ago");
		expect(compactAge(now - 10 * 3_600_000, now)).toBe("10h ago");
		expect(compactAge(now - 3 * 86_400_000, now)).toBe("3d ago");
		expect(compactAge(now - 20_000, now)).toBe("just now");
		expect(compactAge(now - 30 * 86_400_000, now)).toBe("19 Oct");
	});

	test("Running and Ended only from the live list; — otherwise", () => {
		const base = { ...row, machine: "m", sessionId: "s" } as HistoryRow;
		const live = new Set(["m:s"]);
		expect(historyStatus({ ...base, missing: true }, live, true, "Mini").label).toBe("Missing file");
		expect(historyStatus({ ...base, missing: true }, live, false, "Mini").label).toBe("Missing file");
		expect(historyStatus(base, live, true, "Mini")).toMatchObject({ label: "Running", live: true });
		expect(historyStatus(base, new Set(), true, "Mini")).toMatchObject({ label: "Ended", live: false });
		// A transcript written a second ago is still not called Running without the live list.
		expect(historyStatus({ ...base, endedAt: Date.now() }, live, false, "Mini")).toEqual({
			label: "Status unavailable",
			text: "—",
			tone: "neutral",
			live: false,
			title: "Live status unavailable for Mini",
		});
	});
});
