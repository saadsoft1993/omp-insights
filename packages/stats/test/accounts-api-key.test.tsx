import { afterEach, expect, it, vi } from "bun:test";
import { buildAccountStats } from "../src/accounts";
import { AccountsRoute } from "../src/client/routes/AccountsRoute";
import { parseMachines, resetFleetForTests, setFleet } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import { resetFleetQueryForTests } from "../src/client/data/fleet-query";
import { click, mount, settle, unmount } from "./helpers/memory-dom";

async function expandRows(container: HTMLElement) {
	for (const row of [...container.querySelectorAll('.table--std tbody tr[tabindex="0"]')]) await click(row);
}

afterEach(async () => {
	await unmount();
	resetFleetForTests();
	clearQueryCache();
	resetFleetQueryForTests();
	vi.restoreAllMocks();
});

it("joins real API-key stats by credential and permits managing accounts without emails", async () => {
	const view = mount();
	const stats = buildAccountStats({
		inRange: [],
		allTime: [],
		recent: [],
		sessionStarts: [],
		rangeCutoff: null,
		nowMs: Date.now(),
		agent: {
			credentials: [
				{
					id: 9,
					provider: "moonshot",
					credentialType: "api_key",
					identityKey: null,
					disabledCause: null,
					updatedAt: 1,
				},
				{
					id: 11,
					provider: "example",
					credentialType: "oauth",
					identityKey: "account:abcdef123456",
					disabledCause: null,
					updatedAt: 1,
				},
			],
			blocks: [],
			quotas: [],
			accountKeys: [],
		},
	});
	const account = (credentialId: number, identity: string, accountId: string | null, type: string) => ({
		credentialId,
		identity,
		email: null,
		accountId,
		orgId: null,
		label: null,
		type,
		expiresAt: null,
		ok: true,
		managed: false,
		priority: 0,
		policyMatched: false,
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		if (url.includes("/hub/connections"))
			return Response.json({
				machine: "local",
				providers: [
					{
						provider: "moonshot",
						label: "Moonshot",
						style: "api-key",
						accounts: [account(9, "Moonshot API key", null, "api_key")],
					},
					{
						provider: "example",
						label: "Example",
						style: "device",
						accounts: [account(11, "abcdef123456", "abcdef123456", "oauth")],
					},
				],
				login: null,
			});
		if (url.includes("/accounts/flow")) return Response.json({ series: [], points: [] });
		if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
		return Response.json(stats);
	});
	await view.render(<AccountsRoute active range="24h" />);
	await settle();
	await expandRows(view.container);
	const cards = [...view.container.querySelectorAll(".subscription")];
	expect(cards).toHaveLength(2);
	for (const title of ["Moonshot · API key", "Example · account 123456"]) {
		const card = cards.find(item => item.querySelector("header strong")?.textContent === title)!;
		expect(card).toBeDefined();
		expect(
			[...card.querySelectorAll("button")]
				.find(button => button.textContent === "Reconnect")
				?.hasAttribute("disabled"),
		).toBe(false);
		await click(card.querySelector('button[aria-label^="More options"]'));
		expect(
			[...card.querySelectorAll("button")]
				.find(button => button.textContent === "Remove from a machine…")
				?.hasAttribute("disabled"),
		).toBe(false);
		await click(card.querySelector('button[aria-label^="More options"]'));
	}
	expect(view.container.textContent).not.toContain("update this machine's hub");
});

it("does not conflate equal credential ids from different machines", async () => {
	resetFleetQueryForTests();
	const view = mount();
	setFleet(
		parseMachines([
			{ id: "server", self: true, ok: true },
			{ id: "mini", ok: true },
		]),
	);
	const stats = buildAccountStats({
		inRange: [],
		allTime: [],
		recent: [],
		sessionStarts: [],
		rangeCutoff: null,
		nowMs: Date.now(),
		agent: {
			credentials: [
				{
					id: 9,
					provider: "moonshot",
					credentialType: "api_key",
					identityKey: null,
					disabledCause: null,
					updatedAt: 1,
				},
			],
			blocks: [],
			quotas: [],
			accountKeys: [],
		},
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		const machine = url.includes("/m/mini/") ? "mini" : "server";
		if (url.includes("/hub/connections"))
			return Response.json({
				machine,
				providers: [
					{
						provider: "moonshot",
						label: "Moonshot",
						style: "api-key",
						accounts: [
							{
								credentialId: 9,
								identity: "Moonshot API key",
								email: null,
								accountId: null,
								orgId: null,
								label: null,
								type: "api_key",
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
		if (url.includes("/accounts/flow")) return Response.json({ series: [], points: [] });
		if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
		return Response.json(stats);
	});
	await view.render(<AccountsRoute active range="24h" />);
	await settle();
	await expandRows(view.container);
	const cards = [...view.container.querySelectorAll(".subscription")];
	expect(cards).toHaveLength(2);
	for (const card of cards) {
		expect(card.querySelectorAll('i[data-state="idle"]')).toHaveLength(1);
		expect(card.querySelectorAll('i[data-state="removed"]')).toHaveLength(1);
	}
});
