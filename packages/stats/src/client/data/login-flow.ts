import { machinePrefix } from "../app/machine";

export interface LoginProvider {
	id: string;
	name: string;
	displayName?: string;
	subtitle?: string;
	style: "device" | "paste" | "api-key" | "questions";
	popular: boolean;
	hint: string;
	notes?: string;
}

export interface LoginState {
	id: string;
	provider: string;
	state:
		| "starting"
		| "needs-device-confirm"
		| "needs-code"
		| "needs-input"
		| "checking"
		| "done"
		| "failed"
		| "expired"
		| "cancelled";
	style?: LoginProvider["style"];
	deadlineAt?: number;
	remainingMs?: number;
	verificationUrl?: string;
	deviceCode?: string;
	authUrl?: string;
	input?: { text: string; prompt: string; placeholder: string; secret: boolean };
	riskConsent?: boolean;
	identity?: string;
	credentialId?: number;
	needsPriority?: boolean;
	message?: string;
	warning?: string;
}

export interface PriorityResult {
	entries: unknown[];
	applied?: Record<string, string>;
}

export class LoginError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly login?: LoginState,
	) {
		super(message);
	}
}

async function request<T>(path: string, machine?: string, body?: object): Promise<T> {
	const response = await fetch(
		`${machinePrefix(machine)}/api/hub/connections/${path}`,
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Omp-Hub": "1" },
					body: JSON.stringify(body),
				},
	);
	const result = (await response.json().catch(() => ({}))) as { error?: string; login?: LoginState };
	if (!response.ok)
		throw new LoginError(result.error || `HTTP error ${response.status}`, response.status, result.login);
	return result as T;
}

export async function fetchProviders(machine?: string): Promise<LoginProvider[]> {
	return (await request<{ providers: LoginProvider[] }>("providers", machine)).providers;
}
export const startLogin = (machine: string | undefined, provider: string, expected?: string) =>
	request<LoginState>("start", machine, { provider, ...(expected ? { expected } : {}) });
export const answerLogin = (machine: string | undefined, loginId: string, value: string) =>
	request<LoginState>("answer", machine, { loginId, value });
export const cancelLogin = (machine: string | undefined, loginId: string) =>
	request<LoginState>("cancel", machine, { loginId });
export const pollLogin = (machine: string | undefined, loginId: string) =>
	request<LoginState>(`login?id=${encodeURIComponent(loginId)}`, machine);
export const setPriority = ({
	machine,
	credentialId,
	choice,
	fleet,
}: {
	machine?: string;
	credentialId: number;
	choice: "first" | "backup";
	fleet: boolean;
}) =>
	request<PriorityResult>(
		fleet ? "priority-fleet" : "priority",
		fleet ? undefined : machine,
		fleet ? { machine, credentialId, choice } : { credentialId, choice },
	);
