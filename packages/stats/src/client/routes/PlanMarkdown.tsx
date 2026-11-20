import { createElement, type ReactNode, useEffect, useMemo, useState } from "react";
import type { RootContent } from "mdast";
import type { ParsedPlan } from "./plan-markdown-parser";

const MAX_PLAN_CHARS = 256 * 1024;
const MAX_DEPTH = 20;
const PARSE_TIMEOUT_MS = 1500;

function render(
	node: RootContent,
	source: string,
	depth: number,
	key: number,
	references: Map<string, string>,
): ReactNode {
	if (depth > MAX_DEPTH) {
		const start = node.position?.start.offset ?? 0;
		const end = node.position?.end.offset ?? start;
		return source.slice(start, end);
	}
	const children =
		"children" in node
			? node.children.map((child, i) => render(child as RootContent, source, depth + 1, i, references))
			: null;
	switch (node.type) {
		case "text":
		case "html":
			return node.value;
		case "heading":
			return createElement(`h${node.depth}`, { key }, children);
		case "paragraph":
			return <p key={key}>{children}</p>;
		case "emphasis":
			return <em key={key}>{children}</em>;
		case "strong":
			return <strong key={key}>{children}</strong>;
		case "delete":
			return <del key={key}>{children}</del>;
		case "inlineCode":
			return <code key={key}>{node.value}</code>;
		case "code":
			return (
				<div className="plan-md-code" key={key}>
					{node.lang && <span className="plan-md-language">{node.lang}</span>}
					<pre>
						<code>{node.value}</code>
					</pre>
				</div>
			);
		case "break":
			return <br key={key} />;
		case "thematicBreak":
			return <hr key={key} />;
		case "blockquote":
			return <blockquote key={key}>{children}</blockquote>;
		case "list":
			return node.ordered ? (
				<ol className="plan-md-ordered" key={key} start={node.start ?? undefined}>
					{children}
				</ol>
			) : (
				<ul className="plan-md-unordered" key={key}>
					{children}
				</ul>
			);
		case "listItem":
			return (
				<li key={key} className={node.checked != null ? "plan-md-task" : undefined}>
					{node.checked != null && (
						<input
							type="checkbox"
							checked={node.checked}
							disabled
							readOnly
							aria-label={node.checked ? "Completed" : "Not completed"}
						/>
					)}{" "}
					{children}
				</li>
			);
		case "link":
			return /^(?:https?:\/\/|mailto:)/i.test(node.url) ? (
				<a key={key} href={node.url} target="_blank" rel="noopener noreferrer">
					{children}
				</a>
			) : (
				<span key={key}>{children}</span>
			);
		case "image":
			return (
				<span key={key}>
					{node.alt ?? ""} ({node.url})
				</span>
			);
		case "linkReference": {
			const url = references.get(node.identifier.toLowerCase());
			return url && /^(?:https?:\/\/|mailto:)/i.test(url) ? (
				<a key={key} href={url} target="_blank" rel="noopener noreferrer">
					{children}
				</a>
			) : (
				<span key={key}>{children}</span>
			);
		}
		case "imageReference":
			return (
				<span key={key}>
					{node.alt ?? ""} ({references.get(node.identifier.toLowerCase()) ?? ""})
				</span>
			);
		case "table":
			if (depth >= MAX_DEPTH - 2)
				return source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
			return (
				<div className="plan-md-table" key={key}>
					<table>
						<thead>
							<tr>
								{node.children[0]?.children.map((cell, i) => (
									<th key={i} scope="col">
										{cell.children.map((child, j) =>
											render(child as RootContent, source, depth + 2, j, references),
										)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>{node.children.slice(1).map((row, i) => render(row, source, depth + 1, i, references))}</tbody>
					</table>
				</div>
			);
		case "tableRow":
			return <tr key={key}>{children}</tr>;
		case "tableCell":
			return <td key={key}>{children}</td>;
		default:
			return null;
	}
}

export function PlanMarkdown({ content }: { content: string }) {
	const [parsed, setParsed] = useState<{ source: string; result: ParsedPlan | null } | null>(null);
	useEffect(() => {
		let worker: Worker;
		if (content.length > MAX_PLAN_CHARS) {
			setParsed({ source: content, result: null });
			return;
		}
		try {
			worker = new Worker("/plan-markdown-worker.js", { type: "module" });
		} catch {
			setParsed({ source: content, result: null });
			return;
		}
		let active = true;
		const finish = (result: ParsedPlan | null) => {
			if (!active) return;
			active = false;
			clearTimeout(timer);
			worker.terminate();
			setParsed({ source: content, result });
		};
		const timer = setTimeout(() => finish(null), PARSE_TIMEOUT_MS);
		worker.onmessage = event => finish(event.data?.ok === true ? (event.data.result as ParsedPlan) : null);
		worker.onerror = () => finish(null);
		worker.onmessageerror = () => finish(null);
		try {
			worker.postMessage(content);
		} catch {
			finish(null);
		}
		return () => {
			active = false;
			clearTimeout(timer);
			worker.terminate();
		};
	}, [content]);
	const rendered = useMemo(() => {
		if (parsed?.source !== content || !parsed.result) return null;
		const references = new Map(parsed.result.references);
		return parsed.result.tree.children.map((node, i) => render(node, content, 0, i, references));
	}, [content, parsed]);
	const failed = parsed?.source === content && parsed.result === null;
	return (
		<div className="plan-md" tabIndex={0} aria-label="Plan">
			{rendered ?? (
				<>
					{failed && <p>Shown as plain text (too complex to format)</p>}
					<pre className="plan-md-remainder">{content}</pre>
				</>
			)}
		</div>
	);
}
