import { afterEach, expect, it, vi } from "bun:test";
import { AccountsRoute, mergeWindowHistory } from "../src/client/routes/AccountsRoute";
import { AccountFlowChart } from "../src/client/routes/AccountRouting";
import { parseMachines, resetFleetForTests, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { click, mount, settle, unmount } from "./helpers/memory-dom";

async function expandRows(container: HTMLElement) {
	for (const row of [...container.querySelectorAll('.table--std tbody tr[tabindex="0"]')]) await click(row);
}

afterEach(async () => {
	await unmount();
	resetFleetForTests();
	clearQueryCache();
	vi.restoreAllMocks();
});

it("shows the login, confirms removal, and sends the displayed identity", async () => {
	const view = mount();
	let removed = false;
	let body: unknown;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url.includes("connections/remove")) {
			body = JSON.parse(String(init?.body));
			removed = true;
			return Response.json({ removed: true });
		}
		if (url.includes("connections"))
			return Response.json({
				machine: "local",
				providers: removed
					? []
					: [
							{
								provider: "openai-codex",
								label: "Codex",
								style: "device",
								accounts: [
									{
										credentialId: 7,
										identity: "person@example.com",
										email: "person@example.com",
										label: "Personal Account",
										accountId: null,
										orgId: null,
										type: "oauth",
										expiresAt: null,
										ok: true,
										managed: false,
										priority: 0,
										policyMatched: false,
									},
								],
							},
						],
				login: null,
			});
		if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
		if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
		return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
	});
	await view.render(<AccountsRoute active range="24h" />);
	await settle();
	await expandRows(view.container);
	expect(view.container.textContent).toContain("person@example.com");
	expect(view.container.textContent).toContain("Codex · Personal");
	await click(view.container.querySelector('button[aria-label^="More options"]'));
	expect(view.container.textContent).toContain("Remove from a machine…");
	await click(
		[...view.container.querySelectorAll("button")].find(button => button.textContent === "Remove from a machine…"),
	);
	expect(view.body.textContent).not.toContain("Which machine?");
	expect(view.body.textContent).toContain("Sessions on This machine will stop using it.");
	const confirm = [...view.body.querySelectorAll("button")].find(button => button.textContent === "Remove");
	await click(confirm);
	await settle();
	expect(body).toEqual({ credentialId: 7, confirm: "person@example.com" });
});

it("distinguishes backup and unreachable machines without treating them as problems", async () => {
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", name: "Server", self: true, ok: true },
			{ id: "mini", name: "Mini", ok: false },
			{ id: "macbook", name: "MacBook", ok: true },
		]),
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		if (url.includes("/m/macbook/api/hub/connections"))
			return Response.json({ machine: "macbook", providers: [], login: null });
		if (url.includes("connections"))
			return Response.json({
				machine: "server",
				providers: [
					{
						provider: "anthropic",
						label: "Claude",
						style: "paste",
						accounts: [
							{
								credentialId: 1,
								identity: "first@example.com",
								email: "first@example.com",
								label: "Work account",
								accountId: null,
								orgId: null,
								type: "oauth",
								expiresAt: null,
								ok: true,
								managed: false,
								priority: 20,
								policyMatched: true,
							},
							{
								credentialId: 2,
								identity: "backup@example.com",
								email: "backup@example.com",
								label: null,
								accountId: null,
								orgId: null,
								type: "oauth",
								expiresAt: null,
								ok: true,
								managed: false,
								priority: 10,
								policyMatched: true,
							},
						],
					},
				],
				login: null,
			});
		if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
		return Response.json({ accounts: [], unattributed: [], providerTotals: [], routing: [] });
	});
	await view.render(<AccountsRoute active range="24h" />);
	await settle();
	await expandRows(view.container);
	expect(view.container.querySelector('i[data-state="standby"]')).not.toBeNull();
	expect(view.container.querySelector('i[data-state="unreachable"]')).not.toBeNull();
	expect(view.container.querySelector('i[data-state="removed"]')?.parentElement?.getAttribute("title")).toContain(
		"not added here",
	);
	expect(view.container.textContent).not.toContain("need attention");
});

it("joins a managed login by email and organisation and shows quota warnings", async () => {
	const view = mount();
	const statsAccount = {
		key: "anthropic/email:person@example.com|org:org1",
		provider: "anthropic",
		label: "person@example.com",
		email: "person@example.com",
		orgId: "org1",
		credentialType: "oauth",
		credentialIds: [1],
		status: "idle",
		disabledCause: null,
		blocks: [],
		requests: 2,
		failedRequests: 0,
		totalTokens: 0,
		totalCost: 0,
		unpricedRequests: 0,
		lastUsed: null,
		requestShare: 1,
		tokenShare: 0,
		quotas: [
			{
				limitId: "5h",
				label: "5 hours",
				windowLabel: null,
				usedFraction: 0.92,
				status: "ok",
				resetsAt: null,
				recordedAt: Date.now(),
			},
		],
		recentRequests: 0,
		recentShare: 0,
		servingNow: false,
		servedLatestNewSession: false,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		if (url.includes("connections"))
			return Response.json({
				machine: "local",
				providers: [
					{
						provider: "anthropic-2",
						label: "Claude",
						style: "paste",
						accounts: [
							{
								credentialId: 2,
								identity: "Person@example.com",
								email: "Person@example.com",
								label: "Personal Account",
								accountId: null,
								orgId: "org1",
								type: "oauth",
								expiresAt: null,
								ok: true,
								managed: true,
								priority: 10,
								policyMatched: true,
							},
						],
					},
				],
				login: null,
			});
		if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
		if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
		return Response.json({ accounts: [statsAccount], unattributed: [], providerTotals: [], routing: [] });
	});
	await view.render(<AccountsRoute active range="24h" />);
	await settle();
	await expandRows(view.container);
	expect(view.container.querySelectorAll(".subscription")).toHaveLength(1);
	expect(view.container.textContent).toContain("Claude · Personal");
	expect(view.container.textContent).toContain("92% · nearly full");
	expect(view.container.textContent).toContain("Kept by the multi-auth plugin; add a regular login from Reconnect.");
	expect(
		[...view.container.querySelectorAll("button")]
			.find(button => button.textContent === "Reconnect")
			?.hasAttribute("disabled"),
	).toBe(false);
	await click(view.container.querySelector('button[aria-label^="More options"]'));
	expect(view.container.querySelector("button[title='Remove from a terminal']")?.hasAttribute("disabled")).toBe(true);
});

it("merges window readings within each machine without joining distinct machines", () => {
	const series = {
		provider: "anthropic",
		accountKey: "a",
		accountLabel: "a@example.com",
		windowKey: "5h",
		windowLabel: "5 hours",
		points: [{ timestamp: 1, usedFraction: 0.2, exhausted: false }],
	};
	const merged = mergeWindowHistory([
		{
			machine: "server",
			series: [
				series,
				{ ...series, points: [...series.points, { timestamp: 2, usedFraction: 0.4, exhausted: false }] },
			],
		},
		{ machine: "mini", series: [series] },
	]);
	expect(merged.map(item => item.machine)).toEqual(["server", "mini"]);
	expect(merged[0].points).toHaveLength(2);
	expect(merged[1].points).toHaveLength(1);
});

it("renders each account health state, quota threshold, details and responsive styling", async () => {
	const view = mount();
	const account = (email: string, status: string, requests: number, fraction: number | null, serving = false) => ({
		key: `anthropic/email:${email}`,
		provider: "anthropic",
		label: email,
		email,
		orgId: null,
		credentialType: "oauth",
		credentialIds: [1],
		status,
		disabledCause: status === "needs_login" ? "token expired" : status === "removed" ? "deleted by user" : null,
		blocks: [],
		requests,
		failedRequests: 0,
		totalTokens: 0,
		totalCost: 0,
		unpricedRequests: 0,
		lastUsed: null,
		requestShare: 0,
		tokenShare: 0,
		quotas:
			fraction === null
				? []
				: [
						{
							limitId: "5h",
							label: "5 hours",
							windowLabel: null,
							usedFraction: fraction,
							status: "ok",
							resetsAt: null,
							recordedAt: Date.now() - 120000,
						},
					],
		recentRequests: 0,
		recentShare: 0,
		servingNow: false,
		servedLatestNewSession: serving,
	});
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
	const rows = [
		account("used@example.com", "active", 4, 0.7, true),
		account("idle@example.com", "idle", 0, 0.9),
		account("bad@example.com", "needs_login", 0, null),
		account("removed@example.com", "removed", 0, null),
	];
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		if (url.includes("connections"))
			return Response.json({
				machine: "local",
				providers: [
					{
						provider: "anthropic",
						label: "Claude",
						style: "paste",
						accounts: [connection("used@example.com", 1), connection("idle@example.com", 2)],
					},
				],
				login: null,
			});
		if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
		if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
		return Response.json({ accounts: rows, unattributed: [], providerTotals: [], routing: [] });
	});
	await view.render(<AccountsRoute active range="24h" />);
	await settle();
	await expandRows(view.container);
	expect(view.container.querySelector('i[data-state="used"]')).not.toBeNull();
	expect(view.container.querySelector('i[data-state="idle"]')).not.toBeNull();
	expect(view.container.querySelector('i[data-state="problem"]')?.parentElement?.getAttribute("title")).toContain(
		"token expired",
	);
	// removed@example.com has only past usage on this machine: it reads as removed, not as never added.
	expect(view.container.querySelector('i[data-state="removed"]')?.parentElement?.getAttribute("title")).toContain(
		"Removed: usage from before it was removed",
	);
	expect(view.container.textContent).toContain("Serving new sessions");
	expect(view.container.textContent).toContain("70% · high");
	expect(view.container.textContent).toContain("90% · nearly full");
	expect(view.container.querySelector('[title^="Updated "]')?.getAttribute("title")).toContain("ago");
	expect(view.container.textContent).toContain("No quota data from this provider");
	expect(view.container.textContent).toContain("Today: no requests");
	expect(view.container.querySelector("details.accounts-details")?.hasAttribute("open")).toBe(false);
	const css = await Bun.file(new URL("../src/client/routes/accounts.css", import.meta.url)).text();
	expect(css).toContain("max-width: 600px");
	expect(css).toContain(".subscriptions");
});

it("charts accounts from different providers together and excludes unattributed traffic", async () => {
	const view = mount();
	const now = Math.floor(Date.now() / 3600000) * 3600000;
	const flow = {
		series: [
			{ key: "a", accountKey: "account-a", provider: "anthropic", label: "Claude" },
			{ key: "b", accountKey: "account-b", provider: "openai-codex", label: "Codex" },
			{ key: "c", accountKey: null, provider: "anthropic", label: "Unattributed" },
		],
		points: [
			{ timestamp: now, key: "a", requests: 2, tokens: 0 },
			{ timestamp: now, key: "b", requests: 3, tokens: 0 },
			{ timestamp: now, key: "c", requests: 9, tokens: 0 },
		],
	};
	await view.render(
		<AccountFlowChart
			flow={flow}
			range="24h"
			metric="requests"
			palette={{ label: key => key, color: () => "#123456" }}
			height={180}
			onToggle={() => {}}
		/>,
	);
	expect(view.container.textContent).toContain("account-a");
	expect(view.container.textContent).toContain("account-b");
	expect(view.container.textContent).not.toContain("Unattributed");
});
