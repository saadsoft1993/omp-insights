import { afterEach, expect, it, vi } from "bun:test";
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
const fixture = async (name: string) =>
	await Bun.file(new URL(`./fixtures/accounts-fleet/${name}.json`, import.meta.url)).json();
for (const old of [false, true]) {
	it(`joins live fleet accounts${old ? " during a rolling hub upgrade" : ""}`, async () => {
		resetFleetQueryForTests();
		const view = mount();
		setFleet(
			parseMachines([
				{ id: "server", name: "Server", self: true, ok: true },
				{ id: "macbook", name: "MacBook", ok: true },
				{ id: "mini", name: "Ada Mac mini", ok: true },
			]),
		);
		const connections = Object.fromEntries(
			await Promise.all(
				["server", "macbook", "mini"].map(async machine => {
					const data = await fixture(`connections-${machine}`);
					if (old && machine !== "server")
						for (const provider of data.providers)
							for (const account of provider.accounts) {
								account.identity = `${account.managed ? account.accountId : account.email} (${account.email}'s Organization)`;
								delete account.email;
								delete account.credentialId;
								delete account.accountId;
								delete account.orgId;
								delete account.label;
							}
					return [machine, data];
				}),
			),
		);
		if (old) {
			const managed = connections.mini.providers
				.flatMap((provider: { accounts: { managed: boolean; identity: string }[] }) => provider.accounts)
				.find((account: { managed: boolean }) => account.managed);
			expect(managed?.identity).toBe("9cc45cad-5c97-4703-9096-1e3f4b8132de (ada@example.com's Organization)");
		}
		const stats = Object.fromEntries(
			await Promise.all(
				["server", "macbook", "mini"].map(async machine => [machine, await fixture(`stats-accounts-${machine}`)]),
			),
		);
		const starts: { url: string; body: unknown }[] = [];
		const removes: { url: string; body: unknown }[] = [];
		const priorities: { url: string; body: any }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			const machine = /\/m\/(server|macbook|mini)\//.exec(url)?.[1] ?? "server";
			if (url.endsWith("/connections/start")) {
				starts.push({ url, body: JSON.parse(String(init?.body)) });
				const account = connections[machine].providers
					.flatMap((p: any) => p.accounts)
					.find((a: any) => a.email === "ada@example.com" && !a.managed);
				return Response.json(
					machine === "mini"
						? { id: "test", provider: "anthropic", state: "failed" }
						: {
								id: "test",
								provider: "anthropic",
								state: "done",
								identity: "ada@example.com",
								credentialId: account.credentialId,
								needsPriority: true,
							},
				);
			}
			if (url.endsWith("/connections/priority-fleet")) {
				priorities.push({ url, body: JSON.parse(String(init?.body)) });
				return Response.json({ entries: [] });
			}
			if (url.endsWith("/connections/remove")) {
				removes.push({ url, body: JSON.parse(String(init?.body)) });
				return Response.json({ removed: true });
			}
			if (url.includes("/hub/connections")) return Response.json(connections[machine]);
			if (url.includes("/stats/accounts/flow")) return Response.json({ series: [], points: [] });
			if (url.includes("/stats/provider-windows")) return Response.json({ windowInsights: [], usageSeries: [] });
			if (url.includes("/stats/accounts")) return Response.json(stats[machine]);
			return Response.json({});
		});
		await view.render(<AccountsRoute active range="24h" />);
		await settle(100);
		await expandRows(view.container);
		const cards = [...view.container.querySelectorAll(".subscription")];
		expect(cards).toHaveLength(9);
		const machineOf = (card: Element) => {
			let row = card.closest("tr")?.previousElementSibling;
			while (row && !row.classList.contains("std-group")) row = row.previousElementSibling;
			return row?.querySelector("b")?.textContent?.trim();
		};
		const find = (machine: string, name: string) =>
			[...view.container.querySelectorAll(".subscription")].find(
				card => machineOf(card) === machine && card.querySelector("header strong")?.textContent === name,
			)!;
		for (const machine of ["Server", "MacBook", "Ada Mac mini"]) {
			for (const name of ["Claude · Work account", "Claude · Personal", "Codex · Personal"])
				expect(find(machine, name)).toBeDefined();
		}
		const states = (card: Element) =>
			[...card.querySelectorAll(".subscription-machine")].map(dot => [
				dot.textContent?.split(":")[0],
				dot.querySelector("i")?.getAttribute("data-state"),
				dot.getAttribute("title"),
			]);
		if (!old)
			for (const machine of ["Server", "MacBook", "Ada Mac mini"]) {
				expect(states(find(machine, "Claude · Work account")).map(s => s[1])).toEqual(["used", "used", "used"]);
				expect(states(find(machine, "Claude · Personal")).map(s => s[1])).toEqual([
					"standby",
					"standby",
					"idle",
				]);
				expect(states(find(machine, "Claude · Personal"))[2][2]).toContain("kept by the multi-auth plugin");
				expect(states(find(machine, "Codex · Personal")).map(s => s[1])).toEqual(["used", "used", "idle"]);
			}
		if (!old) {
			for (const [name, id] of [
				["Server", "server"],
				["MacBook", "macbook"],
				["Ada Mac mini", "mini"],
			]) {
				const card = find(name, "Claude · Personal");
				if (id === "mini") expect(card.textContent).toContain("add a regular login");
				await click([...card.querySelectorAll("button")].find(button => button.textContent === "Reconnect"));
				await settle();
				expect(starts.at(-1)).toEqual({
					url: `/m/${id}/api/hub/connections/start`,
					body: { provider: "anthropic", expected: "ada@example.com" },
				});
				expect(view.body.textContent).not.toContain("All eligible machines");
				if (id !== "mini") {
					await click(
						[...view.body.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === "Continue"),
					);
					await settle();
					expect(priorities.at(-1)?.url).toBe("/api/hub/connections/priority-fleet");
					expect(priorities.at(-1)?.body.machine).toBe(id);
					expect(view.body.textContent).toContain("login was refreshed");
				}
				await click(view.body.querySelector('button[aria-label="Close"]'));
			}
			const managed = find("Ada Mac mini", "Claude · Personal");
			await click(managed.querySelector('button[aria-label^="More options"]'));
			expect(
				[...managed.querySelectorAll("button")]
					.find(b => b.textContent === "Remove from a machine…")
					?.hasAttribute("disabled"),
			).toBe(true);
			expect(managed.textContent).toContain("Kept by the multi-auth plugin");
			for (const [name, id] of [
				["Server", "server"],
				["MacBook", "macbook"],
			]) {
				const card = find(name, "Claude · Personal");
				await click(card.querySelector('button[aria-label^="More options"]'));
				await click([...card.querySelectorAll("button")].find(b => b.textContent === "Remove from a machine…"));
				expect(view.body.textContent).toContain(`Sessions on ${name} will stop using it.`);
				await click(
					[...view.body.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === "Remove"),
				);
				await settle();
				expect(removes.at(-1)?.url).toBe(`/m/${id}/api/hub/connections/remove`);
			}
		} else {
			for (const name of ["MacBook", "Ada Mac mini"]) {
				const card = find(name, "Claude · Personal");
				expect(
					[...card.querySelectorAll("button")].find(b => b.textContent === "Reconnect")?.hasAttribute("disabled"),
				).toBe(true);
				expect(card.textContent).toContain("update this machine's hub");
			}
		}
	});
}
