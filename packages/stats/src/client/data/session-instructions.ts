/**
 * The instruction files that apply to a session's folder (global first, then the folder's ancestors, then the
 * nearest project's omp rules), and a read-only preview of one listed file.
 */
import { hubFetch } from "./hub";

export interface InstructionFile {
	path: string;
	/** `global`, `workspace` or `rules` (omp's own rules files). */
	kind: string;
	size: number;
	/** ISO-8601 UTC. */
	mtime: string;
}

export interface InstructionFileText {
	path: string;
	size: number;
	text: string;
	truncated: boolean;
}

export function getSessionInstructions(
	sessionId: string,
	machine: string | undefined,
	signal?: AbortSignal,
): Promise<{ files: InstructionFile[] }> {
	return hubFetch(`sessions/${encodeURIComponent(sessionId)}/instructions`, { signal }, machine);
}

/** `path` is the listing's own path: the hub previews only a file it listed. */
export function getSessionInstructionFile(
	sessionId: string,
	path: string,
	machine: string | undefined,
	signal?: AbortSignal,
): Promise<InstructionFileText> {
	return hubFetch(
		`sessions/${encodeURIComponent(sessionId)}/instructions/file?path=${encodeURIComponent(path)}`,
		{ signal },
		machine,
	);
}

/** "~/projects/CLAUDE.md" for a home path. */
export function shortHome(path: string): string {
	return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

const KIND_LABEL: Record<string, string> = {
	global: "Global",
	workspace: "Folder",
	rules: "omp rules",
};

export function instructionKindLabel(kind: string): string {
	return KIND_LABEL[kind] ?? kind;
}
