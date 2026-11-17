import { afterEach, describe, expect, it, vi } from "bun:test";
import { ApiError } from "../src/client/api";
import {
	answerPlanReview,
	getPlanReview,
	type HubPlanReview,
	type HubSession,
	type PlanOption,
} from "../src/client/data/hub";
import {
	confirmText,
	feedbackProblem,
	needsYou,
	optionProblem,
	planErrorMessage,
	RESTART_FOR_PLAN,
} from "../src/client/data/plan-review";
import { PlanReviewPanel } from "../src/client/routes/PlanReviewPanel";
import { SessionsRoute } from "../src/client/routes/SessionsRoute";
import { all, byText, click, isDisabled, mount, settle, text, type, unmount } from "./helpers/memory-dom";

afterEach(unmount);

const OPTIONS: PlanOption[] = [
	{ id: "execute", label: "Approve and execute", disabled: false },
	{ id: "compact", label: "Approve and compact context", disabled: false },
	{ id: "keep", label: "Approve and keep context (~40k / 200k)", disabled: false },
	{ id: "refine", label: "Refine plan", disabled: false },
	{ id: "save", label: "Save and quit", disabled: false },
];

function review(over: Partial<Extract<HubPlanReview, { open: true }>> = {}): HubPlanReview {
	return {
		open: true,
		reviewId: "rev-1",
		title: "Add retry",
		planFilePath: "/tmp/plans/add-retry.md",
		options: OPTIONS,
		tiers: [
			{ role: "default", provider: "anthropic", model: "claude-opus" },
			{ role: "smol", provider: "anthropic", model: "claude-haiku" },
		],
		planContent: "# Plan\n- step one <b>not html</b>",
		truncated: false,
		...over,
	};
}

function session(over: Partial<HubSession> = {}): HubSession {
	return {
		instanceId: "inst-1",
		sessionId: "sess-1",
		cwd: "/Users/me/projects/sample-app",
		sessionName: "Retry work",
		busy: false,
		planControl: "supported",
		planReview: { reviewId: "rev-1", title: "Add retry", openedAt: "2026-11-16T08:00:00Z" },
		waitingSince: Date.now() - 120_000,
		...over,
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
	url: string;
	method: string;
	body: Record<string, unknown> | null;
}

/** Routes /plan-review and /plan-answer; every request is recorded. */
function mockHub(handlers: {
	review?: () => Response | Promise<Response>;
	answer?: (body: Record<string, unknown>) => Response | Promise<Response>;
	sessions?: () => Response;
}) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		calls.push({ url, method: init?.method ?? "GET", body });
		if (url.endsWith("/plan-review")) return handlers.review?.() ?? json(review());
		if (url.endsWith("/plan-answer")) return handlers.answer?.(body ?? {}) ?? json({ outcome: "accepted" });
		if (url === "/api/hub/sessions") return handlers.sessions?.() ?? json({ sessions: [], now: Date.now() });
		if (url === "/api/hub/quota") return json({ generatedAt: null, cacheAgeMs: null, cacheStale: false, source: "", providers: {}, accounts: [] });
		return json({ projects: [] });
	}) as typeof fetch);
	return calls;
}

const answers = (calls: Call[]) => calls.filter(c => c.url.endsWith("/plan-answer"));

/** Press an option button, then the dialog's confirming button. */
async function choose(h: ReturnType<typeof mount>, label: string) {
	await click(byText(h.container, ".plan-actions button", label));
	const dialog = h.body.querySelector("[role=dialog]");
	expect(dialog).not.toBeNull();
	return dialog as Element;
}

async function confirm(dialog: Element) {
	await click(dialog.querySelector("button[data-variant=primary]"));
	await settle();
}

describe("plan review requests", () => {
	it("fetches the review and posts the answer with the hub's header", async () => {
		const calls = mockHub({});
		expect(await getPlanReview("a/b")).toMatchObject({ open: true });
		await answerPlanReview("a/b", { reviewId: "r", choice: "refine", feedback: "shorter" });
		expect(calls[0]).toMatchObject({ url: "/api/hub/sessions/a%2Fb/plan-review", method: "GET" });
		expect(calls[1]).toMatchObject({
			url: "/api/hub/sessions/a%2Fb/plan-answer",
			method: "POST",
			body: { reviewId: "r", choice: "refine", feedback: "shorter" },
		});
		const init = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1][1];
		expect((init.headers as Record<string, string>)["X-Omp-Hub"]).toBe("1");
	});

	it("keeps the error code and message from the response body", async () => {
		mockHub({ answer: () => json({ error: "nope", code: "changed" }, 409), review: () => json({ error: "x" }, 502) });
		const error = await answerPlanReview("s", { reviewId: "r", choice: "save" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 409, code: "changed", message: "nope" });
		const noCode = await getPlanReview("s").catch((e: unknown) => e);
		expect(noCode).toMatchObject({ status: 502, code: null });
	});
});

describe("plan review rules", () => {
	it("counts a plan review as needing you", () => {
		expect(needsYou({ instanceId: "a" })).toBe(false);
		expect(needsYou({ instanceId: "a", inputRequired: true })).toBe(true);
		expect(needsYou(session())).toBe(true);
		expect(needsYou(session({ planReview: null }))).toBe(false);
	});

	it("needs non-blank feedback of at most 8000 characters for refine", () => {
		expect(feedbackProblem("   ")).not.toBeNull();
		expect(feedbackProblem("x".repeat(8000))).toBeNull();
		expect(feedbackProblem("x".repeat(8001))).not.toBeNull();
		// UTF-16 code units, like the hub and the plugin: an emoji is 2
		expect(feedbackProblem("😀".repeat(4000))).toBeNull();
		expect(feedbackProblem("😀".repeat(4001))).not.toBeNull();
	});

	it("explains why an option is off", () => {
		const idle = { truncated: false, feedback: "", busy: false, stale: false };
		const [execute, , keep, refine, save] = [OPTIONS[0], OPTIONS[1], OPTIONS[2], OPTIONS[3], OPTIONS[4]];
		expect(optionProblem(execute, idle)).toBeNull();
		expect(optionProblem(refine, idle)).not.toBeNull();
		expect(optionProblem(refine, { ...idle, feedback: "x" })).toBeNull();
		expect(optionProblem(execute, { ...idle, truncated: true })).not.toBeNull();
		expect(optionProblem(save, { ...idle, truncated: true })).toBeNull();
		expect(optionProblem({ ...keep, disabled: true }, idle)).not.toBeNull();
		expect(optionProblem(execute, { ...idle, busy: true })).not.toBeNull();
		expect(optionProblem(execute, { ...idle, stale: true })).not.toBeNull();
	});

	it("words the confirmations and every 409 code", () => {
		expect(confirmText("execute", "Add retry")).toBe("Approve 'Add retry' and start execution in this session?");
		expect(confirmText("save", "x")).toBe(
			"Save the plan, leave plan mode and start a fresh session? The omp process keeps running.",
		);
		const messages = ["not_accepted", "restart_needed", "changed", "stale_session", "truncated"].map(code =>
			planErrorMessage(new ApiError(409, "/e", "raw server text", code)),
		);
		expect(new Set(messages).size).toBe(5);
		expect(messages).not.toContain("raw server text");
		expect(messages[1]).toBe(RESTART_FOR_PLAN);
		expect(planErrorMessage(new ApiError(400, "/e", "Feedback is required", "invalid"))).toBe("Feedback is required");
	});
});

describe("plan review panel", () => {
	it("shows the title, path, note, plan as plain text and the five options in order", async () => {
		mockHub({});
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		const body = text(h.container);
		expect(body).toContain("Add retry");
		expect(body).toContain("/tmp/plans/add-retry.md");
		expect(body).toContain("Edits made inside the terminal review are not shown here.");
		const plan = h.container.querySelector(".plan-text");
		expect(plan?.textContent).toContain("<b>not html</b>");
		expect(plan?.querySelector("b")).toBeNull();
		expect(all(h.container, ".plan-actions button").map(b => b.textContent)).toEqual(OPTIONS.map(o => o.label));
	});

	it("disables the unavailable keep option and Refine until feedback is typed", async () => {
		mockHub({
			review: () =>
				json(review({ options: OPTIONS.map(o => (o.id === "keep" ? { ...o, disabled: true } : o)) })),
		});
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		const button = (label: string) => byText(h.container, ".plan-actions button", label);
		expect(isDisabled(button("Approve and keep context"))).toBe(true);
		expect(isDisabled(button("Approve and execute"))).toBe(false);
		expect(isDisabled(button("Refine plan"))).toBe(true);
		await type(h.container.querySelector("textarea"), "make it shorter");
		expect(isDisabled(button("Refine plan"))).toBe(false);
		await type(h.container.querySelector("textarea"), "   ");
		expect(isDisabled(button("Refine plan"))).toBe(true);
	});

	it("sends no role by default and the chosen tier only with an approval", async () => {
		const calls = mockHub({});
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		const select = h.container.querySelector("select");
		expect(all(h.container, "select option").map(o => o.textContent)).toEqual([
			"Terminal's selection",
			"anthropic/claude-opus",
			"anthropic/claude-haiku",
		]);
		await confirm(await choose(h, "Approve and execute"));
		expect(answers(calls)[0].body).toEqual({ reviewId: "rev-1", choice: "execute" });

		await type(select, "smol");
		await confirm(await choose(h, "Approve and compact"));
		expect(answers(calls)[1].body).toEqual({ reviewId: "rev-1", choice: "compact", role: "smol" });

		await type(h.container.querySelector("textarea"), "tighten step 2");
		await confirm(await choose(h, "Refine plan"));
		expect(answers(calls)[2].body).toEqual({ reviewId: "rev-1", choice: "refine", feedback: "tighten step 2" });
		await confirm(await choose(h, "Save and quit"));
		expect(answers(calls)[3].body).toEqual({ reviewId: "rev-1", choice: "save" });
	});

	it("asks before sending, with the plan's wording, and Cancel sends nothing", async () => {
		const calls = mockHub({});
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		const dialog = await choose(h, "Approve and execute");
		expect(text(dialog)).toContain("Approve 'Add retry' and start execution in this session?");
		await click(byText(dialog, "button", "Cancel"));
		expect(answers(calls)).toHaveLength(0);
		const save = await choose(h, "Save and quit");
		expect(text(save)).toContain("The omp process keeps running.");
	});

	it("refetches after an accepted answer and says so", async () => {
		const calls = mockHub({});
		let changed = 0;
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => changed++} />);
		await settle();
		const before = calls.filter(c => c.url.endsWith("/plan-review")).length;
		await confirm(await choose(h, "Approve and execute"));
		expect(text(h.container)).toContain("Answer accepted by the session.");
		expect(calls.filter(c => c.url.endsWith("/plan-review")).length).toBe(before + 1);
		expect(changed).toBe(1);
	});

	it("does not send twice on a duplicate submit, and locks the buttons while it is in flight", async () => {
		let release: (r: Response) => void = () => {};
		const calls = mockHub({ answer: () => new Promise<Response>(resolve => (release = resolve)) });
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		const dialog = await choose(h, "Approve and execute");
		const primary = dialog.querySelector("button[data-variant=primary]");
		await click(primary);
		await click(primary);
		await settle();
		expect(answers(calls)).toHaveLength(1);
		expect(all(h.container, ".plan-actions button").every(b => isDisabled(b))).toBe(true);
		await settle();
		release(json({ outcome: "accepted" }));
		await settle();
		expect(answers(calls)).toHaveLength(1);
		expect(isDisabled(byText(h.container, ".plan-actions button", "Approve and execute"))).toBe(false);
	});

	it("gives each 409 code its own message", async () => {
		for (const [code, expected] of [
			["not_accepted", "The terminal did not accept that answer"],
			["restart_needed", RESTART_FOR_PLAN],
			["changed", "The plan review changed"],
			["stale_session", "restarted or replaced"],
			["truncated", "longer than the hub can show"],
		] as const) {
			mockHub({ answer: () => json({ error: "raw", code }, 409) });
			const h = mount();
			await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
			await settle();
			await confirm(await choose(h, "Approve and execute"));
			expect(text(h.container)).toContain(expected);
			expect(text(h.container)).not.toContain("raw");
			await unmount();
		}
	});

	it("turns approvals off for a truncated plan but keeps Refine and Save", async () => {
		mockHub({ review: () => json(review({ truncated: true })) });
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		const button = (label: string) => byText(h.container, ".plan-actions button", label);
		for (const label of ["Approve and execute", "Approve and compact", "Approve and keep"]) {
			expect(isDisabled(button(label))).toBe(true);
		}
		expect(isDisabled(button("Save and quit"))).toBe(false);
		expect(text(h.container)).toContain("longer than the hub can show");
	});

	it("ignores a plan response that arrives after a newer one", async () => {
		const pending: ((r: Response) => void)[] = [];
		mockHub({ review: () => new Promise<Response>(resolve => pending.push(resolve)) });
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await h.render(
			<PlanReviewPanel
				session={session({ planReview: { reviewId: "rev-2", title: "Second", openedAt: "2026-11-16T09:00:00Z" } })}
				onChanged={() => {}}
			/>,
		);
		expect(pending).toHaveLength(2);
		pending[1](json(review({ reviewId: "rev-2", title: "Second plan" })));
		await settle();
		pending[0](json(review({ reviewId: "rev-1", title: "First plan" })));
		await settle();
		const body = text(h.container);
		expect(body).toContain("Second plan");
		expect(body).not.toContain("First plan");
		expect(isDisabled(byText(h.container, ".plan-actions button", "Approve and execute"))).toBe(false);
	});

	it("drops an open confirmation when the review is replaced, and never answers the new review", async () => {
		const pending: ((r: Response) => void)[] = [];
		const calls = mockHub({
			review: () => (pending.length === 0 ? (pending.push(() => {}), json(review())) : new Promise<Response>(r => pending.push(r))),
		});
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		await choose(h, "Approve and execute");
		const b = session({ planReview: { reviewId: "rev-2", title: "Second", openedAt: "2026-11-16T09:00:00Z" } });
		await h.render(<PlanReviewPanel session={b} onChanged={() => {}} />);
		expect(h.body.querySelector("[role=dialog]")).toBeNull();
		pending[1](json(review({ reviewId: "rev-2", title: "Second plan" })));
		await settle();
		expect(h.body.querySelector("[role=dialog]")).toBeNull();
		expect(answers(calls)).toHaveLength(0);
	});

	it("offers Retry after a failed fetch and retries on the next list poll", async () => {
		let fail = true;
		const calls = mockHub({ review: () => (fail ? json({ error: "boom" }, 502) : json(review())) });
		const h = mount();
		const s = session();
		await h.render(<PlanReviewPanel session={s} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("Retry");
		const fetches = () => calls.filter(c => c.url.endsWith("/plan-review")).length;
		expect(fetches()).toBe(1);
		await click(byText(h.container, "button", "Retry"));
		await settle();
		expect(fetches()).toBe(2);
		// a poll delivers a new session object: one automatic retry, still failing
		await h.render(<PlanReviewPanel session={{ ...s }} onChanged={() => {}} />);
		await settle();
		expect(fetches()).toBe(3);
		fail = false;
		await h.render(<PlanReviewPanel session={{ ...s }} onChanged={() => {}} />);
		await settle();
		expect(h.container.querySelector(".plan-actions")).not.toBeNull();
		expect(text(h.container)).not.toContain("Retry");
		// healthy again: further polls do not refetch
		const done = fetches();
		await h.render(<PlanReviewPanel session={{ ...s }} onChanged={() => {}} />);
		await settle();
		expect(fetches()).toBe(done);
	});

	it("stops retrying on polls after a bounded number of attempts", async () => {
		const calls = mockHub({ review: () => json({ error: "boom" }, 502) });
		const h = mount();
		const s = session();
		await h.render(<PlanReviewPanel session={s} onChanged={() => {}} />);
		await settle();
		for (let i = 0; i < 12; i++) {
			await h.render(<PlanReviewPanel session={{ ...s }} onChanged={() => {}} />);
			await settle();
		}
		expect(calls.filter(c => c.url.endsWith("/plan-review")).length).toBeLessThanOrEqual(7);
	});

	it("disables the controls and says so when the review closes", async () => {
		mockHub({});
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		await h.render(<PlanReviewPanel session={session({ planReview: null })} onChanged={() => {}} />);
		// closed with nothing to say: nothing is shown
		expect(h.container.querySelector(".plan-review")).toBeNull();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		await confirm(await choose(h, "Approve and execute"));
		await h.render(<PlanReviewPanel session={session({ planReview: null })} onChanged={() => {}} />);
		const body = text(h.container);
		expect(body).toContain("closed or was replaced");
		expect(all(h.container, ".plan-actions button").every(b => isDisabled(b))).toBe(true);
	});

	it("reports a review that closed between the list and the fetch", async () => {
		mockHub({ review: () => json({ open: false }) });
		const h = mount();
		await h.render(<PlanReviewPanel session={session()} onChanged={() => {}} />);
		await settle();
		expect(text(h.container)).toContain("closed or was replaced");
		expect(h.container.querySelector(".plan-actions")).toBeNull();
	});
});

describe("Sessions page with a plan review", () => {
	function withMedia(h: ReturnType<typeof mount>) {
		(globalThis.window as unknown as Record<string, unknown>).matchMedia = () => ({
			matches: true,
			addEventListener() {},
			removeEventListener() {},
		});
		return h;
	}

	it("lists it under Needs you with the badge, and offers the restart hint for old sessions", async () => {
		const sessions = [
			session(),
			session({ instanceId: "inst-2", sessionId: "sess-2", sessionName: "Old one", planControl: "restart_needed" }),
			{ instanceId: "inst-3", sessionId: "sess-3", sessionName: "Quiet", busy: false },
			{ instanceId: "inst-4", sessionId: "sess-4", sessionName: "Old idle", busy: false, planReview: null, planControl: "restart_needed" as const },
		];
		mockHub({ sessions: () => json({ sessions, now: Date.now() }) });
		const h = withMedia(mount());
		await h.render(<SessionsRoute active selected={null} onSelect={() => {}} />);
		await settle();
		const needs = h.container.querySelector(".sess-group[data-needs=true]");
		expect(needs?.textContent).toContain("Needs you · 2");
		expect(needs?.textContent).toContain("Plan to approve");
		expect(needs?.textContent).not.toContain("Quiet");
		expect(h.container.textContent).not.toContain("waiting (age unknown)");

		await h.render(<SessionsRoute active selected="sess-2" onSelect={() => {}} />);
		await settle();
		expect(text(h.container)).toContain(RESTART_FOR_PLAN);
		expect(h.container.querySelector(".plan-review")).toBeNull();

		// the hub sends restart_needed with no review open: the hint still shows
		await h.render(<SessionsRoute active selected="sess-4" onSelect={() => {}} />);
		await settle();
		expect(text(h.container)).toContain(RESTART_FOR_PLAN);

		await h.render(<SessionsRoute active selected="sess-1" onSelect={() => {}} />);
		await settle();
		expect(h.container.querySelector(".plan-review")).not.toBeNull();
	});
});
