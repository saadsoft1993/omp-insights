import { ApiError } from "../api";
import { type FlowChoice, type FlowRole, hubFetch, hubPost, type ModelFlow } from "./hub";

export interface MachineFlow {
	machine: string;
	flow: ModelFlow;
}

/**
 * One machine's roles. An answer without roles is an error, not a config with every role unset:
 * the page must never show "Not set" for a machine it couldn't read.
 */
export async function fetchMachineFlow(machine?: string, signal?: AbortSignal): Promise<ModelFlow> {
	const flow = await hubFetch<Partial<ModelFlow> | null>("model-flow", { signal }, machine);
	if (!flow || !Array.isArray(flow.roles) || !flow.roles.length || !Array.isArray(flow.models))
		throw new Error("the hub answered without any roles");
	return flow as ModelFlow;
}

export function saveMachineFlow(
	machine: string | undefined,
	revision: string,
	roles: Record<string, FlowChoice>,
): Promise<ModelFlow & { saved: string[] }> {
	return hubPost("model-flow", { revision, roles }, machine);
}

export function flowMatrix(
	flows: MachineFlow[],
): { role: string; cells: (FlowRole | undefined)[]; different: boolean }[] {
	const roles = [...new Set(flows.flatMap(({ flow }) => flow.roles.map(row => row.role)))];
	return roles.map(role => {
		const cells = flows.map(({ flow }) => flow.roles.find(row => row.role === role));
		const values = new Set(
			cells.map(row => (row ? JSON.stringify([row.value, row.model, row.thinking]) : "missing")),
		);
		return { role, cells, different: values.size > 1 };
	});
}

export type ApplyResult =
	| { machine: string; status: "saved"; flow: ModelFlow }
	| { machine: string; status: "stale" | "unknown_model" | "error"; message: string };

export async function applyFlowRole(
	flows: MachineFlow[],
	role: string,
	choice: FlowChoice,
	save = (machine: string, revision: string, roles: Record<string, FlowChoice>) =>
		saveMachineFlow(machine, revision, roles),
): Promise<ApplyResult[]> {
	return Promise.all(
		flows.map(async ({ machine, flow }): Promise<ApplyResult> => {
			try {
				const saved = await save(machine, flow.revision, { [role]: choice });
				return { machine, status: "saved", flow: saved };
			} catch (error) {
				const status =
					error instanceof ApiError && (error.status === 409 || error.code === "stale")
						? "stale"
						: error instanceof ApiError && error.code === "unknown_model"
							? "unknown_model"
							: "error";
				return { machine, status, message: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
}
