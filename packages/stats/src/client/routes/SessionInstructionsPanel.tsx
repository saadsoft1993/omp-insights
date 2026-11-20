import { useState } from "react";
import { formatBytes } from "../data/formatters";
import type { HubSession } from "../data/hub";
import { useQuery } from "../data/query";
import { type CapabilityState, updateHubHint } from "../data/session-capabilities";
import {
	getSessionInstructionFile,
	getSessionInstructions,
	type InstructionFile,
	instructionKindLabel,
	shortHome,
} from "../data/session-instructions";
import { CapabilityChecking } from "./CapabilityChecking";
import { EmptyState, RelativeDateCell, StatusCell, Table } from "../ui";

/** The instruction files for the session's folder, global first; expanding one previews it read-only. */
export function SessionInstructionsPanel({
	session,
	machineName,
	capability,
	active,
}: {
	session: HubSession;
	machineName: string;
	capability: CapabilityState;
	active: boolean;
}) {
	const sessionId = session.sessionId ?? "";
	const machine = session.machine;
	const [open, setOpen] = useState<string | null>(null);
	const list = useQuery(
		["session-instructions", machine ?? "", sessionId],
		({ signal }) => getSessionInstructions(sessionId, machine, signal),
		{ enabled: active && capability === "on" && sessionId !== "", scope: "local" },
	);
	if (capability === "off") return <p className="sd-hint">{updateHubHint(machineName, "sessionInstructions")}</p>;
	if (capability === "unknown") return <CapabilityChecking machineName={machineName} />;
	const files = list.data?.files ?? [];
	return (
		<div className="sd-stack">
			<p className="sd-hint">
				The rules and instructions that apply to <span className="mono">{shortHome(session.cwd ?? "")}</span>,
				global first. Read-only. They apply to the folder; a session started earlier may have loaded an older copy.
			</p>
			<Table<InstructionFile>
				variant="std"
				dense
				title="Instruction files"
				rows={files}
				rowKey={file => file.path}
				loading={list.data == null && !list.error}
				error={list.error ? `Could not list the files: ${list.error.message}` : undefined}
				onRetry={list.refetch}
				empty={<EmptyState title="No instruction files apply" hint="Nothing global or in this folder." />}
				limit={20}
				onRowClick={file => setOpen(current => (current === file.path ? null : file.path))}
				expanded={file =>
					open === file.path ? (
						<InstructionPreview sessionId={sessionId} machine={machine} path={file.path} />
					) : null
				}
				columns={[
					{
						key: "path",
						header: "File",
						render: file => <span className="mono truncate">{shortHome(file.path)}</span>,
					},
					{
						key: "kind",
						header: "Kind",
						kind: "status",
						render: file => (
							<StatusCell tone={file.kind === "rules" ? "ok" : "neutral"}>
								{instructionKindLabel(file.kind)}
							</StatusCell>
						),
					},
					{ key: "size", header: "Size", kind: "number", priority: 2, render: file => formatBytes(file.size) },
					{
						key: "mtime",
						header: "Changed",
						kind: "date",
						priority: 3,
						render: file => <RelativeDateCell value={file.mtime} />,
					},
				]}
			/>
		</div>
	);
}

function InstructionPreview({
	sessionId,
	machine,
	path,
}: {
	sessionId: string;
	machine: string | undefined;
	path: string;
}) {
	const file = useQuery(
		["session-instruction-file", machine ?? "", sessionId, path],
		({ signal }) => getSessionInstructionFile(sessionId, path, machine, signal),
		{ scope: "local", retain: false },
	);
	if (file.error)
		return (
			<div className="sd-row">
				<p className="sd-hint" data-tone="bad" role="alert">
					Could not read it: {file.error.message}
				</p>
				<button type="button" className="btn" data-size="sm" onClick={file.refetch}>
					Try again
				</button>
			</div>
		);
	if (!file.data) return <p className="sd-hint">Loading…</p>;
	return (
		<div className="sd-stack">
			<pre className="sd-preview" aria-label={`Contents of ${shortHome(path)}`} tabIndex={0}>
				{file.data.text}
			</pre>
			{file.data.truncated && (
				<p className="sd-hint">Showing the first 64 KB of {formatBytes(file.data.size)}; secrets are redacted.</p>
			)}
		</div>
	);
}
