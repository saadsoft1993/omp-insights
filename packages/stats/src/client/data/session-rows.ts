import type { SessionSummary } from "../types";

export type SessionRow = SessionSummary & { machine?: string };

export function sessionRowKey(row: SessionRow): string {
	return `${row.machine ?? ""}:${row.file}`;
}

/** Descending end time. Equal timestamps retain their existing order. */
export function compareSessionEnd(a: SessionSummary, b: SessionSummary): number {
	return b.endedAt - a.endedAt;
}

export function sessionFolder(folder: string, mode: "short" | "home"): string {
	return mode === "short"
		? folder.split("/").slice(-2).join("/")
		: folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}
