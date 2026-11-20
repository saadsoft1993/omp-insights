import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Root, RootContent } from "mdast";

export interface ParsedPlan {
	tree: Root;
	references: [string, string][];
}

/** Runs only in the worker. Bound the transferable tree as well as React's rendering work. */
export function parsePlan(source: string): ParsedPlan {
	const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	const references = new Map<string, string>();
	const pending: Array<{ node: Root | RootContent; depth: number }> = [{ node: tree, depth: 0 }];
	let count = 0;
	while (pending.length) {
		const { node, depth } = pending.pop()!;
		if (++count > 10000) throw new Error("plan too complex");
		if (node.type === "definition" && !references.has(node.identifier.toLowerCase())) {
			references.set(node.identifier.toLowerCase(), node.url);
		}
		if ("children" in node) {
			for (let i = node.children.length - 1; i >= 0; i--) {
				pending.push({ node: node.children[i] as RootContent, depth: depth + 1 });
			}
		}
	}
	const prune: Array<{ node: Root | RootContent; depth: number }> = [{ node: tree, depth: 0 }];
	while (prune.length) {
		const { node, depth } = prune.pop()!;
		if (!("children" in node)) continue;
		if (depth >= 20) {
			const start = node.position?.start.offset ?? 0;
			const end = node.position?.end.offset ?? start;
			Object.assign(node, { type: "text", value: source.slice(start, end) });
			Reflect.deleteProperty(node, "children");
		} else {
			for (const child of node.children) prune.push({ node: child as RootContent, depth: depth + 1 });
		}
	}
	return { tree, references: [...references] };
}
