import { useState } from "react";
import { Modal, Segmented, Table, type Column } from "../../ui";
import { PlanMarkdown } from "../PlanMarkdown";
import { MR_STAGES, mrStatusCounts, type MergeRequest } from "./smsModel";
const label = (s: string) => s.replaceAll("-", " ").replace(/\b\w/g, c => c.toUpperCase());
export function MrsView({ items, tab, setTab }: { items: MergeRequest[]; tab: string; setTab: (tab: string) => void }) {
	const [selected, setSelected] = useState<MergeRequest | null>(null);
	const counts = mrStatusCounts(items);
	const chosen = tab === "all" || MR_STAGES.includes(tab as (typeof MR_STAGES)[number]) ? tab : "all";
	const visible = chosen === "all" ? items : items.filter(m => m.status === chosen);
	const cols: Column<MergeRequest>[] = [
		{ key: "project", header: "Repo", sort: m => m.project, render: m => m.project },
		{ key: "ref", header: "MR", sort: m => m.ref, render: m => m.ref },
		{
			key: "title",
			header: "Title",
			sort: m => m.title,
			render: m => (
				<button className="btn" onClick={() => setSelected(m)}>
					{m.title}
					{m.draft ? " · Draft" : ""}
				</button>
			),
		},
		{ key: "author", header: "Author", sort: m => m.author, render: m => m.author },
		{ key: "target", header: "Target", sort: m => m.target_branch, render: m => m.target_branch },
		{ key: "keys", header: "Linked", sort: m => m.keys.join(" "), render: m => m.keys.join(", ") },
		{ key: "updated", header: "Updated", sort: m => m.updated_at, render: m => m.updated_at },
		{
			key: "status",
			header: "Status",
			sort: m => m.status,
			render: m => (
				<span>
					{label(m.status)} · {m.status_via}
				</span>
			),
		},
	];
	return (
		<>
			<div className="sms-scroll">
				<Segmented
					value={chosen}
					onChange={setTab}
					options={["all", ...MR_STAGES].map(s => ({ value: s, label: `${label(s)} (${counts[s] || 0})` }))}
				/>
			</div>
			<Table
				rows={visible}
				columns={cols}
				rowKey={m => m.id}
				limit={100}
				initialSort={{ key: "updated", dir: "desc" }}
			/>
			<Modal
				open={!!selected}
				title={selected?.title || "Merge request"}
				onClose={() => setSelected(null)}
				cancelLabel="Close"
			>
				{selected && (
					<>
						<p>{selected.ref}</p>
						<p>
							<b>{label(selected.status)}</b> · via {selected.status_via}
						</p>
						<p>
							<a href={selected.url} target="_blank" rel="noopener noreferrer">
								Open in GitLab ↗
							</a>
						</p>
						<dl>
							<dt>GitLab state</dt>
							<dd>
								{[
									selected.state,
									selected.draft ? "draft" : "",
									selected.state === "opened" ? selected.detailed_merge_status : "",
									selected.has_conflicts ? "has conflicts" : "",
								]
									.filter(Boolean)
									.map(String)
									.join(" · ")}
							</dd>
							<dt>Branches</dt>
							<dd>
								{selected.source_branch} → {selected.target_branch}
							</dd>
							<dt>Author</dt>
							<dd>{selected.author}</dd>
							<dt>Created</dt>
							<dd>{String(selected.created_at || "—")}</dd>
							<dt>Updated</dt>
							<dd>{selected.updated_at}</dd>
							{!!selected.merged_at && (
								<>
									<dt>Merged</dt>
									<dd>{String(selected.merged_at)}</dd>
								</>
							)}
							{!selected.merged_at && !!selected.closed_at && (
								<>
									<dt>Closed</dt>
									<dd>{String(selected.closed_at)}</dd>
								</>
							)}
							<dt>Comments</dt>
							<dd>{String(selected.user_notes_count ?? 0)}</dd>
							<dt>Labels</dt>
							<dd>{Array.isArray(selected.labels) ? selected.labels.join(", ") : ""}</dd>
						</dl>
						<h3>Linked issues · {selected.links?.length || 0}</h3>
						{selected.links?.length ? (
							<ul>
								{selected.links.map(l => (
									<li key={`${l.url}-${l.key || l.ref}`}>
										<a href={l.url} target="_blank" rel="noopener noreferrer">
											{l.key || l.ref}
										</a>{" "}
										{l.ref || "not in the synced issues"} {l.status && label(l.status)} {l.title}
									</li>
								))}
							</ul>
						) : (
							<p>No linked issues.</p>
						)}
						<h3>Description</h3>
						<PlanMarkdown content={selected.description || "No description."} />
						{!!selected.description_cut && <p>Cut at 20,000 characters; the full text is in GitLab.</p>}
					</>
				)}
			</Modal>
		</>
	);
}
