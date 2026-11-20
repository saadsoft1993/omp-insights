import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import { PlanMarkdown } from "../src/client/routes/PlanMarkdown";
import { PlanReviewPanel } from "../src/client/routes/PlanReviewPanel";
import { mount, settle, unmount } from "./helpers/memory-dom";
import { installPlanWorker, PlanWorker } from "./helpers/plan-worker";

beforeEach(installPlanWorker);

afterEach(unmount);

describe("plan markdown", () => {
	it("keeps prose readable without constraining code or tables", async () => {
		const css = readFileSync(new URL("../src/client/routes/hub.css", import.meta.url), "utf8");
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, declarations]) => ({
			selector: selector.trim(),
			declarations,
		}));
		const region = rules.find(rule => rule.selector === ".plan-md");
		expect(region).toBeDefined();
		expect(region!.declarations).not.toMatch(/(?:^|;)\s*max-height\s*:/);
		expect(css).toMatch(/@media\s*\(max-width:\s*640px\)\s*\{\s*\.plan-md\s*\{[^}]*padding-inline:\s*0\s*;/);

		const h = mount();
		await h.render(
			<PlanMarkdown
				content={
					"Paragraph\n\n- item\n\n  ```ts\n  list code\n  ```\n\n1. numbered\n\n> quote\n>\n> ```ts\n> quote code\n> ```\n\n| `Exit code` |\n| - |\n| `Result` |"
				}
			/>,
		);
		const caps = rules.filter(rule => /(?:^|;)\s*max-width\s*:\s*78ch\s*;/.test(rule.declarations));
		expect(caps.some(rule => h.container.querySelector(`${rule.selector}`)?.tagName === "P")).toBe(true);
		for (const selector of [".plan-md-code", ".plan-md-table", "ul", "ol", "li", "blockquote"]) {
			const elements = h.container.querySelectorAll(selector);
			expect(elements.length).toBeGreaterThan(0);
			for (const element of elements) expect(caps.some(rule => element.matches(rule.selector))).toBe(false);
		}
		expect(h.container.querySelector("li .plan-md-code")).not.toBeNull();
		const listParagraph = h.container.querySelector("li > p");
		expect(listParagraph).not.toBeNull();
		expect(caps.some(rule => listParagraph!.matches(rule.selector))).toBe(true);
		const listParagraphStyle = rules.find(rule => rule.selector === ".plan-md li > p");
		expect(listParagraphStyle?.declarations).toMatch(/display:\s*block/);
		expect(listParagraphStyle?.declarations).toMatch(/margin:\s*0\s*;/);
		expect(h.container.querySelector("blockquote .plan-md-code")).not.toBeNull();
		const inlineCode = rules.find(rule => rule.selector === ".plan-md :not(pre) > code");
		expect(inlineCode?.declarations).toMatch(/(?:^|;)\s*background\s*:\s*var\(--raised\)/);
		const cellWrap = rules.find(rule => rule.declarations.includes("overflow-wrap: break-word"));
		expect(cellWrap?.declarations).toMatch(/word-break:\s*normal/);
		for (const selector of ["th", "td", "th code", "td code"]) {
			const element = h.container.querySelector(selector);
			expect(element).not.toBeNull();
			expect(element!.matches(cellWrap!.selector)).toBe(true);
		}
		const cellSize = rules.find(rule => rule.selector === ".plan-md td,\n.plan-md th");
		expect(css).toMatch(
			/@media\s*\(max-width:\s*640px\)\s*\{\s*\.plan-md td,\s*\.plan-md th\s*\{[^}]*min-width:\s*9em\s*;/,
		);
		expect(cellSize?.declarations).toMatch(/max-width:\s*32em\s*;/);
		const taskItem = rules.find(rule => rule.selector === ".plan-md li.plan-md-task");
		const taskCheckbox = rules.find(rule => rule.selector === ".plan-md li.plan-md-task > input");
		expect(taskItem?.declarations).toMatch(/position:\s*relative/);
		expect(taskItem?.declarations).toMatch(/padding-left:\s*1\.5em/);
		expect(taskCheckbox?.declarations).toMatch(/position:\s*absolute/);
	});

	it("renders GFM, code, lists and inline formatting", async () => {
		const h = mount();
		await h.render(
			<PlanMarkdown
				content={
					"# Title\n\n**bold** *italic* ~~gone~~ `code`\n\n| A | B |\n| - | - |\n| x | y |\n\n```ts\nconst a = 1;\n```\n\n- parent\n  - [x] child\n\n> quoted\n\n---"
				}
			/>,
		);
		expect(h.container.querySelector("h1")?.textContent).toBe("Title");
		for (const tag of ["strong", "em", "del", "code", "table", "blockquote", "hr"])
			expect(h.container.querySelector(tag)).not.toBeNull();
		expect(h.container.querySelector(".plan-md-language")?.textContent).toBe("ts");
		expect(h.container.querySelector("ul ul input[type=checkbox]")).not.toBeNull();
		expect(h.container.querySelector("ul.plan-md-unordered")).not.toBeNull();
		expect(h.container.querySelector("li.plan-md-task")).not.toBeNull();
		await h.render(<PlanMarkdown content={"1. first\n2. second"} />);
		expect(h.container.querySelector("ol.plan-md-ordered")).not.toBeNull();
	});

	it("renders only safe links and never renders HTML or images", async () => {
		const h = mount();
		await h.render(
			<PlanMarkdown
				content={
					"[safe](https://example.com) [bad](javascript:alert) ![alt](https://example.com/pixel)\n\n<script>alert(1)</script>\n\ninline <img src=x onerror=alert(1)>"
				}
			/>,
		);
		const a = h.container.querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com");
		expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(h.container.querySelectorAll("a").length).toBe(1);
		for (const tag of ["script", "img", "[onerror]"]) expect(h.container.querySelector(tag)).toBeNull();
		expect(h.container.textContent).toContain("<script>alert(1)</script>");
		expect(h.container.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(h.container.textContent).toContain("https://example.com/pixel");
	});

	it("caps nested AST nodes and preserves the remainder", async () => {
		const h = mount();
		const content = "> ".repeat(30) + "deep";
		await h.render(<PlanMarkdown content={content} />);
		expect(h.container.textContent).toContain("deep");
		expect(h.container.querySelectorAll("blockquote").length).toBeLessThanOrEqual(20);
	});

	it("does not treat fenced code as nesting", async () => {
		const h = mount();
		await h.render(<PlanMarkdown content={"```text\n" + "[x\n".repeat(25) + "```\n\n# After"} />);
		expect(h.container.querySelector("pre code")?.textContent).toContain("[x");
		expect(h.container.querySelector("h1")?.textContent).toBe("After");
	});

	it("resolves nested definitions and keeps the first definition", async () => {
		const h = mount();
		await h.render(
			<PlanMarkdown content={"> [ref]: https://first.example\n\n[ref]: https://second.example\n\n[link][ref]"} />,
		);
		expect(h.container.querySelector("a")?.getAttribute("href")).toBe("https://first.example");
	});

	it("times out both adversarial plans and shows their text", async () => {
		vi.useFakeTimers();
		try {
			const h = mount();
			for (const content of ["a*b*".repeat(50000), "- > ".repeat(1000)]) {
				await h.render(<PlanMarkdown content={content} />);
				const worker = PlanWorker.instances.at(-1)!;
				expect(worker.url).toBe("/plan-markdown-worker.js");
				expect(worker.options).toEqual({ type: "module" });
				await act(async () => {
					vi.advanceTimersByTime(1500);
				});
				expect(h.container.textContent).toContain("Shown as plain text (too complex to format)");
				expect(h.container.querySelector(".plan-md-remainder")?.textContent).toBe(content);
				expect(worker.terminated).toBe(true);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows plain text if the worker cannot load or the input exceeds the limit", async () => {
		const h = mount();
		await h.render(<PlanMarkdown content={"- > ".repeat(1000)} />);
		await act(async () => {
			PlanWorker.instances.at(-1)?.onerror?.();
		});
		expect(h.container.textContent).toContain("Shown as plain text (too complex to format)");
		const count = PlanWorker.instances.length;
		const large = "x".repeat(256 * 1024 + 1);
		await h.render(<PlanMarkdown content={large} />);
		expect(PlanWorker.instances.length).toBe(count);
		expect(h.container.querySelector(".plan-md-remainder")?.textContent).toBe(large);
	});

	it("keeps the panel's plan region focusable and labelled", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					open: true,
					reviewId: "r",
					title: "Plan",
					planContent: "# Hello",
					options: [],
					tiers: null,
					truncated: false,
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
		);
		const h = mount();
		await h.render(
			<PlanReviewPanel
				session={{
					instanceId: "i",
					sessionId: "s",
					cwd: "/",
					sessionName: "s",
					busy: false,
					planControl: "supported",
					planReview: { reviewId: "r", title: "Plan", openedAt: "2026-11-16T08:00:00Z" },
				}}
				onChanged={() => {}}
			/>,
		);
		await settle();
		const region = h.container.querySelector('[aria-label="Plan"]');
		expect(region?.getAttribute("tabindex")).toBe("0");
		expect(region?.querySelector("h1")?.textContent).toBe("Hello");
	});
});
