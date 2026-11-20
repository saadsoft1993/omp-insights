import { hubFetch, hubPost } from "./hub";

export interface ConnectionAccount {
	credentialId?: number;
	identity: string;
	email?: string | null;
	label: string | null;
	accountId: string | null;
	orgId: string | null;
	type: "oauth" | "api_key";
	expiresAt: number | null;
	ok: boolean;
	managed: boolean;
	priority: number;
	policyMatched: boolean;
}

export interface ConnectionProvider {
	provider: string;
	label: string;
	style: "device" | "paste" | "api-key" | "questions";
	accounts: ConnectionAccount[];
}

export interface ConnectionsResponse {
	machine: string;
	providers: ConnectionProvider[];
	login: unknown | null;
}

export const fetchConnections = (machine?: string, signal?: AbortSignal) =>
	hubFetch<ConnectionsResponse>("connections", { signal }, machine);

export const removeCredential = (machine: string | undefined, credentialId: number, confirm: string) =>
	hubPost<{ removed: boolean }>("connections/remove", { credentialId, confirm }, machine);
