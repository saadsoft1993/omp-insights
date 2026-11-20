import { act } from "react";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ALL_MACHINES, parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { ALL_MACHINES_FAILED, resetFleetQueryForTests } from "../src/client/data/fleet-query";
import { clearQueryCache } from "../src/client/data/query-store";
import type { HubJob } from "../src/client/data/hub";
import { accountState, AccountsRoute, shortLoginCause } from "../src/client/routes/AccountsRoute";
import { DevicesRoute } from "../src/client/routes/DevicesRoute";
import { QuotaCard } from "../src/client/routes/QuotaCard";
import { lastKnownTitle, unreachableTitle } from "../src/client/ui";
import { jobActionBlocked, jobState, JobsRoute } from "../src/client/routes/JobsRoute";
import { plainHubReason } from "../src/client/routes/ops-common";
import { all, byText, click, isDisabled, mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
	resetFleetForTests();
	resetFleetQueryForTests();
	clearQueryCache();
});

const NOW = Date.now();
const RAW_OAUTH =
	'OAuthError: anthropic token refresh failed: 400 {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}';

function job(label: string, over: Partial<HubJob> = {}): HubJob {
	return {
		label,
		file: `${label}.plist`,
		readable: true,
		note: null,
		schedule: "daily 08:50",
		status: "ok",
		exit: "last exit ok",
		pid: null,
		lastLogWrite: NOW - 60_000,
		kind: "scheduled",
		loaded: true,
		impact: null,
		nextRun: NOW + 3_600_000,
		...over,
	};
}

function jobsFetch(jobs: HubJob[]) {
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/version"))
			return Response.json({
				hub: { commit: "abc", dirty: false, startedAt: 0 },
				ui: null,
				capabilities: { jobsActions: true },
			});
		if (url.endsWith("/jobs")) return Response.json({ now: NOW, jobs, gaps: [] });
		return Response.json({ error: `unexpected ${url}` }, { status: 404 });
	}) as typeof fetch);
}

function rowOf(container: Element, label: string): Element {
	const row = all(container, "tbody tr").find(r => (r.textContent ?? "").includes(label));
	if (!row) throw new Error(`no row ${label}`);
	return row;
}

describe("Jobs states (D13)", () => {
	it("keeps the state the hub reports, whatever the run time", () => {
		expect(jobState(job("no-logs", { lastLogWrite: null }))).toBe("ok");
		expect(jobState(job("repo-sync"))).toBe("ok");
		expect(jobState(job("broken", { status: "failed", exit: "last exit 2", lastLogWrite: null }))).toBe("failed");
		expect(jobState(job("odd", { status: "weird" as HubJob["status"] }))).toBe("unknown");
	});

	it("blocks Run now on a job that is not loaded, with the reason", () => {
		expect(jobActionBlocked(job("x", { status: "not loaded", loaded: false, exit: null }))).toBe(
			"Not loaded: load it first",
		);
		expect(jobActionBlocked(job("x", { loaded: false, note: "disabled, enable it first" }))).toBe(
			"Not loaded: disabled, enable it first",
		);
		expect(jobActionBlocked(job("x"))).toBeNull();
	});

	it("shows Last run unknown for a successful macOS job with no run time, keeps it ok and in the Ok filter", async () => {
		jobsFetch([
			job("com.acme.no-logs", { lastLogWrite: null }),
			job("com.acme.nightly-backup", {
				status: "not loaded",
				loaded: false,
				exit: null,
				lastLogWrite: null,
				nextRun: NOW + 7_200_000,
			}),
		]);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const quiet = rowOf(h.container, "no-logs");
		expect(text(quiet)).toContain("Last run ok");
		expect(text(quiet)).toContain("unknown");
		expect(text(quiet)).toContain("ok (exit 0)");
		expect(text(quiet)).not.toContain("Never");
		expect(byText(quiet, "span", "unknown")?.getAttribute("title")).toBe(
			"this machine doesn't record run times for this job",
		);
		await click(byText(h.container, '[role="radio"]', "Ok"));
		await settle();
		expect(all(h.container, "tbody tr").some(r => (r.textContent ?? "").includes("no-logs"))).toBe(true);
		expect(all(h.container, "tbody tr").some(r => (r.textContent ?? "").includes("nightly-backup"))).toBe(false);
		await click(byText(h.container, '[role="radio"]', "All"));
		await settle();
		const unloaded = rowOf(h.container, "nightly-backup");
		expect(text(unloaded)).toContain("Not loaded");
		expect(text(unloaded)).toContain("not loaded: load it first");
		expect(text(unloaded)).toContain("—");
		expect(text(unloaded)).not.toMatch(/in \d+ ?h/);
		const run = unloaded.querySelector('button[aria-label^="Run now com.acme.nightly-backup"]');
		expect(isDisabled(run)).toBe(true);
		expect(run?.getAttribute("title")).toBe("Not loaded: load it first");
	});

	it("shows the unit's last start for a Linux job, unchanged", async () => {
		jobsFetch([job("sms-dashboard-sync", { file: "sms-dashboard-sync.service", lastLogWrite: NOW - 2 * 3_600_000 })]);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const row = rowOf(h.container, "sms-dashboard-sync");
		expect(text(row)).toContain("Last run ok");
		expect(text(row)).toMatch(/2 ?h ago/);
		expect(text(row)).not.toContain("unknown");
		expect(text(row)).toContain("ok (exit 0)");
	});
	it("shows Loading instead of zero counts until the first answer (D18)", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((() => new Promise(() => {})) as unknown as typeof fetch);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		expect(all(h.container, ".ops-count")).toHaveLength(0);
		expect(text(h.container)).not.toContain("0 jobs");
		expect(text(h.container)).toContain("Loading…");
	});
});

describe("Machine cells during the hub's grace period", () => {
	it("marks a machine the hub serves from its last good answer as last known, not live or unreachable", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{
					id: "mini",
					name: "Ada Mac mini",
					ok: true,
					stale: true,
					lastOkAt: NOW - 30_000,
					staleSince: Date.UTC(2026, 10, 18, 12, 0),
				},
			]),
		);
		jobsFetch([job("repo-sync")]);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const titles = all(h.container, ".std-machine").map(cell => cell.getAttribute("title"));
		expect(titles).toContain(`Mac mini: ${lastKnownTitle(Date.UTC(2026, 10, 18, 12, 0))}`);
		expect(titles.some(t => t?.startsWith("Mac mini: last known as of 18 Nov"))).toBe(true);
		expect(titles.some(t => t?.includes("unreachable"))).toBe(false);
		expect(titles.some(t => t?.startsWith("Server:"))).toBe(false);
		const run = h.container.querySelector('button[aria-label="Run now repo-sync on Ada Mac mini"]');
		expect(isDisabled(run)).toBe(false);
	});

	it("keeps lastOkAt for an unreachable machine and turns its controls off with the reason", async () => {
		const lastOk = Date.UTC(2026, 10, 18, 9, 30);
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: false, stale: true, lastOkAt: lastOk, staleSince: NOW },
			]),
		);
		jobsFetch([job("repo-sync")]);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const titles = all(h.container, ".std-machine").map(cell => cell.getAttribute("title"));
		expect(titles).toContain(`Mac mini: ${unreachableTitle(lastOk)}`);
		expect(titles.some(t => t?.includes("last known"))).toBe(false);
		const run = h.container.querySelector('button[aria-label="Run now repo-sync on Ada Mac mini"]');
		expect(isDisabled(run)).toBe(true);
		expect(run?.getAttribute("title")).toBe("Ada Mac mini is unreachable");
		const local = h.container.querySelector('button[aria-label="Run now repo-sync on Ada Server"]');
		expect(isDisabled(local)).toBe(false);
	});
});

describe("Logs drawer (D25)", () => {
	it("lets the log fill the drawer and scroll sideways instead of wrapping mid-token", async () => {
		const css = await Bun.file(new URL("../src/client/routes/ops.css", import.meta.url)).text();
		const pre = /\.ops-logs pre \{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(pre).toContain("white-space: pre;");
		expect(pre).toContain("overflow: auto;");
		expect(pre).not.toContain("max-height");
		expect(pre).not.toContain("anywhere");
		expect(/\.ops-logs \{([^}]*)\}/.exec(css)?.[1]).toContain("flex: 1 1 auto;");
	});
});

describe("Devices bulk actions (D20)", () => {
	function devicesFetch(autoCount: number) {
		const list = [
			{
				id: "11111111",
				scope: "tailnet",
				label: "Chrome on Mac",
				pairedAt: NOW,
				expiresAt: null,
				auto: false,
				current: true,
			},
			...Array.from({ length: autoCount }, (_, i) => ({
				id: `a000000${i}`,
				scope: "tailnet",
				label: "Safari on iPad",
				pairedAt: NOW - 1000,
				expiresAt: null,
				auto: true,
				current: false,
			})),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/hub/devices")
				return Response.json({ devices: list, autoPair: true, scope: "tailnet", canLink: true });
			if (url.endsWith("/version"))
				return Response.json({ hub: { commit: "abc", dirty: false, startedAt: 0 }, ui: null, capabilities: {} });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
	}

	it("hides Unpair all auto-paired when none are auto-paired", async () => {
		devicesFetch(0);
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		expect(text(h.container)).not.toContain("Unpair all auto-paired");
		expect(text(h.container)).not.toContain("(0)");
		expect(byText(h.container, "button", "Unpair every other browser")).toBeNull();
	});

	it("offers it with the count when some are, and the confirm opens and cancels", async () => {
		devicesFetch(2);
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		expect(byText(h.container, "button", "Unpair all auto-paired (2)…")).not.toBeNull();
		await click(h.container.querySelector('button[aria-label="Unpair 11111111 on this machine"]'));
		const dialog = h.body.querySelector('[role="dialog"]');
		expect(text(dialog as Element)).toContain("Unpair this browser?");
		await click(byText(dialog as Element, "button", "Cancel"));
		expect(h.body.querySelector('[role="dialog"]')).toBeNull();
	});
});

describe("Accounts status (D14)", () => {
	it("shortens provider errors to a few words", () => {
		expect(shortLoginCause(RAW_OAUTH)).toBe("sign-in expired");
		expect(shortLoginCause(null)).toBe("not logged in");
		expect(shortLoginCause("401 Unauthorized")).toBe("access refused");
		expect(shortLoginCause("something odd")).toBe("login needs attention");
	});

	it("reports an unreachable machine without its name", () => {
		const s = accountState(
			{
				account: null,
				provider: "anthropic",
				identity: "a@example.com",
				email: "a@example.com",
				accountId: null,
				orgId: null,
				label: null,
				providerLabel: "Claude",
				connectionsByMachine: new Map(),
				statsByMachine: new Map(),
				key: "k",
			},
			{ id: "mini", name: "Ada Mac mini", ok: false, lastOkAt: null },
			undefined,
			undefined,
		);
		expect(s.label).toBe("Unreachable");
		expect(s.reason).not.toContain("Mac mini");
	});

	it("shows a Needs login pill with a short reason, the raw error only in the row detail, and no machine prefix", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		const connection = (email: string, ok: boolean) => ({
			credentialId: 1,
			identity: email,
			email,
			label: "Work account",
			accountId: null,
			orgId: null,
			type: "oauth",
			expiresAt: null,
			ok,
			managed: false,
			priority: 20,
			policyMatched: true,
		});
		const stats = (status: string, cause: string | null) => ({
			key: "anthropic/email:accounts@example.com",
			provider: "anthropic",
			label: "accounts@example.com",
			email: "accounts@example.com",
			orgId: null,
			credentialType: "oauth",
			credentialIds: [1],
			status,
			disabledCause: cause,
			blocks: [],
			requests: 0,
			failedRequests: 0,
			totalTokens: 0,
			totalCost: 0,
			unpricedRequests: 0,
			lastUsed: null,
			requestShare: 0,
			tokenShare: 0,
			quotas: [],
			recentRequests: 0,
			recentShare: 0,
			servingNow: false,
			servedLatestNewSession: false,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			const mini = url.includes("/m/mini/");
			if (url.includes("connections"))
				return Response.json({
					machine: mini ? "mini" : "server",
					providers: [
						{
							provider: "anthropic",
							label: "Claude",
							style: "paste",
							accounts: [connection("accounts@example.com", !mini)],
						},
					],
					login: null,
				});
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
			if (url.includes("/accounts"))
				return Response.json({
					accounts: [mini ? stats("needs_login", RAW_OAUTH) : stats("idle", null)],
					unattributed: [],
					providerTotals: [],
					routing: [],
				});
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		const statuses = all(h.container, ".accounts-status").map(cell => text(cell));
		expect(statuses).toContain("OKlogged in");
		expect(statuses).toContain("Needs loginsign-in expired · Reconnect");
		for (const s of statuses) {
			expect(s).not.toContain("Ada Server");
			expect(s).not.toContain("Ada Mac mini");
		}
		expect(text(h.container)).not.toContain("invalid_grant");
		expect(text(h.container)).toContain("need attention");
		const mini = all(h.container, ".table--std tbody tr").find(r => (r.textContent ?? "").includes("Needs login"));
		await click(mini as Element);
		expect(text(h.container)).toContain("Needs login on Ada Mac mini: sign-in expired.");
		expect(h.container.querySelector(".accounts-error pre")?.textContent).toBe(RAW_OAUTH);
	});
});

describe("Machine availability on Accounts and ops group headings", () => {
	const HELD_SINCE = Date.UTC(2026, 10, 18, 12, 0);
	const LAST_OK = Date.UTC(2026, 10, 18, 9, 30);

	function accountsFleet(machines: Record<string, unknown>[], down: string[] = [], noConnections: string[] = []) {
		setFleet(parseMachines(machines));
		const connection = {
			credentialId: 1,
			identity: "accounts@example.com",
			email: "accounts@example.com",
			label: "Work account",
			accountId: null,
			orgId: null,
			type: "oauth",
			expiresAt: null,
			ok: true,
			managed: false,
			priority: 20,
			policyMatched: true,
		};
		const stat = {
			key: "anthropic/email:accounts@example.com",
			provider: "anthropic",
			label: "accounts@example.com",
			email: "accounts@example.com",
			orgId: null,
			credentialType: "oauth",
			credentialIds: [1],
			status: "active",
			disabledCause: null,
			blocks: [],
			requests: 3,
			failedRequests: 0,
			totalTokens: 0,
			totalCost: 0,
			unpricedRequests: 0,
			lastUsed: NOW,
			requestShare: 1,
			tokenShare: 1,
			quotas: [],
			recentRequests: 0,
			recentShare: 0,
			servingNow: false,
			servedLatestNewSession: false,
		};
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			const machine = /\/m\/([a-z-]+)\//.exec(url)?.[1] ?? "server";
			if (down.includes(machine)) return Response.json({ error: "machine unreachable" }, { status: 502 });
			if (noConnections.includes(machine) && url.includes("connections"))
				return Response.json({ error: "connections timed out" }, { status: 504 });
			if (url.includes("connections"))
				return Response.json({
					machine,
					providers: [{ provider: "anthropic", label: "Claude", style: "paste", accounts: [connection] }],
					login: null,
				});
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
			if (url.includes("/accounts"))
				return Response.json({ accounts: [stat], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
	}

	const heading = (container: Element, name: string) =>
		all(container, ".std-group").find(g => g.querySelector(".std-machine-name")?.textContent === name);

	it("marks a held machine's group with the last-known ring dated from staleSince and greys its rows", async () => {
		accountsFleet([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true, stale: true, lastOkAt: LAST_OK, staleSince: HELD_SINCE },
		]);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		const held = heading(h.container, "Ada MacBook");
		expect(held).toBeTruthy();
		expect(held?.querySelector('.std-unreachable[data-state="last-known"]')).toBeTruthy();
		expect(held?.querySelector(".std-machine")?.getAttribute("title")).toBe(
			`Ada MacBook: ${lastKnownTitle(HELD_SINCE)}`,
		);
		const fresh = heading(h.container, "Ada Server");
		expect(fresh?.querySelector(".std-unreachable")).toBeNull();
		expect(fresh?.querySelector(".std-machine")?.getAttribute("title")).toBeNull();
		const rows = all(h.container, "tbody tr[data-stale]");
		expect(rows.filter(r => r.getAttribute("data-stale") === "true")).toHaveLength(1);
		expect(text(h.container)).not.toContain("unreachable");
	});

	it("keeps an unreachable machine's group on a cold load with a note, and counts it in the title", async () => {
		accountsFleet(
			[
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: false, lastOkAt: LAST_OK },
			],
			["mini"],
		);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		const down = heading(h.container, "Ada Mac mini");
		expect(down).toBeTruthy();
		expect(down?.querySelector('.std-unreachable[data-state="unreachable"]')).not.toBeNull();
		expect(down?.querySelector(".std-machine")?.getAttribute("title")).toBe(
			`Ada Mac mini: ${unreachableTitle(LAST_OK)}`,
		);
		expect(text(h.container.querySelector(".std-group-empty") as Element)).toBe(
			"Ada Mac mini unreachable; accounts unavailable",
		);
		expect(text(h.container)).toContain("3 machines · 1 unreachable");
	});

	it("says a reachable machine's accounts didn't load, never unreachable, when only its login list fails", async () => {
		accountsFleet(
			[
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true, lastOkAt: LAST_OK },
			],
			[],
			["macbook"],
		);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		const group = heading(h.container, "Ada MacBook");
		expect(group).toBeTruthy();
		expect(group?.querySelector(".std-unreachable")).toBeNull();
		expect(text(group as Element)).toContain(
			"Ada MacBook's accounts didn't load: it didn't answer in time · Try again",
		);
		expect(byText(group as Element, "button", "Try again")).toBeTruthy();
		expect(text(h.container)).not.toContain("unreachable");
		expect(text(h.container)).toContain("Not loaded");
	});

	it("keeps the held ring dated from staleSince and adds didn't answer when a held machine's login list fails", async () => {
		accountsFleet(
			[
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true, stale: true, lastOkAt: LAST_OK, staleSince: HELD_SINCE },
			],
			[],
			["macbook"],
		);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		const group = heading(h.container, "Ada MacBook");
		expect(group?.querySelector('.std-unreachable[data-state="last-known"]')).toBeTruthy();
		expect(group?.querySelector(".std-machine")?.getAttribute("title")).toBe(
			`Ada MacBook: ${lastKnownTitle(HELD_SINCE)}`,
		);
		expect(text(group as Element)).toContain("Ada MacBook's accounts didn't load: it didn't answer in time");
		expect(group?.querySelector(".ops-retry-text")?.getAttribute("title")).toContain("connections timed out");
		expect(text(h.container)).not.toContain("unreachable");
	});

	it("says so above a single picked machine that is held, and replaces the empty state when it is down", async () => {
		accountsFleet([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true, stale: true, staleSince: HELD_SINCE },
		]);
		selectMachine("macbook");
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		expect(text(h.container.querySelector(".ops-availability") as Element)).toContain(lastKnownTitle(HELD_SINCE));
		await unmount();
		resetFleetQueryForTests();
		clearQueryCache();
		vi.restoreAllMocks();
		accountsFleet(
			[
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: false, lastOkAt: LAST_OK },
			],
			["mini"],
		);
		selectMachine("mini");
		const g = mount();
		await g.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		expect(text(g.container)).toContain("Ada Mac mini unreachable; accounts unavailable");
	});

	it("keeps an ops page's group for a machine that gave no answer on a cold load", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: false, lastOkAt: LAST_OK },
			]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/m/mini/")) return Response.json({ error: "machine unreachable" }, { status: 502 });
			if (url.endsWith("/version"))
				return Response.json({ hub: { commit: "abc", dirty: false, startedAt: 0 }, ui: null, capabilities: {} });
			if (url.endsWith("/jobs")) return Response.json({ now: NOW, jobs: [job("repo-sync")], gaps: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const down = heading(h.container, "Ada Mac mini");
		expect(down).toBeTruthy();
		expect(down?.querySelector('.std-unreachable[data-state="unreachable"]')).toBeTruthy();
		expect(text(h.container.querySelector(".std-group-empty") as Element)).toBe(
			"Ada Mac mini unreachable; jobs unavailable",
		);
	});

	it("shows the same marks in an ops page's group headings", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true, stale: true, staleSince: HELD_SINCE },
			]),
		);
		jobsFetch([job("repo-sync")]);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		const held = heading(h.container, "Ada Mac mini");
		expect(held?.querySelector(".std-machine")?.getAttribute("title")).toBe(
			`Ada Mac mini: ${lastKnownTitle(HELD_SINCE)}`,
		);
		expect(heading(h.container, "Ada Server")?.querySelector(".std-unreachable")).toBeNull();
	});
});

describe("Retrying only where the page refreshes by itself", () => {
	it("says Accounts' login list is busy with a Try again button and no retrying, since nothing polls it", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
			]),
		);
		let connectionCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/hub/machines"))
				return Response.json({
					machines: [
						{ id: "server", name: "Ada Server", self: true, ok: true },
						{ id: "macbook", name: "Ada MacBook", ok: true },
					],
				});
			if (url.includes("/m/macbook/api/hub/connections")) {
				connectionCalls++;
				return Response.json({ error: "busy" }, { status: 503 });
			}
			if (url.includes("connections")) return Response.json({ machine: "server", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
			if (url.includes("/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		expect(text(h.container)).toContain("Ada MacBook's accounts didn't load: it's busy");
		expect(text(h.container)).not.toContain("retrying");
		const retry = byText(h.container, ".ops-retry button", "Try again");
		expect(retry).toBeTruthy();
		const before = connectionCalls;
		await click(retry);
		await settle();
		expect(connectionCalls).toBeGreaterThan(before);
	});

	it("says retrying on a page that polls, such as Jobs", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/m/mini/api/hub/jobs")) return Response.json({ error: "busy" }, { status: 503 });
			if (url.endsWith("/version"))
				return Response.json({ hub: { commit: "abc", dirty: false, startedAt: 0 }, ui: null, capabilities: {} });
			if (url.endsWith("/jobs")) return Response.json({ now: NOW, jobs: [job("repo-sync")], gaps: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		expect(text(h.container)).toContain("Ada Mac mini didn't answer the jobs list: it's busy; retrying.");
	});
});

describe("Plain wording for Accounts and quota load errors", () => {
	it("words a failed account-stats load plainly with the raw reason on hover, and never says retrying", async () => {
		setFleet(parseMachines([{ id: "server", name: "Ada Server", self: true, ok: true }]));
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("connections")) return Response.json({ machine: "server", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts")) return Response.json({ error: "busy" }, { status: 503 });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle();
		await settle();
		// Its login list loaded, so there is no full-table error; only the usage numbers are missing.
		expect(h.container.querySelector(".std-state[role=alert]")).toBeNull();
		expect(text(h.container)).toContain("Usage numbers missing from Ada Server; their usage shows as — · Try again");
		expect(text(h.container)).toContain(
			"0 subscriptions · 1 machine · usage numbers missing from Ada Server (it's busy)",
		);
		expect(text(h.container)).not.toContain("didn't answer");
		expect(text(h.container)).not.toContain("retrying");
		expect(h.container.querySelector('[title="Ada Server: busy"]')).not.toBeNull();
	});

	it("keeps the accounts listed with one Try again when every machine's usage numbers fail", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		let statsCalls = 0;
		let releaseMachines: () => void = () => {};
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/hub/machines")) {
				await new Promise<void>(resolve => (releaseMachines = resolve));
				return Response.json({
					machines: [
						{ id: "server", name: "Ada Server", self: true, ok: true },
						{ id: "mini", name: "Ada Mac mini", ok: true },
					],
				});
			}
			if (url.includes("connections")) return Response.json({ machine: "x", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts")) {
				statsCalls++;
				return Response.json({ error: "no answer in time" }, { status: 504 });
			}
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		// Both login lists loaded, so the accounts stay listed; the missing usage numbers get one note with Try again.
		expect(text(h.container)).not.toContain(ALL_MACHINES_FAILED);
		expect(h.container.querySelector(".std-state[role=alert]")).toBeNull();
		expect(h.container.querySelector(".skeleton")).toBeNull();
		expect(text(h.container)).toContain("usage numbers missing from Ada Server and Ada Mac mini");
		const before = statsCalls;
		await click(byText(h.container, ".ops-retry button", "Try again"));
		await settle(30);
		const busy = byText(h.container, ".ops-retry button", "Checking…");
		expect(busy).toBeTruthy();
		expect(isDisabled(busy)).toBe(true);
		releaseMachines();
		await settle(100);
		await settle(100);
		expect(statsCalls).toBeGreaterThan(before);
	});

	it("keeps Checking… to the view that asked: picking another machine mid-check never leaves it busy", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine(ALL_MACHINES);
		let holdMacbook = false;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/hub/machines"))
				return Response.json({
					machines: [
						{ id: "server", name: "Ada Server", self: true, ok: true },
						{ id: "macbook", name: "Ada MacBook", ok: true },
						{ id: "mini", name: "Ada Mac mini", ok: true },
					],
				});
			if (url.includes("/m/mini/api/hub/connections"))
				return Response.json({ machine: "mini", providers: [], login: null });
			if (url.includes("/hub/connections")) {
				if (holdMacbook && url.includes("/m/macbook/"))
					await new Promise<void>((_, reject) =>
						init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
					);
				return Response.json({ error: "no answer in time" }, { status: 504 });
			}
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(50);
		await settle(50);
		holdMacbook = true;
		await click(h.container.querySelector(".ops-retry button"));
		await settle(50);
		await settle(50);
		const note = (name: string) =>
			all(h.container, ".ops-retry").find(n => text(n).startsWith(name)) as Element | undefined;
		// Server answered again; only the MacBook is still pending.
		expect(text(note("Ada Server")?.querySelector("button") as Element)).toBe("Try again");
		expect(text(note("Ada MacBook")?.querySelector("button") as Element)).toBe("Checking…");
		await act(async () => selectMachine("server"));
		await settle(30);
		// Server alone: its own login list failed, so the table's Try again shows, and it is not busy.
		const button = h.container.querySelector(".std-state button") as Element;
		expect(text(button)).toBe("Try again");
		expect(isDisabled(button)).toBe(false);
	});

	it("asks the login lists again only after Try again's machine list refresh has finished", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
			]),
		);
		selectMachine(ALL_MACHINES);
		const order: string[] = [];
		let releaseList: () => void = () => {};
		let holdList = false;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/hub/machines")) {
				order.push("machines asked");
				if (holdList) await new Promise<void>(resolve => (releaseList = resolve));
				order.push("machines answered");
				return Response.json({
					machines: [
						{ id: "server", name: "Ada Server", self: true, ok: true },
						{ id: "macbook", name: "Ada MacBook", ok: true },
					],
				});
			}
			if (url.includes("/m/macbook/api/hub/connections")) {
				order.push("macbook login list");
				return Response.json({ error: "no answer in time" }, { status: 504 });
			}
			if (url.includes("/hub/connections")) return Response.json({ machine: "server", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(50);
		await settle(50);
		holdList = true;
		order.length = 0;
		await click(h.container.querySelector(".ops-retry button"));
		await settle(50);
		expect(order).toEqual(["machines asked"]);
		expect(text(h.container.querySelector(".ops-retry button") as Element)).toBe("Checking…");
		await act(async () => releaseList());
		await settle(50);
		await settle(50);
		expect(order.slice(0, 3)).toEqual(["machines asked", "machines answered", "macbook login list"]);
		expect(text(h.container.querySelector(".ops-retry button") as Element)).toBe("Try again");
	});

	it("never asks a machine the refreshed list no longer has, and ends Checking… for it", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine(ALL_MACHINES);
		let removed = false;
		const asked: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			asked.push(url);
			if (url.endsWith("/api/hub/machines"))
				return Response.json({
					machines: removed
						? [
								{ id: "server", name: "Ada Server", self: true, ok: true },
								{ id: "mini", name: "Ada Mac mini", ok: true },
							]
						: [
								{ id: "server", name: "Ada Server", self: true, ok: true },
								{ id: "macbook", name: "Ada MacBook", ok: true },
								{ id: "mini", name: "Ada Mac mini", ok: true },
							],
				});
			if (url.includes("/m/mini/api/hub/connections"))
				return Response.json({ machine: "mini", providers: [], login: null });
			if (url.includes("/hub/connections")) return Response.json({ error: "no answer in time" }, { status: 504 });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(50);
		await settle(50);
		const macbookNote = all(h.container, ".ops-retry").find(n => text(n).startsWith("Ada MacBook"));
		removed = true;
		asked.length = 0;
		await click(macbookNote?.querySelector("button") ?? null);
		await settle(50);
		await settle(50);
		expect(asked).toContain("/api/hub/machines");
		expect(asked.filter(url => url.includes("/m/macbook/api/hub/connections"))).toEqual([]);
		for (const button of all(h.container, ".ops-retry button, .std-state button"))
			expect(text(button)).not.toBe("Checking…");
	});

	it("drops Checking… when the page is left in the middle of a Try again", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
			]),
		);
		let hold = false;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/hub/machines"))
				return Response.json({
					machines: [
						{ id: "server", name: "Ada Server", self: true, ok: true },
						{ id: "macbook", name: "Ada MacBook", ok: true },
					],
				});
			if (url.includes("/m/macbook/api/hub/connections")) {
				if (hold)
					await new Promise<void>((_, reject) =>
						init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
					);
				return Response.json({ error: "no answer in time" }, { status: 504 });
			}
			if (url.includes("connections")) return Response.json({ machine: "server", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(50);
		await settle(50);
		hold = true;
		await click(h.container.querySelector(".ops-retry button"));
		await settle(30);
		expect(text(h.container.querySelector(".ops-retry button") as Element)).toBe("Checking…");
		await h.render(<AccountsRoute active={false} range="24h" />);
		await settle(30);
		expect(text(h.container.querySelector(".ops-retry button") as Element)).toBe("Try again");
		hold = false;
		await h.render(<AccountsRoute active range="24h" />);
		await settle(50);
		await settle(50);
		expect(text(h.container.querySelector(".ops-retry button") as Element)).toBe("Try again");
	});

	it("treats a held machine as reconnecting, not failed, so Accounts never says no machine answered", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true, stale: true, staleSince: NOW - 20_000 },
			]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("connections")) return Response.json({ machine: "x", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts")) return Response.json({ error: "no answer in time" }, { status: 504 });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		expect(text(h.container)).not.toContain(ALL_MACHINES_FAILED);
	});

	it("Try again on Accounts refreshes the machine list first and says Checking… while its login list is asked", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
			]),
		);
		const urls: string[] = [];
		let release: () => void = () => {};
		let hold = false;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/api/hub/machines"))
				return Response.json({
					machines: [
						{ id: "server", name: "Ada Server", self: true, ok: true },
						{ id: "macbook", name: "Ada MacBook", ok: true },
					],
				});
			if (url.includes("/m/macbook/api/hub/connections")) {
				if (hold) await new Promise<void>(resolve => (release = resolve));
				return Response.json({ error: "no answer in time" }, { status: 504 });
			}
			if (url.includes("connections")) return Response.json({ machine: "server", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(50);
		await settle(50);
		const button = () => h.container.querySelector(".ops-retry button") as Element;
		expect(text(button())).toBe("Try again");
		hold = true;
		urls.length = 0;
		await click(button());
		await settle(30);
		expect(urls).toContain("/api/hub/machines");
		expect(text(button())).toBe("Checking…");
		expect(isDisabled(button())).toBe(true);
		release();
		await settle(50);
		await settle(50);
		expect(text(button())).toBe("Try again");
		expect(urls.filter(u => u.includes("/m/macbook/api/hub/connections")).length).toBeGreaterThan(0);
	});

	it("shows one line with Try again when no machine's quota answered, and reconnecting for a held machine", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/hub/machines")) return Response.json({ machines: [] });
			if (url.includes("/api/hub/quota")) return Response.json({ error: "no answer in time" }, { status: 504 });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<QuotaCard active wide />);
		await settle(50);
		await settle(50);
		expect(text(h.container)).toContain("No machine's quota answered.");
		expect(byText(h.container, "button", "Try again")).toBeTruthy();
		await unmount();
		resetFleetQueryForTests();
		clearQueryCache();
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true, stale: true, staleSince: NOW - 20_000 },
			]),
		);
		const g = mount();
		await g.render(<QuotaCard active wide />);
		await settle(50);
		await settle(50);
		expect(text(g.container)).not.toContain("No machine's quota answered.");
		const mini = g.container.querySelector('[aria-label="Ada Mac mini quota"]') as Element;
		expect(text(mini)).toContain("Reconnecting; quota shows once Ada Mac mini answers.");
	});

	it("counts every machine whose login list loaded, and names the one whose usage numbers are missing", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine(ALL_MACHINES);
		const connection = (email: string, id: number) => ({
			credentialId: id,
			identity: email,
			email,
			label: null,
			accountId: null,
			orgId: null,
			type: "oauth",
			expiresAt: null,
			ok: true,
			managed: false,
			priority: 10,
			policyMatched: true,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			const mini = url.includes("/m/mini/");
			if (url.includes("connections"))
				return Response.json({
					machine: mini ? "mini" : "server",
					providers: [
						{
							provider: "anthropic",
							label: "Claude",
							style: "paste",
							accounts: mini
								? [connection("only-on-mini@example.com", 2)]
								: [connection("a@example.com", 1), connection("b@example.com", 3)],
						},
					],
					login: null,
				});
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return mini
					? Response.json({ error: "no answer in time" }, { status: 504 })
					: Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		expect(text(h.container)).toContain(
			"3 subscriptions · 2 machines · usage numbers missing from Ada Mac mini (it didn't answer in time)",
		);
		expect(text(h.container.querySelector(".accounts-title p") as Element)).not.toContain("didn't answer ·");
	});

	function pendingStatsFleet(pendingOn: string) {
		const connection = (email: string, id: number) => ({
			credentialId: id,
			identity: email,
			email,
			label: null,
			accountId: null,
			orgId: null,
			type: "oauth",
			expiresAt: null,
			ok: true,
			managed: false,
			priority: 10,
			policyMatched: true,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const machine = /\/m\/([a-z-]+)\//.exec(url)?.[1] ?? "server";
			if (url.includes("connections"))
				return Response.json({
					machine,
					providers: [
						{
							provider: "anthropic",
							label: "Claude",
							style: "paste",
							accounts:
								machine === "mini"
									? [connection("only-on-mini@example.com", 2)]
									: [connection("a@example.com", 1), connection("b@example.com", 3)],
						},
					],
					login: null,
				});
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts")) {
				if (machine === pendingOn)
					await new Promise<void>((_, reject) =>
						init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
					);
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			}
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
	}

	it("never shows a final count while a machine's numbers are still on their way (All machines)", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine(ALL_MACHINES);
		pendingStatsFleet("mini");
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		const subtitle = text(h.container.querySelector(".accounts-title p") as Element);
		// Both login lists are in, so the count is final; only the Mac mini's usage numbers are still on their way.
		expect(subtitle).toBe("3 subscriptions · 2 machines · usage numbers still loading from Ada Mac mini");
	});

	it("says the picked machine's usage numbers are still loading while its login list is in", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine("mini");
		pendingStatsFleet("mini");
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		const subtitle = text(h.container.querySelector(".accounts-title p") as Element);
		expect(subtitle).toBe("1 subscription · 1 machine · usage numbers still loading from Ada Mac mini");
	});

	it("says a machine whose stats answered with a version mismatch is missing usage numbers, never that it didn't answer", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "macbook", name: "Ada MacBook", ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine(ALL_MACHINES);
		const versionMismatch = "the stats port answered without the dashboard's proof; nothing was passed on";
		const login = (machine: string) => ({
			credentialId: 1,
			identity: `${machine}@example.com`,
			email: `${machine}@example.com`,
			label: null,
			accountId: null,
			orgId: null,
			type: "oauth",
			expiresAt: null,
			ok: true,
			managed: false,
			priority: 10,
			policyMatched: true,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			const machine = /\/m\/([a-z-]+)\//.exec(url)?.[1] ?? "server";
			if (url.includes("connections"))
				return Response.json({
					machine,
					providers: [{ provider: "anthropic", label: "Claude", style: "paste", accounts: [login(machine)] }],
					login: null,
				});
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return machine === "server"
					? Response.json({ error: versionMismatch }, { status: 502 })
					: Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		const subtitle = h.container.querySelector(".accounts-title p") as Element;
		expect(text(subtitle)).toBe(
			"3 subscriptions · 3 machines · usage numbers missing from Ada Server (its stats server is a different version until it's updated)",
		);
		expect(text(subtitle)).not.toContain("didn't answer");
		expect(subtitle.querySelector(`[title="Ada Server: ${versionMismatch}"]`)).not.toBeNull();
	});

	it("counts only subscriptions in the login lists, never an account seen only in past usage", async () => {
		setFleet(parseMachines([{ id: "server", name: "Ada Server", self: true, ok: true }]));
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("connections")) return Response.json({ machine: "server", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({
					accounts: [
						{
							key: "anthropic/email:old@example.com",
							provider: "anthropic",
							label: "old@example.com",
							email: "old@example.com",
							orgId: null,
							credentialType: "oauth",
							credentialIds: [9],
							status: "removed",
							disabledCause: "deleted by user",
							blocks: [],
							requests: 42,
							failedRequests: 0,
							totalTokens: 0,
							totalCost: 0,
							unpricedRequests: 0,
							lastUsed: NOW - 86_400_000,
							requestShare: 1,
							tokenShare: 1,
							quotas: [],
							recentRequests: 0,
							recentShare: 0,
							servingNow: false,
							servedLatestNewSession: false,
						},
					],
					unattributed: [],
					providerTotals: [],
					routing: [],
				});
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		expect(text(h.container.querySelector(".accounts-title p") as Element)).toBe("0 subscriptions · 1 machine");
		// The past usage stays visible, marked as removed.
		const row = all(h.container, "tbody tr").find(r => text(r).includes("old@example.com")) as Element;
		expect(text(row)).toContain("Removed");
		expect(text(row)).toContain("usage from before it was removed");
		expect(text(row)).toContain("42");
	});

	it("says whose accounts didn't load, separately from usage numbers, when a login list fails", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine(ALL_MACHINES);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/m/mini/api/hub/connections"))
				return Response.json({ error: "no answer in time" }, { status: 504 });
			if (url.includes("connections")) return Response.json({ machine: "server", providers: [], login: null });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		expect(text(h.container.querySelector(".accounts-title p") as Element)).toBe(
			"0 subscriptions from 1 of 2 machines · accounts didn't load on Ada Mac mini",
		);
	});

	it("lists the picked machine's accounts with usage shown as — when only its stats failed (version mismatch)", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine("server");
		const versionMismatch = "the stats port answered without the dashboard's proof; nothing was passed on";
		const login = (email: string, id: number) => ({
			credentialId: id,
			identity: email,
			email,
			label: null,
			accountId: null,
			orgId: null,
			type: "oauth",
			expiresAt: null,
			ok: true,
			managed: false,
			priority: 10,
			policyMatched: true,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("connections"))
				return Response.json({
					machine: "server",
					providers: [
						{
							provider: "anthropic",
							label: "Claude",
							style: "paste",
							accounts: [login("a@example.com", 1), login("b@example.com", 2), login("c@example.com", 3)],
						},
					],
					login: null,
				});
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts")) return Response.json({ error: versionMismatch }, { status: 502 });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		expect(text(h.container.querySelector(".accounts-title p") as Element)).toBe(
			"3 subscriptions · 1 machine · usage numbers missing from Ada Server (its stats server is a different version until it's updated)",
		);
		expect(text(h.container)).not.toContain("Could not load the accounts");
		const rows = all(h.container, "tbody tr").filter(r => /[abc]@example\.com/.test(text(r)));
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			const cells = all(row, "td");
			expect(text(cells[cells.length - 1])).toBe("—");
		}
	});

	it("shows the table error only when the picked machine's login list itself failed", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		selectMachine("server");
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("connections")) return Response.json({ error: "no answer in time" }, { status: 504 });
			if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/accounts"))
				return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await settle(100);
		const error = h.container.querySelector(".std-state[role=alert]") as Element;
		expect(text(error)).toContain(
			"Could not load the accounts. Ada Server's accounts didn't load: it didn't answer in time.",
		);
		expect(byText(error, "button", "Try again")).toBeTruthy();
	});

	for (const picked of [ALL_MACHINES, "mini"])
		it(`never calls an account "Not added" while its machine's login list is still loading (${picked === ALL_MACHINES ? "All machines" : "one machine"})`, async () => {
			setFleet(
				parseMachines([
					{ id: "server", name: "Ada Server", self: true, ok: true },
					{ id: "mini", name: "Ada Mac mini", ok: true },
				]),
			);
			selectMachine(picked);
			vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/m/mini/api/hub/connections"))
					await new Promise<void>((_, reject) =>
						init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
					);
				if (url.includes("connections")) return Response.json({ machine: "server", providers: [], login: null });
				if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
				if (url.includes("/stats/accounts"))
					return Response.json({
						accounts: url.includes("/m/mini/")
							? [
									{
										key: "anthropic/email:mini@example.com",
										provider: "anthropic",
										label: "mini@example.com",
										email: "mini@example.com",
										orgId: null,
										credentialType: "oauth",
										credentialIds: [5],
										status: "idle",
										disabledCause: null,
										blocks: [],
										requests: 7,
										failedRequests: 0,
										totalTokens: 0,
										totalCost: 0,
										unpricedRequests: 0,
										lastUsed: NOW - 3_600_000,
										requestShare: 1,
										tokenShare: 1,
										quotas: [],
										recentRequests: 0,
										recentShare: 0,
										servingNow: false,
										servedLatestNewSession: false,
									},
								]
							: [],
						unattributed: [],
						providerTotals: [],
						routing: [],
					});
				return Response.json({ error: `unexpected ${url}` }, { status: 404 });
			}) as typeof fetch);
			const h = mount();
			await h.render(<AccountsRoute active range="24h" />);
			await settle(100);
			await settle(100);
			const row = all(h.container, "tbody tr").find(r => text(r).includes("mini@example.com")) as Element;
			expect(row).toBeTruthy();
			expect(text(row)).toContain("Checking…");
			expect(text(row)).toContain("login list still loading");
			expect(text(h.container)).not.toContain("Not added");
		});

	it("words quota that is unavailable on a machine plainly, with the raw reason on hover", async () => {
		setFleet(
			parseMachines([
				{ id: "server", name: "Ada Server", self: true, ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/m/mini/api/hub/quota"))
				return Response.json({ error: "no answer in time" }, { status: 504 });
			if (url.includes("/api/hub/quota"))
				return Response.json({
					generatedAt: NOW,
					cacheAgeMs: 0,
					cacheStale: false,
					source: "local usage records",
					providers: {},
					accounts: [],
				});
			if (url.endsWith("/api/stats/version") || url.includes("stats-versions"))
				return Response.json({ machines: [] });
			return Response.json({ error: `unexpected ${url}` }, { status: 404 });
		}) as typeof fetch);
		const h = mount();
		await h.render(<QuotaCard active wide />);
		await settle();
		await settle();
		const mini = h.container.querySelector('[aria-label="Ada Mac mini quota"]') as Element;
		expect(text(mini)).toContain("Quota unavailable: it didn't answer in time.");
		expect(mini.querySelector('[title="no answer in time"]')).not.toBeNull();
	});
});

describe("Plain reasons for failed hub requests", () => {
	it("words each of the hub's reasons plainly and never says not running", () => {
		const cases: [string | null, string][] = [
			["machine unreachable", "it's unreachable"],
			["machine identity check failed", "its hub is a different version until it's updated"],
			["request too old", "clocks are out of sync or the hub restarted; retrying"],
			["request predates this process", "clocks are out of sync or the hub restarted; retrying"],
			["machine answered something other than data", "it sent an unexpected answer"],
			["the machine answered 500", "it sent an unexpected answer"],
			["no answer in time", "it didn't answer in time"],
			["connections timed out", "it didn't answer in time"],
			["connect ECONNREFUSED 192.0.2.86:8799", "its hub isn't answering"],
			["sessions are still loading; try again in a few seconds", "it's still loading"],
			["busy", "it's busy; retrying"],
			["too many dashboard tabs are streaming from this hub; close some tabs", "it's busy; retrying"],
			["machine key missing", "this hub isn't set up for it yet"],
			["bad nonce", "it returned an error"],
			["bad fleet signature", "it returned an error"],
			[null, "it returned an error"],
		];
		const polling = { refreshing: true };
		for (const [raw, plain] of cases) expect(`${raw} -> ${plainHubReason(raw, polling)}`).toBe(`${raw} -> ${plain}`);
		expect(plainHubReason("no answer in time", { reachable: false, refreshing: true })).toBe("it's unreachable");
		for (const [raw] of cases) expect(plainHubReason(raw, polling)).not.toContain("not running");
	});

	it("only says retrying when the page asks again by itself", () => {
		const still = { refreshing: false };
		expect(plainHubReason("busy", still)).toBe("it's busy");
		expect(plainHubReason("request too old", still)).toBe("clocks are out of sync or the hub restarted");
		for (const raw of ["busy", "request too old", "too many dashboard tabs are streaming", "no answer in time", null])
			expect(plainHubReason(raw, still)).not.toContain("retrying");
	});
});
