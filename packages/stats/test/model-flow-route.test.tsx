import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { loadQuery, releaseQuery } from "../src/client/data/query-store";
import type { FlowModel, FlowRole, ModelFlow } from "../src/client/data/hub";
import { FLOW_RETRY_BASE_MS, ModelFlowRoute, resetModelFlowRoute } from "../src/client/routes/ModelFlowRoute";
import { byText, click, isDisabled, keydown, mount, settle, text as visibleText, unmount } from "./helpers/memory-dom";

const text = (root: Element) =>
	`${visibleText(root)} ${Array.from(root.querySelectorAll("[title]"))
		.map(element => element.getAttribute("title"))
		.join(" ")}`;

afterEach(async () => {
	await unmount();
	resetFleetForTests();
});

const URL_FLOW = "/api/hub/model-flow";

const MODELS: FlowModel[] = [
	{ selector: "anthropic/a", provider: "anthropic", id: "a", name: "Alpha", thinking: ["low", "medium", "high"] },
	{ selector: "anthropic/c", provider: "anthropic", id: "c", name: "Charlie", thinking: ["low", "high"] },
	{ selector: "openai/b", provider: "openai", id: "b", name: "Bravo", thinking: null },
	{ selector: "p/m", provider: "p", id: "m", name: "Mu", thinking: ["low", "max"] },
	{ selector: "p/m:max", provider: "p", id: "m:max", name: "Mu max", thinking: null },
];

function role(name: string, over: Partial<FlowRole> = {}): FlowRole {
	return {
		role: name,
		value: "anthropic/a:high",
		model: "anthropic/a",
		thinking: "high",
		editable: true,
		usedBy: [],
		...over,
	};
}

function flow(over: Partial<ModelFlow> = {}): ModelFlow {
	return {
		path: "/home/me/.omp/agent/config.yml",
		revision: "r1",
		roles: [role("default"), role("plan_verifier", { usedBy: ["plan-verifier"] }), role("code_review")],
		models: MODELS,
		...over,
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockHub(
	post: () => Response | Promise<Response> = () => json({ error: "unexpected" }, 500),
	get: () => ModelFlow | Promise<ModelFlow> = () => flow(),
) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({
			url,
			method,
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		if (url === URL_FLOW && method === "GET") return json(await get());
		if (url === URL_FLOW && method === "POST") return post();
		return json({ error: `unexpected ${url}` }, 500);
	}) as typeof fetch);
	return calls;
}

beforeEach(async () => {
	resetModelFlowRoute();
	const key = JSON.stringify(["hub-model-flow"]);
	const r = loadQuery(key, -1, async () => ({ flow: flow(), gen: 0 }));
	await r.promise;
	releaseQuery(key, r);
});

const gets = (calls: Call[]) => calls.filter(c => c.method === "GET");
const posts = (calls: Call[]) => calls.filter(c => c.method === "POST");
/** The model option the picker shows as chosen. */
const pickedModel = (c: Element) =>
	c.querySelector('.mf-editor [role="option"][aria-selected="true"]')?.getAttribute("data-value") ?? "";
/** The thinking level the picker shows as chosen ("" is the model default). */
const pickedLevel = (c: Element) =>
	c.querySelector('.mf-editor [role="radio"][aria-checked="true"]')?.getAttribute("data-value") ?? "";
const pickModel = (c: Element, model: string) =>
	click(c.querySelector(`.mf-editor [role="option"][data-value="${model}"]`));
const pickLevel = (c: Element, level: string) =>
	click(c.querySelector(`.mf-editor [role="radio"][data-value="${level}"]`));
const openMenu = (c: Element, role: string) => click(c.querySelector(`button[aria-label="Actions for ${role}"]`));
const save = (c: Element) => c.querySelector('button[data-action="commit"]');
async function editRole(c: Element, role: string, model: string, thinking = "") {
	const names: Record<string, string> = {
		default: "Default",
		plan_verifier: "Plan verification",
		code_review: "Code review",
	};
	await click(c.querySelector(`button[aria-label="Change ${names[role] ?? role} on This machine"]`));
	await pickModel(c, model);
	if (thinking) await pickLevel(c, thinking);
	await click(byText(c, "button", "Save"));
}
async function reviewAndSave(c: Element) {
	await click(byText(c, "button", "Review & save"));
	await click(save(c));
}

async function open(post?: () => Response | Promise<Response>, get?: () => ModelFlow) {
	const calls = mockHub(post, get);
	const h = mount();
	await h.render(<ModelFlowRoute active />);
	await settle();
	return { calls, c: h.container };
}

describe("Model flow page", () => {
	it("renders the roles and starts with Save disabled", async () => {
		const { c } = await open();
		expect(text(c)).toContain("Plan verification");
		expect(text(c)).toContain("Used by: plan-verifier");
		expect(byText(c, "button", "Review & save")).toBeNull();
	});

	it("saves a model and thinking change in one POST", async () => {
		const saved = flow({
			revision: "r2",
			roles: [
				role("default"),
				role("plan_verifier", {
					usedBy: ["plan-verifier"],
					value: "anthropic/c:low",
					model: "anthropic/c",
					thinking: "low",
				}),
				role("code_review"),
			],
		});
		let current = flow();
		const { calls, c } = await open(
			() => {
				current = saved;
				return json({ ...saved, saved: ["plan_verifier"] });
			},
			() => current,
		);
		await editRole(c, "plan_verifier", "anthropic/c", "low");
		expect(isDisabled(byText(c, "button", "Review & save"))).toBe(false);
		await reviewAndSave(c);
		await settle();
		const sent = posts(calls);
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe(URL_FLOW);
		expect(sent[0].headers["X-Omp-Hub"]).toBe("1");
		expect(sent[0].body).toEqual({
			revision: "r1",
			roles: { plan_verifier: { model: "anthropic/c", thinking: "low" } },
		});
		expect(text(c)).toContain("Saved 1 role(s).");
		await click(c.querySelector('button[aria-label="Change Plan verification on This machine"]'));
		expect(pickedModel(c)).toBe("anthropic/c");
		expect(pickedLevel(c)).toBe("low");
	});

	it("drops the draft when the model is set back to the loaded value", async () => {
		const { c } = await open();
		await editRole(c, "plan_verifier", "anthropic/c");
		expect(isDisabled(byText(c, "button", "Review & save"))).toBe(false);
		await editRole(c, "plan_verifier", "anthropic/a", "high");
		expect(byText(c, "button", "Review & save")).toBeNull();
	});

	it("locks the controls while a save is pending", async () => {
		let release: (r: Response) => void = () => {};
		const { c } = await open(() => new Promise<Response>(resolve => (release = resolve)));
		await editRole(c, "plan_verifier", "anthropic/c");
		await reviewAndSave(c);
		expect(isDisabled(c.querySelector('button[aria-label="Change Plan verification on This machine"]'))).toBe(true);
		expect(isDisabled(c.querySelector('button[aria-label="Change Default on This machine"]'))).toBe(true);
		expect(isDisabled(byText(c, "button", "Discard"))).toBe(true);
		expect(isDisabled(byText(c, "button", "Saving…"))).toBe(true);
		release(json({ error: "x" }, 500));
		await settle();
	});

	it("reloads and clears the draft on a stale save", async () => {
		const { calls, c } = await open(() => json({ error: "changed", code: "stale" }, 409));
		const before = gets(calls).length;
		await editRole(c, "plan_verifier", "anthropic/c");
		await reviewAndSave(c);
		await settle();
		expect(text(c)).toContain("config changed");
		await click(byText(c, "button", "Reload and discard my changes"));
		expect(byText(c, "button", "Review & save")).toBeNull();
		expect(gets(calls).length).toBeGreaterThan(before);
	});

	it("keeps the draft when the file changes underneath and posts the original revision", async () => {
		let revision = "r1";
		const calls = mockHub(
			() => json({ error: "changed", code: "stale" }, 409),
			() => flow({ revision }),
		);
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		const c = h.container;
		await editRole(c, "plan_verifier", "anthropic/c");
		revision = "r2";
		// Pause the page, age its cache entry, and resume: the page refetches and sees the new revision.
		await h.render(<ModelFlowRoute active={false} />);
		const key = JSON.stringify(["hub-model-flow"]);
		const aged = loadQuery(key, -1, async () => ({ flow: flow({ revision: "r2" }), gen: 0 }));
		await aged.promise;
		releaseQuery(key, aged);
		await h.render(<ModelFlowRoute active />);
		await settle();
		expect(text(c)).toContain("config.yml changed outside this page");
		expect(isDisabled(byText(c, "button", "Review & save"))).toBe(false);
		await reviewAndSave(c);
		await settle();
		expect(posts(calls)[0].body).toMatchObject({ revision: "r1" });
	});

	it("shows custom values and the unmapped-agent warning", async () => {
		const { c } = await open(undefined, () =>
			flow({
				roles: [
					role("smol", { value: "@smol", model: null, thinking: null, editable: false }),
					role("code_review", { usedBy: [] }),
				],
			}),
		);
		expect(text(c)).toContain("Custom value in config.yml");
		expect(text(c)).toContain("No agent is mapped to this role in task.agentModelOverrides");
	});

	it("does not offer a thinking level that collides with a literal model", async () => {
		const { c } = await open();
		await click(c.querySelector('button[aria-label="Change Default on This machine"]'));
		await pickModel(c, "p/m");
		const levels = Array.from(c.querySelectorAll('.mf-editor [role="radio"]')).map(
			o => o.getAttribute("data-value") ?? "",
		);
		expect(levels).toContain("low");
		expect(levels).not.toContain("max");
	});

	/** Start a background GET (the first one after this call stays pending) while a draft exists. */
	async function withPendingGet(post: () => Response, fresh: ModelFlow) {
		let release: (f: ModelFlow) => void = () => {};
		let n = 0;
		const calls = mockHub(post, () => {
			n += 1;
			if (n === 1) return flow();
			if (n === 2) return new Promise<ModelFlow>(resolve => (release = resolve));
			return fresh;
		});
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		const c = h.container;
		await editRole(c, "plan_verifier", "anthropic/c");
		await h.render(<ModelFlowRoute active={false} />);
		const key = JSON.stringify(["hub-model-flow"]);
		const aged = loadQuery(key, -1, async () => ({ flow: flow(), gen: 0 }));
		await aged.promise;
		releaseQuery(key, aged);
		await h.render(<ModelFlowRoute active />);
		// The refetch is throttled to 1.5 s after the previous one; wait until it is in flight.
		await settle(1700);
		expect(gets(calls)).toHaveLength(2);
		return { calls, c, release: (f: ModelFlow) => release(f) };
	}

	it("a GET in flight before Save does not overwrite the saved values", async () => {
		const saved = flow({
			revision: "r2",
			roles: [
				role("default"),
				role("plan_verifier", { model: "anthropic/c", thinking: null, value: "anthropic/c" }),
			],
		});
		const { calls, c, release } = await withPendingGet(() => json({ ...saved, saved: ["plan_verifier"] }), saved);
		await reviewAndSave(c);
		await settle();
		expect(posts(calls)).toHaveLength(1);
		release(flow());
		await settle();
		expect(text(c)).toContain("anthropic/c");
	});

	it("a GET in flight before a stale Save does not replace the fresh fetch", async () => {
		const fresh = flow({
			revision: "r3",
			roles: [
				role("default"),
				role("plan_verifier", { model: "anthropic/c", thinking: null, value: "anthropic/c" }),
			],
		});
		const { calls, c, release } = await withPendingGet(() => json({ error: "changed", code: "stale" }, 409), fresh);
		await reviewAndSave(c);
		await settle();
		release(flow());
		await settle();
		expect(gets(calls)).toHaveLength(3);
		expect(text(c)).toContain("config changed");
		await click(byText(c, "button", "Reload and discard my changes"));
		expect(text(c)).toContain("anthropic/c");
	});

	it("a GET that starts while the POST is pending does not revert the saved values", async () => {
		const saved = flow({
			revision: "r2",
			roles: [
				role("default"),
				role("plan_verifier", { model: "anthropic/c", thinking: null, value: "anthropic/c" }),
			],
		});
		let finish: (r: Response) => void = () => {};
		let release: (f: ModelFlow) => void = () => {};
		let n = 0;
		const calls = mockHub(
			() => new Promise<Response>(resolve => (finish = resolve)),
			() => {
				n += 1;
				return n === 2 ? new Promise<ModelFlow>(resolve => (release = resolve)) : flow();
			},
		);
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		const c = h.container;
		await editRole(c, "plan_verifier", "anthropic/c");
		await reviewAndSave(c);
		// While the POST is pending, a live refetch starts and reads the old file.
		await h.render(<ModelFlowRoute active={false} />);
		const key = JSON.stringify(["hub-model-flow"]);
		const aged = loadQuery(key, -1, async () => ({ flow: flow(), gen: 0 }));
		await aged.promise;
		releaseQuery(key, aged);
		await h.render(<ModelFlowRoute active />);
		await settle(1700);
		expect(gets(calls)).toHaveLength(2);
		finish(json({ ...saved, saved: ["plan_verifier"] }));
		await settle();
		release(flow());
		await settle();
		expect(text(c)).toContain("anthropic/c");
	});

	it("shows the saved values after the page is left and opened again", async () => {
		const saved = flow({
			revision: "r2",
			roles: [
				role("default"),
				role("plan_verifier", { model: "anthropic/c", thinking: null, value: "anthropic/c" }),
			],
		});
		const { c } = await open(() => json({ ...saved, saved: ["plan_verifier"] }));
		await editRole(c, "plan_verifier", "anthropic/c");
		await reviewAndSave(c);
		await settle();
		await unmount();
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		expect(text(h.container)).toContain("anthropic/c");
	});

	it("shows the loaded values after a failed save and a remount", async () => {
		const { c } = await open(() => json({ error: "boom", code: "error" }, 500));
		await editRole(c, "plan_verifier", "anthropic/c");
		await reviewAndSave(c);
		await settle();
		expect(text(c)).toContain("boom");
		await unmount();
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Change Plan verification on This machine"]'));
		expect(pickedModel(h.container)).toBe("anthropic/a");
	});

	it("shows the loaded values after a stale save whose reload failed and a remount", async () => {
		let n = 0;
		const { c } = await open(
			() => json({ error: "changed", code: "stale" }, 409),
			() => {
				n += 1;
				if (n === 2) throw new Error("offline");
				return flow();
			},
		);
		await editRole(c, "plan_verifier", "anthropic/c");
		await reviewAndSave(c);
		await settle();
		expect(text(c)).toContain("reload failed");
		await unmount();
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		await click(h.container.querySelector('button[aria-label="Change Plan verification on This machine"]'));
		expect(pickedModel(h.container)).toBe("anthropic/a");
	});
});

describe("Fleet model flow", () => {
	it.each([
		["before", true, false],
		["after", false, false],
		["after both succeed", false, true],
	] as const)(
		"keeps each saved machine when an older GET resolves %s the other POST",
		async (_order, getBeforeLastPost, saveB) => {
			const initialA = flow({
				revision: "a1",
				roles: [role("default", { value: "anthropic/a", model: "anthropic/a", thinking: null })],
			});
			const initialB = flow({
				revision: "b1",
				roles: [role("default", { value: "openai/b", model: "openai/b", thinking: null })],
			});
			const savedA = flow({
				revision: "a2",
				roles: [role("default", { value: "anthropic/c", model: "anthropic/c", thinking: null })],
			});
			const freshB = flow({
				revision: "b2",
				roles: [role("default", { value: "openai/b", model: "openai/b", thinking: null })],
			});
			const savedB = { ...savedA, revision: "b2" };
			const pendingGets: Record<string, (response: Response) => void> = {};
			const pendingPosts: Record<string, (response: Response) => void> = {};
			const getCounts: Record<string, number> = {};
			const postBodies: { machine: string; revision: string }[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
				const match = String(input).match(/^\/m\/(a|b)\/api\/hub\/model-flow$/);
				if (!match) return json({ error: "unexpected request" }, 500);
				const machine = match[1];
				if (init?.method === "POST") {
					const body = JSON.parse(String(init.body)) as { revision: string };
					postBodies.push({ machine, revision: body.revision });
					if (postBodies.length <= 2) {
						const { promise, resolve } = Promise.withResolvers<Response>();
						pendingPosts[machine] = resolve;
						return promise;
					}
					return json({ ...(machine === "a" ? savedA : freshB), saved: ["default"] });
				}
				getCounts[machine] = (getCounts[machine] ?? 0) + 1;
				if (getCounts[machine] === 1) return json(machine === "a" ? initialA : initialB);
				if (machine === "b" && getCounts[machine] === 3) return json(freshB);
				const { promise, resolve } = Promise.withResolvers<Response>();
				pendingGets[machine] = resolve;
				return promise;
			}) as typeof fetch);
			setFleet(
				parseMachines([
					{ id: "a", name: "A", self: true, ok: true },
					{ id: "b", name: "B", ok: true },
				]),
			);
			selectMachine("*");
			const h = mount();
			await h.render(<ModelFlowRoute active />);
			await settle();
			await click(h.container.querySelector('button[aria-label="Change Default on B"]'));
			await pickModel(h.container, "anthropic/c");
			await click(byText(h.container, "button", "Save"));
			await openMenu(h.container, "Default");
			await click(byText(h.container, "button", "Apply B's value to all"));
			await reviewAndSave(h.container);
			await settle();
			await h.render(<ModelFlowRoute active={false} />);
			await h.render(<ModelFlowRoute active />);
			await settle();
			expect(getCounts).toEqual({ a: 2, b: 2 });
			pendingPosts.a(json({ ...savedA, saved: ["default"] }));
			await settle();
			if (!getBeforeLastPost) {
				pendingPosts.b(
					saveB ? json({ ...savedB, saved: ["default"] }) : json({ error: "changed", code: "stale" }, 409),
				);
				await settle();
			}
			pendingGets.a(json(initialA));
			pendingGets.b(json(freshB));
			await settle();
			expect(text(h.container)).toContain("anthropic/c");
			expect(text(h.container)).not.toContain("anthropic/a");
			if (saveB) expect(text(h.container)).not.toContain("openai/b");
			else expect(text(h.container)).toContain("openai/b");
			if (getBeforeLastPost) {
				pendingPosts.b(json({ error: "changed", code: "stale" }, 409));
				await settle();
			}
			expect(text(h.container)).toContain("anthropic/c");
			if (saveB) expect(text(h.container)).not.toContain("openai/b");
			else expect(text(h.container)).toContain("openai/b");
			if (!saveB) await click(byText(h.container, "button", "Reload and discard my changes"));
			await click(h.container.querySelector('button[aria-label="Change Default on A"]'));
			await pickModel(h.container, "p/m");
			await click(byText(h.container, "button", "Save"));
			await click(h.container.querySelector('button[aria-label="Change Default on B"]'));
			await pickModel(h.container, "p/m");
			await click(byText(h.container, "button", "Save"));
			await reviewAndSave(h.container);
			await settle();
			expect(postBodies.slice(2)).toEqual([
				{ machine: "a", revision: "a2" },
				{ machine: "b", revision: "b2" },
			]);
			await click(byText(h.container, "button", "Reload values"));
			await settle();
			pendingGets.a(json({ ...initialA, revision: "a3" }));
			pendingGets.b(json(freshB));
			await settle();
			expect(text(h.container)).toContain("anthropic/a");
			expect(text(h.container)).toContain("openai/b");
		},
	);
});

it("matches from the header machine only after review and reports unsupported targets", async () => {
	const sent: { machine: string; url: string; body: unknown }[] = [];
	const configurations: Record<string, ModelFlow> = {
		a: flow({
			revision: "a1",
			roles: [role("default", { model: "anthropic/c", thinking: "low", value: "anthropic/c:low" })],
		}),
		b: flow({ revision: "b1", roles: [role("default")] }),
		c: flow({
			revision: "c1",
			roles: [role("default")],
			models: MODELS.filter(model => model.selector !== "anthropic/c"),
		}),
		d: flow({ revision: "d1", roles: [role("default")] }),
	};
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const machine = String(input).match(/^\/m\/([abcd])\/api\/hub\/model-flow$/)?.[1];
		if (!machine) return json({ error: "unexpected" }, 500);
		if (init?.method === "POST") {
			sent.push({ machine, url: String(input), body: JSON.parse(String(init.body)) });
			return json({ ...configurations[machine], revision: "b2", saved: ["default"] });
		}
		return json(configurations[machine]);
	}) as typeof fetch);
	setFleet(
		parseMachines([
			{ id: "a", name: "A", self: true, ok: true },
			{ id: "b", name: "B", ok: true },
			{ id: "c", name: "C", ok: true },
			{ id: "d", name: "D", ok: true },
		]),
	);
	selectMachine("*");
	const h = mount();
	await h.render(<ModelFlowRoute active />);
	await settle();
	expect(isDisabled(byText(h.container, "button", "Make all machines match"))).toBe(true);
	expect(text(h.container)).toContain("Pick a machine in the header first");
	await act(async () => selectMachine("a"));
	await settle();
	await click(byText(h.container, "button", "Make all machines match A"));
	expect(sent).toHaveLength(0);
	expect(text(h.container)).toContain("not available on C");
	await click(byText(h.container, "button", "Review & save"));
	expect(text(h.container)).toContain("anthropic/a");
	expect(text(h.container)).toContain("anthropic/c");
	await click(save(h.container));
	await settle();
	expect(sent).toEqual([
		{
			machine: "b",
			url: "/m/b/api/hub/model-flow",
			body: { revision: "b1", roles: { default: { model: "anthropic/c", thinking: "low" } } },
		},
		{
			machine: "d",
			url: "/m/d/api/hub/model-flow",
			body: { revision: "d1", roles: { default: { model: "anthropic/c", thinking: "low" } } },
		},
	]);
	expect(text(h.container)).toContain("B: Saved 1 role(s).");
	expect(text(h.container)).toContain("D: Saved 1 role(s).");
});

it("words a failed save plainly and keeps the raw reason in the tooltip", async () => {
	const { c } = await open(() => json({ error: "machine identity check failed" }, 502));
	await editRole(c, "plan_verifier", "anthropic/c");
	await reviewAndSave(c);
	await settle();
	const line = byText(c, '.mf-callout[role="status"] span[title]', "Not saved");
	expect(visibleText(line!)).toBe("Not saved: its hub is a different version until it's updated");
	expect(visibleText(line!.parentElement!)).toBe(
		"This machine: Not saved: its hub is a different version until it's updated",
	);
	expect(line?.getAttribute("title")).toBe("machine identity check failed");
	expect(visibleText(c)).not.toContain("Not saved: machine identity check failed");
});

it("keeps the raw reason when a stale save's reload fails", async () => {
	let gets = 0;
	const { c } = await open(
		() => json({ error: "changed", code: "stale" }, 409),
		() => {
			gets++;
			if (gets > 1) throw new Error("request too old");
			return flow();
		},
	);
	await editRole(c, "plan_verifier", "anthropic/c");
	await reviewAndSave(c);
	await settle();
	const line = byText(c, '.mf-callout[role="status"] span[title]', "reload failed");
	expect(visibleText(line!)).toBe(
		"Config changed and reload failed: its clock is out of sync or its hub just restarted",
	);
	expect(line?.getAttribute("title")).toBe("request too old");
});

it("keeps a conflicted draft and retries with the refreshed revision", async () => {
	let current = flow();
	let saves = 0;
	const { calls, c } = await open(
		() => {
			saves++;
			if (saves === 1) {
				current = flow({ revision: "r2" });
				return json({ error: "changed", code: "stale" }, 409);
			}
			return json({
				...flow({
					revision: "r3",
					roles: [role("plan_verifier", { model: "anthropic/c", value: "anthropic/c", thinking: null })],
				}),
				saved: ["plan_verifier"],
			});
		},
		() => current,
	);
	await editRole(c, "plan_verifier", "anthropic/c");
	await reviewAndSave(c);
	await settle();
	expect(text(c)).toContain("r1 → r2");
	await click(byText(c, "button", "Reload and keep my changes"));
	await reviewAndSave(c);
	await settle();
	expect(
		posts(calls).map(call =>
			typeof call.body === "object" && call.body !== null && "revision" in call.body ? call.body.revision : null,
		),
	).toEqual(["r1", "r2"]);
	expect(text(c)).toContain("Saved 1 role(s).");
});

it("blocks copies while B's save is in flight, so copying A's Default and Planning afterwards keeps Planning", async () => {
	const twoRoles = (revision: string, model: string) =>
		flow({
			revision,
			roles: [
				role("default", { model, value: model, thinking: null }),
				role("plan", { model, value: model, thinking: null }),
			],
		});
	const configurations: Record<string, ModelFlow> = {
		a: twoRoles("a1", "anthropic/c"),
		b: twoRoles("b1", "anthropic/a"),
	};
	const pending: ((response: Response) => void)[] = [];
	const sent: unknown[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const machine = String(input).match(/^\/m\/([ab])\/api\/hub\/model-flow$/)?.[1];
		if (!machine) return json({ error: "unexpected" }, 500);
		if (init?.method === "POST") {
			sent.push(JSON.parse(String(init.body)));
			const { promise, resolve } = Promise.withResolvers<Response>();
			pending.push(resolve);
			return promise;
		}
		return json(configurations[machine]);
	}) as typeof fetch);
	setFleet(
		parseMachines([
			{ id: "a", name: "A", self: true, ok: true },
			{ id: "b", name: "B", ok: true },
		]),
	);
	selectMachine("a");
	const h = mount();
	await h.render(<ModelFlowRoute active />);
	await settle();
	const c = h.container;
	await click(c.querySelector('button[aria-label="Change Default on B"]'));
	await pickModel(c, "openai/b");
	await click(byText(c, "button", "Save"));
	await reviewAndSave(c);
	expect(sent).toEqual([{ revision: "b1", roles: { default: { model: "openai/b", thinking: null } } }]);
	// While B's POST is pending, copying is disabled and a programmatic copy stages nothing.
	expect(isDisabled(byText(c, "button", "Make all machines match A"))).toBe(true);
	expect(isDisabled(c.querySelector('button[aria-label="Actions for Planning"]'))).toBe(true);
	await click(byText(c, "button", "Make all machines match A"));
	expect(sent).toHaveLength(1);
	pending[0](
		json({
			...flow({
				revision: "b2",
				roles: [
					role("default", { model: "openai/b", value: "openai/b", thinking: null }),
					role("plan", { model: "anthropic/a", value: "anthropic/a", thinking: null }),
				],
			}),
			saved: ["default"],
		}),
	);
	await settle();
	// Now copy A's Default and Planning: both stage against B's saved revision.
	await click(byText(c, "button", "Make all machines match A"));
	await click(byText(c, "button", "Review & save"));
	await click(save(c));
	expect(sent[1]).toEqual({
		revision: "b2",
		roles: {
			default: { model: "anthropic/c", thinking: null },
			plan: { model: "anthropic/c", thinking: null },
		},
	});
	pending[1](json({ error: "x" }, 500));
	await settle();
});

describe("Model flow keyboard and filter states", () => {
	function twoMachines(saveTo: Record<string, ModelFlow> = {}) {
		const configurations: Record<string, ModelFlow> = {
			a: flow({ revision: "a1", roles: [role("default"), role("plan")] }),
			b: flow({
				revision: "b1",
				roles: [role("default", { model: "anthropic/c", value: "anthropic/c:high" }), role("plan")],
			}),
		};
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
			const machine = String(input).match(/^\/m\/([ab])\/api\/hub\/model-flow$/)?.[1];
			if (!machine) return json({ error: "unexpected" }, 500);
			if (init?.method === "POST") {
				configurations[machine] = saveTo[machine] ?? configurations[machine];
				return json({ ...configurations[machine], saved: ["default"] });
			}
			return json(configurations[machine]);
		}) as typeof fetch);
		setFleet(
			parseMachines([
				{ id: "a", name: "A", self: true, ok: true },
				{ id: "b", name: "B", ok: true },
			]),
		);
		selectMachine("*");
	}

	it("shows every role again after the last difference is saved with the filter on", async () => {
		twoMachines({ b: flow({ revision: "b2", roles: [role("default"), role("plan")] }) });
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		const c = h.container;
		const only = byText(c, "label", "Only rows that differ")?.querySelector("input") as HTMLInputElement & {
			_valueTracker?: { setValue: (v: string) => void };
		};
		// Tick the box the way a user's click does: flip `checked`, then raise the click React listens to.
		await act(async () => {
			only.checked = true;
			only._valueTracker?.setValue("false");
			only.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		expect(c.querySelectorAll("tbody tr")).toHaveLength(1);
		await click(c.querySelector('button[aria-label="Change Default on B"]'));
		await pickModel(c, "anthropic/a");
		await pickLevel(c, "high");
		await click(byText(c, "button", "Save"));
		await reviewAndSave(c);
		await settle();
		expect(text(c)).toContain("All 2 machines match");
		expect(c.querySelectorAll("tbody tr")).toHaveLength(2);
		expect(text(c)).not.toContain("None of the machines returned a config.yml");
	});

	it("traps focus in the review dialog and returns it to Review & save on every close", async () => {
		twoMachines();
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		const c = h.container;
		await click(c.querySelector('button[aria-label="Change Planning on B"]'));
		await pickModel(c, "anthropic/c");
		await click(byText(c, "button", "Save"));
		const reviewButton = () => byText(c, "button", "Review & save") as HTMLElement;
		for (const close of ["cancel", "escape", "outside"] as const) {
			reviewButton().focus();
			await click(reviewButton());
			const dialog = c.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;
			expect(document.activeElement).toBe(save(c));
			// Tab from the last control wraps to the first instead of leaving the dialog.
			await keydown(save(c)!, "Tab");
			expect(dialog.contains(document.activeElement)).toBe(true);
			expect(document.activeElement).not.toBe(save(c));
			if (close === "cancel") await click(byText(dialog, "button", "Cancel"));
			if (close === "escape") await keydown(dialog, "Escape");
			if (close === "outside") await click(c.querySelector(".mf-overlay"));
			expect(c.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
			expect(document.activeElement).toBe(reviewButton());
		}
	});

	it("opens the row menu from the keyboard and returns focus to its trigger", async () => {
		twoMachines();
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		const c = h.container;
		const trigger = c.querySelector('button[aria-label="Actions for Default"]') as HTMLElement;
		trigger.focus();
		await keydown(trigger, "ArrowDown");
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const items = [...c.querySelectorAll('[role="menuitem"]')];
		expect(document.activeElement).toBe(items.find(item => !item.hasAttribute("disabled")) ?? null);
		await keydown(document.activeElement!, "ArrowDown");
		expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
		await keydown(document.activeElement!, "Escape");
		expect(c.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await keydown(trigger, "ArrowDown");
		await click(document.activeElement);
		expect(c.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await keydown(trigger, "ArrowDown");
		await keydown(trigger, "Escape");
		expect(c.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});

describe("Model flow with machines that can't be read (D2, D3, D4)", () => {
	type Answer = ModelFlow | Response | "hang" | Partial<ModelFlow>;
	function fleetOf(answers: Record<string, () => Answer>, oks: Record<string, boolean> = {}) {
		const gets: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
			const machine = String(input).match(/^\/m\/([a-z])\/api\/hub\/model-flow$/)?.[1];
			if (!machine || init?.method === "POST") return json({ error: "unexpected" }, 500);
			gets.push(machine);
			const answer = answers[machine]();
			if (answer === "hang") return new Promise<Response>(() => {});
			return answer instanceof Response ? answer : json(answer);
		}) as typeof fetch);
		setFleet(
			parseMachines(
				Object.keys(answers).map((id, index) => ({
					id,
					name: id.toUpperCase(),
					self: index === 0,
					ok: oks[id] ?? true,
				})),
			),
		);
		return gets;
	}
	async function render(selected = "*") {
		selectMachine(selected);
		const h = mount();
		await h.render(<ModelFlowRoute active />);
		await settle();
		return h.container;
	}
	const column = (c: Element, machine: string) =>
		[...c.querySelectorAll(`tbody .mf-cell`)].filter(cell =>
			cell.querySelector(".mf-cell-machine")?.textContent?.includes(machine),
		);

	it("never shows Not set for a machine whose read failed, and leaves it out of the counts", async () => {
		const gets = fleetOf({
			a: () => flow(),
			b: () => json({ error: "machine unreachable", machine: "b" }, 502),
		});
		const c = await render();
		expect(visibleText(c)).not.toContain("Not set");
		expect(column(c, "B").every(cell => cell.textContent?.includes("No data"))).toBe(true);
		// The transport reason is worded plainly; the raw one stays in the tooltip.
		expect(visibleText(c)).toContain("Couldn't read config.yml from B: it isn't answering.");
		expect(c.querySelector('.mf-callout [title="machine unreachable"]')).not.toBeNull();
		expect(visibleText(c)).not.toContain("All 2 machines match");
		expect(visibleText(c)).toContain("Only A has current values");
		expect(visibleText(c)).toContain("Not compared: B: no data");
		expect(c.querySelector("thead .mf-coltag")?.textContent).toBe("no data");
		await click(byText(c, "button", "Try again"));
		await settle();
		expect(gets).toEqual(["a", "b", "b"]);
	});

	it.each([
		["machine identity check failed", true],
		["request too old", false],
		["request from the future", false],
		["request predates this process", false],
		["machine answered something other than data", false],
		["bad nonce", false],
		["bad fleet signature", false],
		["busy", false],
	])("says the hub is a different version only for a real proof mismatch (%s)", async (reason, version) => {
		fleetOf({ a: () => flow(), b: () => json({ error: reason }, 502) });
		const c = await render();
		const callout = byText(c, ".mf-callout", "Couldn't read config.yml from B");
		expect(visibleText(callout!).includes("different version")).toBe(version);
		if (reason.startsWith("request")) expect(visibleText(callout!)).toContain("clock is out of sync");
		// A failed read is re-asked automatically, so the callout may (and does) say so; nothing else claims it.
		expect(visibleText(callout!)).toContain("Retrying automatically.");
		expect(visibleText(c).toLowerCase().split("retrying").length - 1).toBe(1);
		expect(callout?.querySelector(`[title="${reason}"]`)).not.toBeNull();
	});

	describe("recovers on its own after a failed read (L3)", () => {
		/** Captures the automatic re-read timers; every other timer runs for real. */
		function captureRetries() {
			const due: { ms: number; run: () => void }[] = [];
			const real = globalThis.setTimeout;
			vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
				if (ms !== undefined && ms >= FLOW_RETRY_BASE_MS && ms <= 60_000 && ms !== 20_000) {
					due.push({ ms, run: fn });
					return 0 as unknown as ReturnType<typeof setTimeout>;
				}
				return real(fn, ms);
			}) as typeof setTimeout);
			return due;
		}
		const setHidden = (hidden: boolean) =>
			Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
		afterEach(() => setHidden(false));

		it("re-reads a machine that failed, with a growing delay, and fills its column back in", async () => {
			const due = captureRetries();
			let failB = 2;
			const gets = fleetOf({
				a: () => flow(),
				b: () => (failB-- > 0 ? json({ error: "no answer in time" }, 502) : flow()),
			});
			const c = await render();
			expect(visibleText(c)).toContain("Couldn't read config.yml from B: it didn't answer in time.");
			expect(visibleText(c)).toContain("Retrying automatically.");
			expect(due.map(item => item.ms)).toEqual([FLOW_RETRY_BASE_MS]);
			await act(async () => due.shift()!.run());
			await settle();
			expect(due.map(item => item.ms)).toEqual([FLOW_RETRY_BASE_MS * 2]);
			await act(async () => due.shift()!.run());
			await settle();
			expect(gets).toEqual(["a", "b", "b", "b"]);
			expect(visibleText(c)).not.toContain("Couldn't read config.yml");
			expect(visibleText(c)).not.toContain("Retrying");
			expect(visibleText(c)).toContain("All 2 machines match");
			expect(due).toHaveLength(0);
		});

		it("waits for the tab to be visible before re-reading", async () => {
			const due = captureRetries();
			let failB = 1;
			const gets = fleetOf({
				a: () => flow(),
				b: () => (failB-- > 0 ? json({ error: "machine unreachable" }, 502) : flow()),
			});
			const c = await render();
			setHidden(true);
			await act(async () => due.shift()!.run());
			await settle();
			expect(gets).toEqual(["a", "b"]);
			setHidden(false);
			await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
			await settle();
			expect(gets).toEqual(["a", "b", "b"]);
			expect(visibleText(c)).not.toContain("Couldn't read config.yml");
		});

		it("keeps unsaved edits when a failed machine's values come back", async () => {
			const due = captureRetries();
			let failB = 1;
			fleetOf({
				a: () => flow(),
				b: () => (failB-- > 0 ? json({ error: "machine unreachable" }, 502) : flow()),
			});
			const c = await render();
			await click(c.querySelector('button[aria-label="Change Default on A"]'));
			await pickModel(c, "anthropic/c");
			await click(byText(c, "button", "Save"));
			expect(visibleText(c)).toContain("1 change");
			await act(async () => due.shift()!.run());
			await settle();
			expect(visibleText(c)).not.toContain("Couldn't read config.yml");
			expect(visibleText(c)).toContain("1 change");
			expect(c.querySelector(".mf-cell[data-edited='true']")).not.toBeNull();
		});
	});

	it("treats an answer without roles as a failed read, not as every role unset", async () => {
		fleetOf({ a: () => flow(), b: () => flow(), c: () => ({ path: "x", revision: "r", roles: [], models: [] }) });
		const c = await render();
		expect(visibleText(c)).not.toContain("Not set");
		expect(visibleText(c)).toContain("Couldn't read config.yml from C: the hub answered without any roles");
		expect(visibleText(c)).toContain("A and B match");
		expect(visibleText(c)).toContain("C: no data");
		expect(visibleText(c)).toContain("Match 2/3");
		expect(visibleText(c)).not.toContain("All 3 machines match");
	});

	it("renders the machines that answered while another is still loading (D3)", async () => {
		fleetOf({ a: () => flow(), b: () => flow(), c: () => "hang" });
		const c = await render();
		expect(c.querySelector(".std-skeleton")).toBeNull();
		expect(c.querySelectorAll("tbody tr")).toHaveLength(3);
		expect(column(c, "C").every(cell => cell.textContent?.includes("Loading…"))).toBe(true);
		expect(visibleText(c)).not.toContain("Not set");
		expect(visibleText(c)).toContain("Not compared: C: loading");
	});

	it("shows a flapping machine's values as last known and keeps them out of the comparison", async () => {
		fleetOf(
			{
				a: () => flow(),
				b: () => flow({ roles: [role("default", { model: "openai/b", value: "openai/b", thinking: null })] }),
			},
			{ b: false },
		);
		const c = await render("b");
		expect(visibleText(c)).toContain("last known");
		expect(visibleText(c)).not.toContain("difference");
		expect(visibleText(c)).toContain("B: unreachable, last known values");
		expect(isDisabled(c.querySelector('button[aria-label="Change Default on B"]'))).toBe(true);
		// D4: the header machine can't be the source of "Make all machines match" while it is unreachable.
		expect(isDisabled(byText(c, "button", "Make all machines match B"))).toBe(true);
		expect(visibleText(c)).toContain("B is unreachable");
	});

	it("treats a machine in the hub's grace period as last known, not current", async () => {
		fleetOf({
			a: () => flow(),
			b: () => flow({ roles: [role("default", { model: "openai/b", value: "openai/b", thinking: null })] }),
		});
		setFleet(
			parseMachines([
				{ id: "a", name: "A", self: true, ok: true },
				{ id: "b", name: "B", ok: true, stale: true },
			]),
		);
		const c = await render("b");
		expect(visibleText(c)).toContain("last known");
		expect(visibleText(c)).not.toContain("difference");
		expect(visibleText(c)).toContain("B: not answering, last known values");
		expect(visibleText(c)).toContain("B hasn't answered recently");
		expect(isDisabled(byText(c, "button", "Make all machines match B"))).toBe(true);
	});

	it("disables Make all machines match when the header machine's read failed (D4)", async () => {
		fleetOf({ a: () => flow(), b: () => json({ error: "machine unreachable" }, 502) });
		const c = await render("b");
		expect(isDisabled(byText(c, "button", "Make all machines match B"))).toBe(true);
		expect(visibleText(c)).toContain("Couldn't read B's config.yml");
	});

	it("offers no copy from a machine without values in the row menu", async () => {
		fleetOf({
			a: () => flow(),
			b: () => flow({ roles: [role("default", { model: "openai/b", value: "openai/b", thinking: null })] }),
			c: () => json({ error: "machine unreachable" }, 502),
		});
		const c = await render();
		await openMenu(c, "Default");
		const item = (name: string) => byText(c, '[role="menuitem"]', `Apply ${name}'s value to all`);
		expect(isDisabled(item("A"))).toBe(false);
		expect(isDisabled(item("C"))).toBe(true);
		expect(item("C")?.textContent).toContain("no data");
		await click(item("A"));
		expect(visibleText(c)).toContain("No current values (no data); no changes staged.");
		expect(visibleText(c)).toContain("1 change");
	});

	it("marks the header machine's line on phones and uses short names", async () => {
		fleetOf({ a: () => flow(), b: () => flow() });
		setFleet(
			parseMachines([
				{ id: "a", name: "Ada Server", self: true, ok: true },
				{ id: "b", name: "Ada MacBook", ok: true },
			]),
		);
		const c = await render("b");
		const selectedCells = [...c.querySelectorAll('.mf-cell[data-selected="true"]')];
		expect(selectedCells).toHaveLength(3);
		expect(selectedCells.every(cell => cell.querySelector(".mf-cell-machine")?.textContent === "MacBook")).toBe(true);
		expect(selectedCells[0].querySelector(".mf-cell-machine")?.getAttribute("title")).toBe("Ada MacBook");
	});
});
