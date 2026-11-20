import { ApiError } from "../api";
import { hubPost } from "./hub";

export function historyError(error: unknown): string {
	if (error instanceof ApiError && error.status === 404 && error.message !== "archived or deleted")
		return "update this machine's hub";
	return error instanceof Error ? error.message : String(error);
}

export function resumeHistory(sessionId: string, machine?: string): Promise<{ sessionId: string }> {
	return hubPost("resume", { sessionId }, machine);
}
