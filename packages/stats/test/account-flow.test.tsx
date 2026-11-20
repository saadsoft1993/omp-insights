import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { AccountFlow } from "../src/client/routes/accounts/AccountFlow";
import { resetFleetForTests, setFleet } from "../src/client/app/machine";
import { byText, click, mount, settle, text, type, unmount, valueOf } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	vi.restoreAllMocks();
});
const machines = [
	{ id: "server", name: "Server", ok: true },
	{ id: "mini", name: "Mini", ok: true },
];
const base = { machines, fleet: false, existing: {}, onClose: () => {}, onChanged: () => {} };
const response = (state: string, extra = {}) =>
	Response.json({ id: "id", provider: "p", state, remainingMs: 60000, ...extra });

describe("account flow", () => {
	for (const scenario of [
		{ name: "a managed plugin slot", managed: true, existingId: 3, resultId: 4, refreshed: false },
		{ name: "the same native credential", managed: false, existingId: 3, resultId: 3, refreshed: true },
		{
			name: "another native credential with the same email",
			managed: false,
			existingId: 3,
			resultId: 4,
			refreshed: false,
		},
		{
			name: "a managed slot with the same credential ID",
			managed: true,
			existingId: 3,
			resultId: 3,
			refreshed: false,
		},
		{
			name: "an old hub without a credential ID",
			managed: false,
			existingId: 3,
			resultId: undefined,
			refreshed: true,
		},
		{ name: "an old hub and a managed slot", managed: true, existingId: 3, resultId: undefined, refreshed: false },
	]) {
		it(`reports the correct result for ${scenario.name}`, async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				response("done", {
					provider: "anthropic",
					identity: "person@example.com",
					credentialId: scenario.resultId,
				}),
			);
			const h = mount();
			await h.render(
				<AccountFlow
					{...base}
					machines={[{ id: "mini", name: "Ada Mac mini", ok: true }]}
					existing={{
						mini: [
							{
								provider: "anthropic",
								identity: "person@example.com",
								credentialId: scenario.existingId,
								managed: scenario.managed,
							},
						],
					}}
					mode={{
						kind: "reconnect",
						provider: "anthropic",
						providerLabel: "Claude",
						identity: "person@example.com",
						machines: ["mini"],
					}}
				/>,
			);
			await settle();
			expect(text(h.container)).toContain(
				scenario.refreshed ? "This account was already here. Its login was refreshed." : "Added on Ada Mac mini.",
			);
		});
	}
	it("uses a solid card surface for the dialog in both themes", async () => {
		const css = await Bun.file(new URL("../src/client/routes/accounts/account-flow.css", import.meta.url)).text();
		const panel = css.match(/\.account-flow\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(panel).toContain("background: var(--card)");
		expect(css).not.toContain("var(--overlay");
	});
	it("shows device steps and countdown", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			response("needs-device-confirm", { verificationUrl: "https://example.com", deviceCode: "ABCD" }),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		expect(text(h.container)).toContain("ABCD");
		expect(text(h.container)).toContain("1:00 left");
	});
	it("submits a pasted code", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (_url, init) =>
				init?.method === "POST" && String(init.body).includes("value")
					? response("done", { identity: "a" })
					: response("needs-code", { authUrl: "https://example.com" }),
			);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		await type(h.container.querySelector("input"), "code");
		expect(valueOf(h.container.querySelector("input"))).toBe("code");
		await click(byText(h.container, "button", "Connect"));
		await settle();
		expect(text(h.container)).toContain("Connected as a");
		expect(fetch.mock.calls.some(c => String(c[1]?.body).includes('"value":"code"'))).toBe(true);
	});
	it("shows the full risk warning and submits consent", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
			init?.method === "POST" && String(init.body).includes("value")
				? response("done")
				: response("needs-input", {
						style: "questions",
						riskConsent: true,
						input: {
							text: "Full warning: at your own risk",
							prompt: "Accept?",
							placeholder: "",
							secret: false,
						},
					}),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		expect(text(h.container)).toContain("Full warning: at your own risk");
		await click(byText(h.container, "button", "I understand, continue"));
		await settle();
		expect(fetch.mock.calls.some(c => String(c[1]?.body).includes('"value":"yes"'))).toBe(true);
	});
	it("offers resume for a busy sign-in", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				{
					error: "busy",
					login: {
						id: "other",
						provider: "p",
						state: "needs-device-confirm",
						remainingMs: 60000,
						deviceCode: "XYZ",
						verificationUrl: "https://example.com",
					},
				},
				{ status: 409 },
			),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		expect(text(h.container)).toContain("already running");
		await click(byText(h.container, "button", "Resume"));
		expect(text(h.container)).toContain("XYZ");
	});
	it("retries an expired login", async () => {
		let starts = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			response(++starts === 1 ? "expired" : "needs-code", { authUrl: "https://example.com" }),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		await click(byText(h.container, "button", "Try again"));
		await settle();
		expect(starts).toBe(2);
		expect(text(h.container)).toContain("Paste the code");
	});
	it("reuses a key across machines and clears the input", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			if (String(url).endsWith("providers"))
				return Response.json({
					providers: [{ id: "p", name: "Provider", style: "api-key", popular: true, hint: "API key" }],
				});
			if (String(url).endsWith("answer")) return response("done", { style: "api-key" });
			return response("needs-input", {
				style: "api-key",
				input: {
					text: "Copy your API key from the Moonshot dashboard\nPaste your Moonshot API key (sk-...):  ",
					prompt: "Paste your Moonshot API key (sk-...)",
					placeholder: "sk-",
					secret: true,
				},
			});
		});
		const h = mount();
		await h.render(<AccountFlow {...base} mode={{ kind: "add" }} />);
		await settle();
		await click(byText(h.container, "button", "Provider"));
		await click(byText(h.container, "button", "Continue"));
		await settle();
		expect(text(h.container).match(/Paste your Moonshot API key \(sk-\.\.\.\)/g)).toHaveLength(1);
		expect(text(h.container)).toContain("Copy your API key from the Moonshot dashboard");
		expect(byText(h.container, "button", "Save")?.parentElement?.tagName.toLowerCase()).toBe("footer");
		expect(byText(h.container, "button", "Show")?.parentElement?.className).toBe("account-flow-input-wrap");
		await type(h.container.querySelector('input[type="password"]'), "secret-key");
		expect(valueOf(h.container.querySelector('input[type="password"]'))).toBe("secret-key");
		await click(byText(h.container, "button", "Save"));
		await settle(50);
		expect(fetch.mock.calls.filter(c => String(c[0]).endsWith("answer"))).toHaveLength(2);
		expect(h.container.querySelector('input[type="password"]')).toBeNull();
		expect(text(h.container)).not.toContain("secret-key");
		expect(document.body.innerHTML).not.toContain("secret-key");
		for (const input of h.container.querySelectorAll("input")) expect(valueOf(input)).not.toBe("secret-key");
	});
	it("skips a failed machine and continues", async () => {
		let starts = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			response(++starts === 1 ? "failed" : "needs-device-confirm", {
				message: "Denied",
				deviceCode: "NEXT",
				verificationUrl: "https://example.com",
			}),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{
					kind: "reconnect",
					provider: "p",
					providerLabel: "Provider",
					identity: "a",
					machines: ["server", "mini"],
				}}
			/>,
		);
		await settle();
		await click(byText(h.container, "button", "Skip Server"));
		await settle();
		expect(text(h.container)).toContain("Server ✕");
		expect(text(h.container)).toContain("NEXT");
	});
	it("reuses question answers on the next machine", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url =>
			String(url).endsWith("answer")
				? response("done")
				: response("needs-input", {
						style: "questions",
						input: { text: "", prompt: "Account", placeholder: "account", secret: false },
					}),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{
					kind: "reconnect",
					provider: "p",
					providerLabel: "Provider",
					identity: "a",
					machines: ["server", "mini"],
				}}
			/>,
		);
		await settle();
		await type(h.container.querySelector("input"), "myaccount");
		await click(byText(h.container, "button", "Continue"));
		await settle(50);
		expect(
			fetch.mock.calls.filter(c => String(c[0]).endsWith("answer")).map(c => JSON.parse(String(c[1]?.body)).value),
		).toEqual(["myaccount", "myaccount"]);
	});
	for (const fleet of [false, true]) {
		it(`sets priority in ${fleet ? "fleet" : "single-machine"} mode`, async () => {
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async url =>
					String(url).includes("priority")
						? Response.json({ entries: [] })
						: response("done", { credentialId: 7, needsPriority: true }),
				);
			const h = mount();
			await h.render(
				<AccountFlow
					{...base}
					fleet={fleet}
					mode={{
						kind: "reconnect",
						provider: "p",
						providerLabel: "Provider",
						identity: "a",
						machines: ["server"],
					}}
				/>,
			);
			await settle();
			expect(text(h.container)).toContain("Use this account first");
			await click(byText(h.container, "button", "Continue"));
			await settle();
			const call = fetch.mock.calls.find(c => String(c[0]).includes("priority"));
			expect(String(call?.[0])).toBe(`/api/hub/connections/${fleet ? "priority-fleet" : "priority"}`);
			expect(JSON.parse(String(call?.[1]?.body))).toEqual(
				fleet ? { machine: "server", credentialId: 7, choice: "backup" } : { credentialId: 7, choice: "backup" },
			);
		});
	}
	it("counts down from remainingMs and expires", async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(globalThis, "fetch").mockImplementation(async url =>
				String(url).includes("/login?")
					? new Promise<Response>(() => {})
					: response("needs-code", { remainingMs: 2000, authUrl: "https://example.com" }),
			);
			const h = mount();
			await h.render(
				<AccountFlow
					{...base}
					mode={{
						kind: "reconnect",
						provider: "p",
						providerLabel: "Provider",
						identity: "a",
						machines: ["server"],
					}}
				/>,
			);
			await act(async () => {
				await Promise.resolve();
			});
			expect(text(h.container)).toContain("0:02");
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});
			expect(text(h.container)).toContain("0:01");
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});
			expect(text(h.container)).toContain("expired");
		} finally {
			vi.useRealTimers();
		}
	});
	it("lists popular providers in contract order and searches grouped styles", async () => {
		const rows = [
			["github-copilot", "GitHub Copilot", "device"],
			["google-gemini-cli", "Gemini CLI", "paste"],
			["zai-coding-plan", "Z.ai", "paste"],
			["kimi-code", "Kimi Code", "device"],
			["openai-codex", "Codex", "device"],
			["anthropic", "Claude", "paste"],
		].map(([id, name, style]) => ({ id, name, style, popular: true, hint: style }));
		rows.push({ id: "moonshot", name: "Moonshot", style: "api-key", popular: false, hint: "API key" });
		rows.push({ id: "snowflake", name: "Snowflake", style: "questions", popular: false, hint: "questions" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ providers: rows }));
		const h = mount();
		await h.render(<AccountFlow {...base} mode={{ kind: "add" }} />);
		await settle();
		expect(
			[...h.container.querySelectorAll(".account-flow-tiles button")].map(
				button => button.querySelector("b")?.textContent,
			),
		).toEqual(["Claude", "Codex", "Kimi Code", "Z.ai", "Gemini CLI", "GitHub Copilot"]);
		for (const group of ["Code on another device", "Sign in and paste back", "API key", "A few questions"])
			expect(text(h.container)).toContain(group);
		await type(h.container.querySelector('input[type="search"]'), "moonshot");
		expect(text(h.container)).toContain("Moonshot");
		expect(text(h.container)).not.toContain("Claude");
		await type(h.container.querySelector('input[type="search"]'), "not-a-provider");
		expect(text(h.container)).toContain("No provider matches");
	});
	it("keeps picker chrome outside the scrolling list and uses provider display names", async () => {
		const providers = [
			{
				id: "anthropic",
				name: "Anthropic raw",
				displayName: "Claude",
				subtitle: "Pro / Max",
				style: "paste",
				popular: true,
				hint: "sign in and paste back",
			},
			...Array.from({ length: 91 }, (_, i) => ({
				id: `key-${i}`,
				name: `Provider ${i}`,
				style: "api-key",
				popular: false,
				hint: "API key",
			})),
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ providers }));
		const h = mount();
		await h.render(<AccountFlow {...base} mode={{ kind: "add" }} />);
		await settle();
		const panel = h.container.querySelector('[role="dialog"]')!;
		const list = panel.querySelector(".account-flow-provider-list")!;
		expect(panel.querySelector("header")).not.toBeNull();
		expect(panel.querySelector("footer")?.textContent).toContain("Cancel");
		expect(list.querySelector('input[type="search"]')).toBeNull();
		expect(list.querySelectorAll(".account-flow-provider")).toHaveLength(92);
		const tile = list.querySelector(".account-flow-tiles button")!;
		expect(tile.querySelector("b")?.textContent).toBe("Claude");
		expect([...tile.querySelectorAll("small")].map(el => el.textContent)).toEqual([
			"Pro / Max",
			"sign in and paste back",
		]);
		const row = byText(list, ".account-flow-provider", "Claude")!;
		expect(row.querySelector("b")?.textContent).toBe("Claude");
		expect([...row.querySelectorAll("small")].map(el => el.textContent)).toEqual(["Pro / Max"]);
		const css = await Bun.file(new URL("../src/client/routes/accounts/account-flow.css", import.meta.url)).text();
		expect(css).toContain("max-height: min(85vh, 760px)");
		expect(css.match(/\.account-flow-provider-list\s*\{([^}]*)\}/)?.[1]).toContain("overflow: auto");
	});
	it("reconnects only the chosen machine and sends the expected identity", async () => {
		setFleet(
			machines.map((m, i) => ({
				...m,
				self: i === 0,
				latencyMs: null,
				version: null,
				lastOkAt: null,
				dashboardUrl: null,
			})),
		);
		try {
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(response("needs-device-confirm", { verificationUrl: "https://example.com" }));
			const h = mount();
			await h.render(
				<AccountFlow
					{...base}
					fleet
					mode={{
						kind: "reconnect",
						provider: "p",
						providerLabel: "Provider",
						identity: "user@example.com",
						machines: ["mini"],
					}}
				/>,
			);
			await settle();
			expect(fetch.mock.calls).toHaveLength(1);
			expect(String(fetch.mock.calls[0][0])).toBe("/m/mini/api/hub/connections/start");
			expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
				provider: "p",
				expected: "user@example.com",
			});
			expect(text(h.container)).not.toContain("Popular");
		} finally {
			resetFleetForTests();
		}
	});
	it("cancels a busy login before starting another", async () => {
		let starts = 0;
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
			if (String(url).endsWith("/cancel")) return response("cancelled");
			if (++starts === 1)
				return Response.json(
					{ error: "busy", login: { id: "busy-id", provider: "p", state: "starting" } },
					{ status: 409 },
				);
			return response("needs-device-confirm", { verificationUrl: "https://example.com", deviceCode: "NEW" });
		});
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		await click(byText(h.container, "button", "Cancel"));
		await settle();
		const cancel = fetch.mock.calls.find(call => String(call[0]).endsWith("/cancel"));
		expect(JSON.parse(String(cancel?.[1]?.body))).toEqual({ loginId: "busy-id" });
		expect(starts).toBe(2);
		expect(text(h.container)).toContain("NEW");
	});
	it("shows the failure message and starts a fresh login on retry", async () => {
		let starts = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			++starts === 1
				? response("failed", { message: "The provider denied sign-in." })
				: response("needs-code", { authUrl: "https://example.com" }),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		expect(text(h.container)).toContain("The provider denied sign-in.");
		await click(byText(h.container, "button", "Try again"));
		await settle();
		expect(starts).toBe(2);
		expect(text(h.container)).toContain("Paste the code");
	});
	it("stops polling after unmount", async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(response("needs-code", { authUrl: "https://example.com" }));
			const h = mount();
			await h.render(
				<AccountFlow
					{...base}
					mode={{
						kind: "reconnect",
						provider: "p",
						providerLabel: "Provider",
						identity: "a",
						machines: ["server"],
					}}
				/>,
			);
			await act(async () => {
				await Promise.resolve();
			});
			await act(async () => {
				vi.advanceTimersByTime(1500);
				await Promise.resolve();
			});
			expect(fetch.mock.calls.filter(call => String(call[0]).includes("/login?"))).toHaveLength(1);
			await unmount();
			const count = fetch.mock.calls.length;
			await act(async () => {
				vi.advanceTimersByTime(6000);
				await Promise.resolve();
			});
			expect(fetch.mock.calls).toHaveLength(count);
		} finally {
			vi.useRealTimers();
		}
	});
	for (const busyProvider of ["other", "p"]) {
		it(`never submits a cached secret to resumed ${busyProvider} login`, async () => {
			let starts = 0;
			const answers: { loginId: string; value: string }[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
				if (String(url).endsWith("providers"))
					return Response.json({
						providers: [{ id: "p", name: "Provider", style: "api-key", popular: true, hint: "key" }],
					});
				if (String(url).endsWith("answer")) {
					const answer = JSON.parse(String(init?.body));
					answers.push(answer);
					return response("done", { id: answer.loginId });
				}
				const state = {
					id: ++starts === 1 ? "first" : "busy",
					provider: starts === 1 ? "p" : busyProvider,
					state: "needs-input",
					style: "api-key",
					remainingMs: 60000,
					input: { text: "Key", prompt: "Key", placeholder: "", secret: true },
				};
				return starts === 1
					? Response.json(state)
					: Response.json({ error: "busy", login: state }, { status: 409 });
			});
			const h = mount();
			await h.render(<AccountFlow {...base} mode={{ kind: "add" }} />);
			await settle();
			await click(byText(h.container, "button", "Provider"));
			await click(byText(h.container, "button", "Continue"));
			await settle();
			await type(h.container.querySelector('input[type="password"]'), "private-key");
			await click(byText(h.container, "button", "Save"));
			await settle();
			await click(byText(h.container, "button", "Resume"));
			await settle();
			expect(answers).toEqual([{ loginId: "first", value: "private-key" }]);
			expect(valueOf(h.container.querySelector('input[type="password"]'))).toBe("");
		});
	}
	it("does not resubmit a rejected key on retry", async () => {
		let starts = 0;
		let answers = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
			if (String(url).endsWith("answer")) {
				answers++;
				return response("failed", { id: `id${starts}`, style: "api-key", message: "That key didn't work (401)" });
			}
			return response("needs-input", {
				id: `id${++starts}`,
				style: "api-key",
				input: { text: "Key", prompt: "Key", placeholder: "", secret: true },
			});
		});
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await settle();
		await type(h.container.querySelector('input[type="password"]'), "rejected");
		await click(byText(h.container, "button", "Save"));
		await settle();
		await click(byText(h.container, "button", "Try again"));
		await settle();
		expect(answers).toBe(1);
		expect(valueOf(h.container.querySelector('input[type="password"]'))).toBe("");
	});
	it("offers retry and skip after start fails", async () => {
		let starts = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			++starts === 1
				? Response.json({ error: "down" }, { status: 502 })
				: response("needs-device-confirm", { verificationUrl: "https://example.com", deviceCode: "NEXT" }),
		);
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{
					kind: "reconnect",
					provider: "p",
					providerLabel: "Provider",
					identity: "a",
					machines: ["server", "mini"],
				}}
			/>,
		);
		await settle();
		expect(text(h.container)).toContain("Couldn't reach Server");
		expect(byText(h.container, "button", "Try again")).not.toBeNull();
		await click(byText(h.container, "button", "Skip Server"));
		await settle();
		expect(text(h.container)).toContain("NEXT");
	});
	it("cancels a login returned after the dialog closes", async () => {
		const { promise, resolve: resolveStart } = Promise.withResolvers<Response>();
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async url => (String(url).endsWith("/start") ? promise : response("cancelled")));
		const h = mount();
		await h.render(
			<AccountFlow
				{...base}
				mode={{ kind: "reconnect", provider: "p", providerLabel: "Provider", identity: "a", machines: ["server"] }}
			/>,
		);
		await click(h.container.querySelector('button[aria-label="Close"]'));
		await act(async () => {
			resolveStart(response("starting", { id: "late" }));
			await Promise.resolve();
			await Promise.resolve();
		});
		const call = fetch.mock.calls.find(call => String(call[0]).endsWith("/cancel"));
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({ loginId: "late" });
	});
	it("focuses the dialog, wraps keyboard focus and restores the opener", async () => {
		const { promise, resolve } = Promise.withResolvers<Response>();
		vi.spyOn(globalThis, "fetch").mockReturnValue(promise);
		const h = mount();
		const original = document.createElement("button");
		h.body.appendChild(original);
		let focused: Element | null = original;
		const focusHistory: Element[] = [];
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });
		const proto = HTMLElement.prototype;
		const previous = proto.focus;
		proto.focus = function () {
			focused = this;
			focusHistory.push(this);
		};
		const onClose = vi.fn();
		try {
			await h.render(<AccountFlow {...base} onClose={onClose} mode={{ kind: "add" }} />);
			await act(async () => {
				resolve(Response.json({ providers: [] }));
				await Promise.resolve();
			});
			const close = h.container.querySelector('button[aria-label="Close"]') as HTMLElement;
			const search = h.container.querySelector('input[type="search"]') as HTMLElement;
			const cancel = byText(h.container, "footer button", "Cancel") as HTMLElement;
			expect(focusHistory[0]).toBe(h.container.querySelector('[role="dialog"]'));
			expect(focused).toBe(search);
			close.focus();
			const key = async (shift: boolean) =>
				act(async () => {
					const event = new window.Event("keydown", { bubbles: true, cancelable: true });
					Object.assign(event, { key: "Tab", shiftKey: shift });
					document.dispatchEvent(event);
				});
			await key(true);
			expect(focused).toBe(cancel);
			await key(false);
			expect(focused).toBe(close);
			await act(async () => {
				const event = new window.Event("keydown", { bubbles: true, cancelable: true });
				Object.assign(event, { key: "Escape" });
				document.dispatchEvent(event);
			});
			expect(onClose).toHaveBeenCalledTimes(1);
			await unmount();
			expect(focused).toBe(original);
		} finally {
			proto.focus = previous;
		}
	});
});
