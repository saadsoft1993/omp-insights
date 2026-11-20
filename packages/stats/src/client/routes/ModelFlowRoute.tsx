import { type HTMLAttributes, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import {
	ALL_MACHINES,
	type FleetMachine,
	machineView,
	shortMachineName,
	useFleet,
	useSelectedMachine,
} from "../app/machine";
import { classifyStatsFailure } from "../app/stats-reasons";
import { flowLevels, type FlowChoice, type ModelFlow } from "../data/hub";
import { fetchMachineFlow, flowMatrix, saveMachineFlow, type MachineFlow } from "../data/model-flow-fleet";
import { PageHeader, Table, type Column } from "../ui";
import { ModelFlowEditor, OTHER_PROVIDER_COLOR, PROVIDER_COLOR } from "./ModelFlowEditor";
import { usePopoverFit } from "./model-flow-popover";
import "./model-flow.css";

export interface ModelFlowRouteProps {
	active: boolean;
}
interface Draft {
	revision: string;
	roles: Record<string, FlowChoice>;
}
interface Editor {
	machine: string;
	role: string;
}
const LOCAL = "";
/** A config read that has not answered by then is reported as failed (it keeps the column from loading forever). */
export const FLOW_FETCH_TIMEOUT_MS = 20_000;
/** A failed config read is asked again on its own after this, doubling per failure up to the cap. */
export const FLOW_RETRY_BASE_MS = 5_000;
export const FLOW_RETRY_MAX_MS = 60_000;
/**
 * What a machine's column can show: `fresh` values read from a reachable machine; `stale` last known values
 * (the machine is unreachable or its last read failed); `loading` no values yet; `failed` no values at all.
 * Only `fresh` machines take part in comparisons, counts and copies.
 */
type Availability = "fresh" | "stale" | "loading" | "failed";
/**
 * Plain wording for a failed request to a machine's hub, chosen by the shared classifier so "different version"
 * only appears for a real proof or identity mismatch. The hub's own plain messages (and anything the classifier
 * doesn't know) are kept as they are; the raw reason always stays in the tooltip.
 */
function plainHubReason(raw: string): string {
	switch (classifyStatsFailure(raw).kind) {
		case "version":
			return "its hub is a different version until it's updated";
		case "unexpected":
			return "it sent an unexpected answer";
		case "clock":
			return "its clock is out of sync or its hub just restarted";
		case "timeout":
			return "it didn't answer in time";
		case "down":
			return "it isn't answering";
		case "busy":
			return "this hub is busy";
		case "setup":
			return "this hub isn't set up to reach it yet";
		case "loading":
		case "unknown":
			return raw;
	}
}
function listNames(names: string[]): string {
	return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
/** The row menu panel; it flips above its trigger when there is no room below. */
function MenuPanel({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	usePopoverFit(ref);
	return (
		<div ref={ref} {...props}>
			{children}
		</div>
	);
}
const ROLE_NAMES: Record<string, string> = {
	default: "Default",
	plan: "Planning",
	smol: "Small tasks",
	exec_fast: "Fast execution",
	exec_strong: "Strong execution",
	plan_verifier: "Plan verification",
	code_review: "Code review",
	advisor: "Advisor",
};
const nameRole = (role: string) => ROLE_NAMES[role] ?? role;
function shortModel(selector: string): string {
	const id = selector.split("/").pop() ?? selector;
	const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
	if (claude)
		return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
	const gpt = /^gpt-([\d.]+)-([a-z]+)$/.exec(id);
	if (gpt) return `GPT-${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}`;
	return id;
}
const generations = new Map<string, number>();
const latest = new Map<string, { generation: number; flow: ModelFlow }>();
export function resetModelFlowRoute(): void {
	generations.clear();
	latest.clear();
}

function acceptFlow(machine: string, flow: ModelFlow): void {
	const generation = (generations.get(machine) ?? 0) + 1;
	generations.set(machine, generation);
	latest.set(machine, { generation, flow });
}

export function ModelFlowRoute({ active }: ModelFlowRouteProps) {
	const fleet = useFleet();
	const selected = useSelectedMachine();
	const ids = fleet?.map(m => m.id).join(",") ?? LOCAL;
	const [flows, setFlows] = useState<MachineFlow[]>(() =>
		(ids ? ids.split(",") : [LOCAL]).flatMap(machine => {
			const cached = latest.get(machine);
			return cached ? [{ machine, flow: cached.flow }] : [];
		}),
	);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [pending, setPending] = useState<Record<string, boolean>>({});
	/** Machines whose failed read is scheduled to be asked again automatically. */
	const [retrying, setRetrying] = useState<Record<string, boolean>>({});
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [editor, setEditor] = useState<Editor | null>(null);
	const [review, setReview] = useState(false);
	const [included, setIncluded] = useState<Record<string, boolean>>({});
	/** Per-machine outcome lines; `raw` keeps a failure's original reason for the tooltip, as the read callouts do. */
	const [results, setResults] = useState<Record<string, { text: string; raw?: string }>>({});
	const [conflicts, setConflicts] = useState<Record<string, ModelFlow>>({});
	const [busy, setBusy] = useState(false);
	const [onlyDiff, setOnlyDiff] = useState(false);
	const [reload, setReload] = useState(0);
	const machines = useMemo(
		() =>
			fleet ?? [
				{
					id: LOCAL,
					name: "This machine",
					self: true,
					ok: true,
					latencyMs: null,
					version: null,
					lastOkAt: null,
					dashboardUrl: null,
				},
			],
		[fleet],
	);
	const machineName = (id: string) => machines.find(m => m.id === id)?.name ?? id;
	const controllers = useRef(new Map<string, AbortController>());
	/**
	 * Automatic re-reads after a failure (a hub busy or briefly away must not leave the page stuck): per machine,
	 * the failures so far, the pending timer, and whether a retry came due while the tab was hidden.
	 */
	const retries = useRef(
		new Map<string, { failures: number; timer: ReturnType<typeof setTimeout> | null; due: boolean }>(),
	);
	const stopRetry = (machine: string, forget: boolean) => {
		const entry = retries.current.get(machine);
		if (entry?.timer) clearTimeout(entry.timer);
		if (entry) {
			entry.timer = null;
			entry.due = false;
		}
		if (forget) retries.current.delete(machine);
		setRetrying(previous => {
			if (!previous[machine]) return previous;
			const next = { ...previous };
			delete next[machine];
			return next;
		});
	};
	const scheduleRetry = (machine: string) => {
		const entry = retries.current.get(machine) ?? { failures: 0, timer: null, due: false };
		entry.failures += 1;
		if (entry.timer) clearTimeout(entry.timer);
		entry.due = false;
		entry.timer = setTimeout(
			() => {
				entry.timer = null;
				// Only while the tab is visible; a hidden tab asks again as soon as it is shown.
				if (document.hidden) entry.due = true;
				else load(machine);
			},
			Math.min(FLOW_RETRY_BASE_MS * 2 ** (entry.failures - 1), FLOW_RETRY_MAX_MS),
		);
		retries.current.set(machine, entry);
		setRetrying(previous => ({ ...previous, [machine]: true }));
	};
	const load = (machine: string) => {
		stopRetry(machine, false);
		controllers.current.get(machine)?.abort();
		const controller = new AbortController();
		controllers.current.set(machine, controller);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, FLOW_FETCH_TIMEOUT_MS);
		setPending(previous => ({ ...previous, [machine]: true }));
		const generation = generations.get(machine) ?? 0;
		void (async () => {
			try {
				const loaded = await fetchMachineFlow(machine || undefined, controller.signal);
				if (controller.signal.aborted) throw new Error("aborted");
				const newer = latest.get(machine);
				const flow = newer && newer.generation > generation ? newer.flow : loaded;
				if (!newer || newer.generation <= generation) latest.set(machine, { generation, flow });
				setFlows(previous => [...previous.filter(item => item.machine !== machine), { machine, flow }]);
				setErrors(previous => {
					const next = { ...previous };
					delete next[machine];
					return next;
				});
				stopRetry(machine, true);
			} catch (error) {
				if (!controller.signal.aborted || timedOut) {
					scheduleRetry(machine);
					setErrors(previous => ({
						...previous,
						[machine]: timedOut
							? `timed out after ${FLOW_FETCH_TIMEOUT_MS / 1000} s`
							: error instanceof Error
								? error.message
								: String(error),
					}));
				}
			} finally {
				clearTimeout(timer);
				if (controllers.current.get(machine) === controller) {
					controllers.current.delete(machine);
					setPending(previous => {
						const next = { ...previous };
						delete next[machine];
						return next;
					});
				}
			}
		})();
	};
	useEffect(() => {
		if (!active) return;
		const running = controllers.current;
		const scheduled = retries.current;
		for (const machine of ids ? ids.split(",") : [LOCAL]) load(machine);
		const onVisible = () => {
			if (document.hidden) return;
			for (const [machine, entry] of scheduled)
				if (entry.due) {
					entry.due = false;
					load(machine);
				}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			for (const controller of running.values()) controller.abort();
			running.clear();
			// Leaving the page (or Reload values) stops automatic re-reads; the next load starts the backoff afresh.
			for (const entry of scheduled.values()) if (entry.timer) clearTimeout(entry.timer);
			scheduled.clear();
			setRetrying({});
		};
	}, [active, ids, reload]);
	const getFlow = (id: string) => flows.find(item => item.machine === id)?.flow;
	const rows = flowMatrix(
		flows.map(({ machine, flow }) => ({
			machine,
			flow: {
				...flow,
				roles: flow.roles.map(row => {
					const choice = drafts[machine]?.roles[row.role];
					return choice
						? { ...row, ...choice, value: choice.thinking ? `${choice.model}:${choice.thinking}` : choice.model }
						: row;
				}),
			},
		})),
	);
	const setChoice = (machine: string, role: string, choice: FlowChoice) => {
		const flow = getFlow(machine);
		if (!flow) return;
		const old = flow.roles.find(row => row.role === role);
		setDrafts(current => {
			const roles = { ...current[machine]?.roles };
			if (old?.model === choice.model && old.thinking === choice.thinking) delete roles[role];
			else roles[role] = choice;
			const next = { ...current };
			if (Object.keys(roles).length)
				next[machine] = { revision: current[machine]?.revision ?? flow.revision, roles };
			else delete next[machine];
			return next;
		});
	};
	const copy = (source: string, roles: string[]) => {
		const sourceFlow = getFlow(source);
		// A save in flight settles drafts by what it sent; staging more now would race its response.
		// Last known values from a machine that can't be read now are never copied.
		if (!sourceFlow || busy || availability.get(source) !== "fresh") return;
		const issues: Record<string, string[]> = {};
		for (const machine of machines) {
			if (machine.id === source) continue;
			const target = getFlow(machine.id);
			if (!target || availability.get(machine.id) !== "fresh") {
				issues[machine.id] = [`No current values (${missingWhy(machine)}); no changes staged.`];
				continue;
			}
			for (const role of roles) {
				const original = sourceFlow.roles.find(row => row.role === role);
				const choice =
					drafts[source]?.roles[role] ??
					(original?.model ? { model: original.model, thinking: original.thinking } : null);
				const targetRole = target.roles.find(row => row.role === role);
				const model = target.models.find(item => item.selector === choice?.model);
				const levels = flowLevels(model, new Set(target.models.map(item => item.selector)));
				if (!choice || !targetRole || !model || (choice.thinking !== null && !levels.includes(choice.thinking))) {
					(issues[machine.id] ??= []).push(
						`${nameRole(role)}: model or thinking level not available on ${machine.name}`,
					);
					continue;
				}
				setChoice(machine.id, role, choice);
			}
		}
		setResults(
			Object.fromEntries(Object.entries(issues).map(([id, messages]) => [id, { text: messages.join("; ") }])),
		);
	};
	const commit = async () => {
		const targets = Object.entries(drafts).filter(([id]) => included[id] !== false);
		setBusy(true);
		await Promise.all(
			targets.map(async ([machine, draft]) => {
				try {
					const saved = await saveMachineFlow(machine || undefined, draft.revision, draft.roles);
					acceptFlow(machine, saved);
					setFlows(current => current.map(item => (item.machine === machine ? { ...item, flow: saved } : item)));
					// Only the roles this POST carried are settled; edits made while it was in flight stay drafted.
					setDrafts(current => {
						const next = { ...current };
						const roles = { ...next[machine]?.roles };
						for (const [role, sent] of Object.entries(draft.roles)) {
							const now = roles[role];
							if (now && now.model === sent.model && now.thinking === sent.thinking) delete roles[role];
						}
						if (Object.keys(roles).length) next[machine] = { revision: saved.revision, roles };
						else delete next[machine];
						return next;
					});
					setResults(current => ({
						...current,
						[machine]: {
							text: `Saved ${saved.saved.length} role(s).${current[machine] ? ` ${current[machine].text}` : ""}`,
						},
					}));
				} catch (error) {
					if (error instanceof ApiError && error.code === "stale") {
						try {
							const fresh = await fetchMachineFlow(machine || undefined);
							acceptFlow(machine, fresh);
							setConflicts(current => ({ ...current, [machine]: fresh }));
							setResults(current => ({
								...current,
								[machine]: {
									text: "Config changed since editing. Reload and choose whether to keep your changes.",
								},
							}));
						} catch (reloadError) {
							const raw = reloadError instanceof Error ? reloadError.message : String(reloadError);
							setResults(current => ({
								...current,
								[machine]: { text: `Config changed and reload failed: ${plainHubReason(raw)}`, raw },
							}));
						}
					} else {
						const raw = error instanceof Error ? error.message : String(error);
						setResults(current => ({
							...current,
							[machine]: { text: `Not saved: ${plainHubReason(raw)}`, raw },
						}));
					}
				}
			}),
		);
		setReview(false);
		setBusy(false);
	};
	const resolveConflict = (machine: string, keep: boolean) => {
		const fresh = conflicts[machine];
		if (!fresh) return;
		acceptFlow(machine, fresh);
		setFlows(current => current.map(item => (item.machine === machine ? { ...item, flow: fresh } : item)));
		setDrafts(current => {
			const next = { ...current };
			if (keep && next[machine]) next[machine] = { ...next[machine], revision: fresh.revision };
			else delete next[machine];
			return next;
		});
		setConflicts(current => {
			const next = { ...current };
			delete next[machine];
			return next;
		});
		setResults(current => ({
			...current,
			[machine]: { text: keep ? "Reloaded; changes kept for review." : "Reloaded; changes discarded." },
		}));
	};
	const opener = useRef<HTMLElement | null>(null);
	const refocus = useRef<HTMLElement | null>(null);
	const [menu, setMenu] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const reviewPrimary = useRef<HTMLButtonElement | null>(null);
	const closeEditor = () => {
		refocus.current = opener.current;
		setEditor(null);
	};
	useEffect(() => {
		if (editor || !refocus.current) return;
		refocus.current.focus();
		refocus.current = null;
	}, [editor]);
	useEffect(() => {
		if (!editor) return;
		const outside = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!document.querySelector(".mf-editor")?.contains(target) && !opener.current?.contains(target))
				closeEditor();
		};
		document.addEventListener("mousedown", outside);
		return () => document.removeEventListener("mousedown", outside);
	}, [editor]);
	useEffect(() => {
		if (!menu) return;
		const outside = (event: MouseEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
		};
		document.addEventListener("mousedown", outside);
		return () => document.removeEventListener("mousedown", outside);
	}, [menu]);
	const reviewOpener = useRef<HTMLElement | null>(null);
	const reviewOpened = useRef(false);
	useEffect(() => {
		if (review) {
			reviewOpened.current = true;
			reviewPrimary.current?.focus();
			return;
		}
		if (!reviewOpened.current) return;
		reviewOpened.current = false;
		// Every close path (Cancel, Escape, outside click, a finished save) lands back on "Review & save" when it still exists.
		const target = reviewOpener.current?.isConnected
			? reviewOpener.current
			: document.querySelector<HTMLElement>(".mf-changebar [data-action='review']");
		target?.focus();
	}, [review]);
	const menuTrigger = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (!menu) return;
		// The first enabled item, or the menu itself when every machine already agrees (all items disabled).
		(
			menuRef.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)") ??
			menuRef.current?.querySelector<HTMLElement>("[role=menu]")
		)?.focus();
	}, [menu]);
	const closeMenu = () => {
		setMenu(null);
		menuTrigger.current?.focus();
	};
	const keyOf = (model: string | null | undefined, thinking: string | null | undefined) =>
		`${model ?? ""}:${thinking ?? ""}`;
	const currentOf = (machine: string, role: string) => {
		const row = getFlow(machine)?.roles.find(item => item.role === role);
		const choice = drafts[machine]?.roles[role];
		return {
			row,
			choice,
			model: choice?.model ?? row?.model ?? null,
			thinking: choice ? choice.thinking : (row?.thinking ?? null),
		};
	};
	const availabilityOf = (machine: FleetMachine): Availability => {
		// A machine in the hub's grace period (ok but stale) has not answered recently: its values are last known.
		if (getFlow(machine.id)) return machine.ok && !machine.stale && !errors[machine.id] ? "fresh" : "stale";
		if (errors[machine.id] || (!machine.ok && !pending[machine.id])) return "failed";
		return "loading";
	};
	const availability = new Map(machines.map(machine => [machine.id, availabilityOf(machine)]));
	const okMachines = machines.filter(machine => availability.get(machine.id) === "fresh");
	const missing = machines.filter(machine => availability.get(machine.id) !== "fresh");
	/** Why a machine has no current values, in a few words (summary, column tag, menu). */
	const missingWhy = (machine: FleetMachine) => {
		const state = availability.get(machine.id);
		if (state === "loading") return "loading";
		if (state === "stale")
			return !machine.ok
				? "unreachable, last known values"
				: machine.stale
					? "not answering, last known values"
					: "last read failed";
		return machine.ok ? "no data" : "unreachable, no data";
	};
	const diffsOf = (role: string) => {
		const counts = new Map<string, number>();
		for (const machine of okMachines) {
			const { model, thinking, row } = currentOf(machine.id, role);
			const key = model ? keyOf(model, thinking) : `raw:${row?.value ?? ""}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		return okMachines
			.filter(machine => {
				const { model, thinking, row } = currentOf(machine.id, role);
				return (model ? keyOf(model, thinking) : `raw:${row?.value ?? ""}`) !== common;
			})
			.map(machine => machine.id);
	};
	const diffs = new Map(rows.map(row => [row.role, diffsOf(row.role)]));
	const differing = rows.filter(row => diffs.get(row.role)?.length);
	const totalDiffs = differing.reduce((sum, row) => sum + (diffs.get(row.role)?.length ?? 0), 0);
	const providerColor = (model: string) => PROVIDER_COLOR[model.split("/")[0]] ?? OTHER_PROVIDER_COLOR;
	const chip = (model: string | null, thinking: string | null, raw: string | null | undefined, state?: string) => (
		<span className="mf-chip" data-state={state}>
			<span className="mf-sw" style={{ background: model ? providerColor(model) : OTHER_PROVIDER_COLOR }} />
			<span className="mf-chip-name">{model ? shortModel(model) : (raw ?? "Not set")}</span>
			{thinking && (
				<span className="mf-think" data-level={thinking}>
					{thinking}
				</span>
			)}
		</span>
	);
	const machineSwatch = (name: string) => (
		<span className="mf-msw" style={{ background: machineView(name)?.accent }} aria-hidden="true" />
	);
	const renderCell = (machine: string, role: string) => {
		const { row, choice, model, thinking } = currentOf(machine, role);
		const info = machines.find(m => m.id === machine);
		const state = info ? availability.get(machine) : "failed";
		const fresh = state === "fresh";
		const diff = !choice && !!diffs.get(role)?.includes(machine);
		const editing = editor?.machine === machine && editor.role === role;
		const flow = getFlow(machine);
		const content = chip(
			model,
			thinking,
			row?.value,
			choice ? "pending" : diff ? "diff" : fresh ? undefined : "stale",
		);
		const name = machineName(machine);
		return (
			<span
				className="mf-cell"
				data-edited={!!choice}
				data-avail={state}
				data-selected={!allMode && machine === selected ? "true" : undefined}
			>
				<span className="mf-cell-machine" title={name}>
					{machineSwatch(name)}
					<span>{shortMachineName(name)}</span>
				</span>
				<span className="mf-cell-value">
					{!flow ? (
						// No values read from this machine: never shown as "Not set", which would claim the role is unset.
						<span
							className="mf-nodata"
							data-state={state}
							title={
								state === "loading"
									? `Reading config.yml from ${name}…`
									: `Couldn't read config.yml from ${name}${errors[machine] ? `: ${plainHubReason(errors[machine])} (${errors[machine]})` : ""}`
							}
						>
							{state === "loading" ? "Loading…" : "No data"}
						</span>
					) : (
						<button
							type="button"
							className="mf-cellbtn"
							aria-label={`Change ${nameRole(role)} on ${name}`}
							aria-expanded={editing}
							aria-haspopup="dialog"
							title={
								fresh
									? (model ?? row?.value ?? "Not set")
									: `${model ?? row?.value ?? "Not set"} (last known; ${name} can't be changed now)`
							}
							disabled={!fresh || busy}
							onClick={event => {
								if (editing) {
									closeEditor();
									return;
								}
								opener.current = event.currentTarget;
								setMenu(null);
								setEditor({ machine, role });
							}}
						>
							{content}
							<svg
								className="mf-pencil"
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.2"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<path d="M4 20h4L19 9l-4-4L4 16z" />
							</svg>
						</button>
					)}
					{diff && (
						<span className="mf-diffmark" role="img" aria-label="differs from the other machines">
							≠
						</span>
					)}
					{choice && (
						<span
							className="mf-was"
							title={`saved value: ${row?.model ?? row?.value ?? "Not set"}${row?.thinking ? ` · ${row.thinking}` : ""}`}
						>
							{row?.model ? shortModel(row.model) : (row?.value ?? "Not set")}
							{row?.thinking ? ` · ${row.thinking}` : ""}
						</span>
					)}
					{state === "stale" && <span className="mf-lastknown">last known</span>}
					{editing && flow && (
						<ModelFlowEditor
							label={`Edit ${nameRole(role)} on ${machineName(machine)}`}
							heading={`${nameRole(role)} on ${machineName(machine)}`}
							models={flow.models}
							model={model ?? ""}
							thinking={thinking}
							onCancel={closeEditor}
							onSave={next => {
								setChoice(machine, role, next);
								closeEditor();
							}}
						/>
					)}
				</span>
			</span>
		);
	};
	const selectedIndex = machines.findIndex(machine => machine.id === selected);
	const columns: Column<(typeof rows)[number]>[] = [
		{
			key: "role",
			header: "Role",
			width: 210,
			sort: row => rows.indexOf(row),
			render: row => {
				const used = row.cells.find(Boolean)?.usedBy ?? [];
				const n = diffs.get(row.role)?.length ?? 0;
				return (
					<span className="mf-role">
						<span className="mf-role-text">
							<span className="mf-role-name">{nameRole(row.role)}</span>
							<span className="mf-role-sub" title={used.length ? `Used by: ${used.join(", ")}` : undefined}>
								<span className="mono">{row.role}</span>
								{used.length > 0 && <span className="mf-role-used"> · {used.join(", ")}</span>}
							</span>
							{row.cells.some(cell => cell && !cell.editable) && (
								<span className="mf-role-note">Custom value in config.yml</span>
							)}
							{["exec_fast", "exec_strong", "plan_verifier", "code_review"].includes(row.role) &&
								row.cells.some(cell => cell && !cell.usedBy.length) && (
									<span className="mf-role-note" data-tone="warn">
										No agent is mapped to this role in task.agentModelOverrides
									</span>
								)}
						</span>
						{n ? (
							<span className="mf-pill" data-tone="warn">
								{n} differ
							</span>
						) : okMachines.length < 2 && fleet ? null : missing.length && fleet ? (
							<span
								className="mf-pill"
								data-tone="ok"
								title={`Compared on the ${okMachines.length} machines with current values; ${listNames(missing.map(m => m.name))} not compared`}
							>
								Match {okMachines.length}/{machines.length}
							</span>
						) : (
							<span className="mf-pill" data-tone="ok">
								Match
							</span>
						)}
					</span>
				);
			},
		},
		...machines.map(machine => ({
			key: machine.id || "local",
			header: (
				<span className="mf-colh" data-avail={availability.get(machine.id)}>
					{machine.name}
					{drafts[machine.id] ? " · edited" : ""}
					{availability.get(machine.id) !== "fresh" && (
						<span className="mf-coltag">{missingWhy(machine).split(",")[0]}</span>
					)}
				</span>
			),
			kind: "model" as const,
			render: (row: (typeof rows)[number]) => renderCell(machine.id, row.role),
		})),
		{
			key: "actions",
			header: "",
			kind: "actions",
			width: 52,
			render: row => {
				const open = menu === row.role;
				return (
					<div className="mf-rowmenu" ref={open ? menuRef : undefined}>
						<button
							type="button"
							className="btn"
							data-variant="ghost"
							data-size="sm"
							data-icon="true"
							aria-label={`Actions for ${nameRole(row.role)}`}
							aria-haspopup="menu"
							aria-expanded={open}
							disabled={busy}
							onClick={event => {
								menuTrigger.current = event.currentTarget;
								setMenu(open ? null : row.role);
							}}
							onKeyDown={event => {
								if (event.key === "ArrowDown" || event.key === "ArrowUp") {
									event.preventDefault();
									menuTrigger.current = event.currentTarget;
									setMenu(row.role);
								} else if (event.key === "Escape" && open) {
									event.preventDefault();
									closeMenu();
								}
							}}
						>
							⋯
						</button>
						{open && (
							<MenuPanel
								className="mf-menu"
								role="menu"
								tabIndex={-1}
								onKeyDown={event => {
									const items = [
										...event.currentTarget.querySelectorAll<HTMLButtonElement>(
											"[role=menuitem]:not(:disabled)",
										),
									];
									const at = items.indexOf(document.activeElement as HTMLButtonElement);
									if (event.key === "Escape") {
										event.preventDefault();
										closeMenu();
									} else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
										event.preventDefault();
										items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
									}
								}}
							>
								{machines.map(machine => {
									const { model, thinking, row: value } = currentOf(machine.id, row.role);
									const fresh = availability.get(machine.id) === "fresh";
									const same = okMachines.every(other => {
										const o = currentOf(other.id, row.role);
										return (
											keyOf(o.model ?? o.row?.value, o.thinking) === keyOf(model ?? value?.value, thinking)
										);
									});
									return (
										<button
											type="button"
											className="mf-menu-item"
											role="menuitem"
											key={machine.id}
											disabled={busy || same || !fresh}
											title={
												!fresh
													? `${machine.name}: ${missingWhy(machine)}`
													: same
														? "Every machine with current values already uses this"
														: undefined
											}
											onClick={() => {
												closeMenu();
												copy(machine.id, [row.role]);
											}}
										>
											Apply {machine.name}'s value to all
											<small>
												{!fresh && !getFlow(machine.id) ? (
													missingWhy(machine)
												) : (
													<>
														{model ? shortModel(model) : (value?.value ?? "Not set")}
														{thinking ? ` · ${thinking}` : ""}
														{same && fresh ? " · already on all" : ""}
														{fresh ? "" : " · last known"}
													</>
												)}
											</small>
										</button>
									);
								})}
							</MenuPanel>
						)}
					</div>
				);
			},
		},
	];
	const count = Object.values(drafts).reduce((sum, draft) => sum + Object.keys(draft.roles).length, 0);
	const draftMachines = Object.keys(drafts).length;
	const allMode = selected === ALL_MACHINES || selected === undefined;
	const included_ = Object.keys(drafts).filter(id => included[id] !== false);
	const includedCount = included_.reduce((sum, id) => sum + Object.keys(drafts[id].roles).length, 0);
	const resultEntries = Object.entries(results);
	// The filter only applies while there is something to filter; resolving the last difference shows every role again.
	const filtering = onlyDiff && totalDiffs > 0;
	useEffect(() => {
		if (!totalDiffs && onlyDiff) setOnlyDiff(false);
	}, [totalDiffs, onlyDiff]);
	const shownRows = filtering ? differing : rows;
	const tableLoading = !rows.length && machines.some(machine => availability.get(machine.id) === "loading");
	const source = allMode ? undefined : machines.find(machine => machine.id === selected);
	const sourceState = source ? availability.get(source.id) : undefined;
	/** Why "Make all machines match" can't run now; null when it can. */
	const matchBlocked = allMode
		? "Pick a machine in the header first"
		: !source
			? "That machine isn't part of this dashboard"
			: sourceState === "loading"
				? `${source.name}'s values are still loading`
				: sourceState !== "fresh"
					? !source.ok
						? `${source.name} is unreachable`
						: source.stale && !errors[source.id]
							? `${source.name} hasn't answered recently; its values are last known`
							: `Couldn't read ${source.name}'s config.yml`
					: okMachines.length < 2
						? "No other machine has current values to change"
						: null;
	const notCompared =
		fleet && missing.length ? (
			<span className="mf-dim mf-missing">
				Not compared: {missing.map(machine => `${machine.name}: ${missingWhy(machine)}`).join(" · ")}
			</span>
		) : null;
	const freshNames = okMachines.map(machine => machine.name);
	return (
		<div className="page mf-page" data-hl={selectedIndex >= 0 && !allMode ? selectedIndex + 2 : undefined}>
			<PageHeader
				title="Model flow"
				description="Which model and thinking level each role uses, on every machine. Click a cell to change it."
				actions={
					<>
						<button
							type="button"
							className="btn"
							data-variant="ghost"
							disabled={busy}
							onClick={() => setReload(n => n + 1)}
						>
							Reload values
						</button>
						<span className="mf-match">
							<button
								type="button"
								className="btn"
								disabled={busy || matchBlocked !== null}
								aria-describedby={matchBlocked ? "flow-match-hint" : undefined}
								onClick={() =>
									selected &&
									copy(
										selected,
										rows.map(row => row.role),
									)
								}
							>
								Make all machines match{!allMode ? ` ${machineName(selected)}` : "…"}
							</button>
							{matchBlocked && (
								<span id="flow-match-hint" className="hint">
									{matchBlocked}
								</span>
							)}
						</span>
					</>
				}
			/>
			{!allMode && selectedIndex >= 0 && fleet && (
				<p className="mf-scope-note">
					<span>
						<b>{machineName(selected)}</b> is highlighted. Model flow always compares every machine.
					</span>
				</p>
			)}
			{machines
				.filter(machine => (!machine.ok || machine.stale) && !errors[machine.id])
				.map(machine => (
					<p className="mf-stale-note" key={machine.id}>
						<span className="dot" data-tone="warn" aria-hidden="true" />
						<span>
							<b>{machine.name}</b> {machine.ok ? "hasn't answered recently" : "is unreachable"}.{" "}
							{availability.get(machine.id) === "stale"
								? "Its column shows the last known values and can't be changed."
								: availability.get(machine.id) === "loading"
									? "Trying to read its config.yml…"
									: "Its column has no values and is left out of the comparison."}
						</span>
					</p>
				))}
			{Object.entries(errors).map(([id, message]) => (
				<div className="mf-callout" data-tone="bad" role="alert" key={id}>
					Couldn't read config.yml from <b>{machineName(id)}</b>:{" "}
					<span title={message}>{plainHubReason(message)}</span>.{" "}
					{getFlow(id)
						? "Its column shows the last values read and can't be changed."
						: "Its column is left out of the comparison."}
					{/* Say "retrying" only while a re-read really is scheduled. */}
					{retrying[id] && !pending[id] ? " Retrying automatically." : ""}
					<div className="mf-callout-row">
						<button
							type="button"
							className="btn"
							data-size="sm"
							disabled={!!pending[id]}
							onClick={() => load(id)}
						>
							{pending[id] ? "Trying again…" : "Try again"}
						</button>
					</div>
				</div>
			))}
			{Object.entries(conflicts).map(([id, flow]) => (
				<div key={id} className="mf-callout" data-tone="bad" role="alert">
					<b>{machineName(id)}'s config changed since this page loaded</b> (revision{" "}
					<span className="mono">
						{drafts[id]?.revision} → {flow.revision}
					</span>
					). Your changes there were not saved.
					<div className="mf-callout-row">
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="primary"
							onClick={() => resolveConflict(id, true)}
						>
							Reload and keep my changes
						</button>
						<button type="button" className="btn" data-size="sm" onClick={() => resolveConflict(id, false)}>
							Reload and discard my changes
						</button>
					</div>
				</div>
			))}
			{Object.entries(drafts).map(([id, draft]) =>
				getFlow(id)?.revision !== draft.revision && !conflicts[id] ? (
					<p className="mf-callout" key={id}>
						<b>{machineName(id)}</b> config.yml changed outside this page; saving will check the original
						revision.
					</p>
				) : null,
			)}
			{resultEntries.length > 0 && (
				<div
					className="mf-callout"
					data-tone={resultEntries.every(([, result]) => result.text.startsWith("Saved")) ? "ok" : undefined}
					role="status"
				>
					{resultEntries.map(([id, result]) => (
						<div key={id}>
							{/* Always name the machine, so "its hub…" has something to refer to (one machine: "This machine"). */}
							{`${machineName(id)}: `}
							{result.raw ? <span title={result.raw}>{result.text}</span> : result.text}
						</div>
					))}
				</div>
			)}
			<Table
				variant="std"
				dense
				title="Roles"
				subtitle={
					tableLoading ? (
						<>
							Reading each machine's <span className="mono">~/.omp/agent/config.yml</span>…
						</>
					) : (
						<>
							{rows.length} roles · {machines.length} {machines.length === 1 ? "machine" : "machines"} · values
							from each machine's <span className="mono">~/.omp/agent/config.yml</span>
						</>
					)
				}
				summary={
					tableLoading || !rows.length ? null : totalDiffs ? (
						<div className="mf-sum" data-tone="warn" role="status">
							<span className="dot" data-tone="warn" aria-hidden="true" />
							<b>
								{totalDiffs} difference{totalDiffs === 1 ? "" : "s"}
							</b>
							<span className="mf-dim">
								across {differing.length} role{differing.length === 1 ? "" : "s"}
								{notCompared ? ` among the ${okMachines.length} machines with current values` : ""}. Cells
								marked ≠ differ from the most common value on their row.
							</span>
							<span className="mf-grow" />
							<label className="mf-dim mf-only">
								<input
									type="checkbox"
									checked={onlyDiff}
									onChange={event => setOnlyDiff(event.target.checked)}
								/>
								Only rows that differ
							</label>
							{notCompared}
						</div>
					) : !fleet ? (
						<div className="mf-sum" role="status">
							<span className="dot" data-tone="ok" aria-hidden="true" />
							<b>{rows.length} roles</b>
							<span className="mf-dim">on this machine. Click any cell to change it.</span>
						</div>
					) : !okMachines.length ? (
						<div className="mf-sum" data-tone="warn" role="status">
							<span className="dot" data-tone="warn" aria-hidden="true" />
							<b>No machine has current values</b>
							<span className="mf-dim">so nothing is compared. Reload values or try each machine again.</span>
							{notCompared}
						</div>
					) : okMachines.length === 1 ? (
						<div className="mf-sum" data-tone="warn" role="status">
							<span className="dot" data-tone="warn" aria-hidden="true" />
							<b>Only {freshNames[0]} has current values</b>
							<span className="mf-dim">so there is nothing to compare it with.</span>
							{notCompared}
						</div>
					) : notCompared ? (
						<div className="mf-sum" data-tone="warn" role="status">
							<span className="dot" data-tone="ok" aria-hidden="true" />
							<b>{listNames(freshNames)} match</b>
							<span className="mf-dim">on all {rows.length} roles.</span>
							{notCompared}
						</div>
					) : (
						<div className="mf-sum" role="status">
							<span className="dot" data-tone="ok" aria-hidden="true" />
							<b>All {okMachines.length} machines match</b>
							<span className="mf-dim">on all {rows.length} roles. Click any cell to change it.</span>
						</div>
					)
				}
				columns={columns}
				initialSort={{ key: "role", dir: "asc" }}
				rows={shownRows}
				rowKey={row => row.role}
				loading={tableLoading}
				empty="No roles to compare. None of the machines returned a config.yml; each one's reason is above, with Try again."
			/>
			{count > 0 && (
				<div className="mf-changebar" role="region" aria-label="Unsaved changes">
					<span className="dot" data-tone="accent" aria-hidden="true" />
					<b>
						{count} change{count === 1 ? "" : "s"}
					</b>
					<span className="mf-dim">
						on {draftMachines} machine{draftMachines === 1 ? "" : "s"}, not saved yet
					</span>
					<span className="mf-grow" />
					<button
						type="button"
						className="btn"
						data-size="sm"
						data-variant="ghost"
						disabled={busy}
						onClick={() => {
							setDrafts({});
							setConflicts({});
						}}
					>
						Discard
					</button>
					<button
						type="button"
						className="btn"
						data-size="sm"
						data-variant="primary"
						disabled={busy || Object.keys(conflicts).length > 0}
						data-action="review"
						onClick={event => {
							reviewOpener.current = event.currentTarget;
							setReview(true);
						}}
					>
						Review &amp; save
					</button>
				</div>
			)}
			{review && (
				<div
					className="mf-overlay"
					role="presentation"
					onClick={event => {
						if (event.target === event.currentTarget && !busy) {
							setReview(false);
						}
					}}
				>
					<div
						role="dialog"
						aria-modal="true"
						aria-labelledby="mf-review-title"
						className="mf-modal"
						onKeyDown={event => {
							if (event.key === "Escape" && !busy) {
								setReview(false);
							} else if (event.key === "Tab") {
								// Keep focus inside the dialog while it is open.
								const focusable = [
									...event.currentTarget.querySelectorAll<HTMLElement>(
										"button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])",
									),
								];
								if (!focusable.length) return;
								const first = focusable[0];
								const last = focusable[focusable.length - 1];
								const inside = event.currentTarget.contains(document.activeElement);
								if (event.shiftKey && (document.activeElement === first || !inside)) {
									event.preventDefault();
									last.focus();
								} else if (!event.shiftKey && (document.activeElement === last || !inside)) {
									event.preventDefault();
									first.focus();
								}
							}
						}}
					>
						<div className="mf-modal-h">
							<div>
								<h2 id="mf-review-title">Review changes</h2>
								<p>
									Each machine saves on its own. New sessions pick the values up; running sessions keep theirs.
								</p>
							</div>
						</div>
						<div className="mf-modal-b">
							{Object.entries(drafts).map(([id, draft]) => (
								<section key={id} className="mf-mach-sec">
									<header>
										{machineSwatch(machineName(id))}
										<b>{machineName(id)}</b>
										<span className="mono mf-dim">config {draft.revision}</span>
										<label className="mf-include">
											<input
												type="checkbox"
												checked={included[id] !== false}
												onChange={event =>
													setIncluded(current => ({ ...current, [id]: event.target.checked }))
												}
											/>
											Save to this machine
										</label>
									</header>
									{Object.keys(draft.roles).length > 16 && (
										<p className="mf-callout" data-tone="bad">
											The hub accepts at most 16 roles per save. Discard enough changes before saving this
											machine.
										</p>
									)}
									<ul>
										{Object.entries(draft.roles).map(([role, choice]) => {
											const old = getFlow(id)?.roles.find(row => row.role === role);
											return (
												<li key={role}>
													<span className="mf-review-role">{nameRole(role)}</span>
													<span
														title={`${old?.model ?? old?.value ?? "Not set"}${old?.thinking ? ` · ${old.thinking}` : ""}`}
													>
														{chip(old?.model ?? null, old?.thinking ?? null, old?.value)}
													</span>
													<span className="mf-dim" aria-label="changes to">
														→
													</span>
													<span title={`${choice.model}${choice.thinking ? ` · ${choice.thinking}` : ""}`}>
														{chip(choice.model, choice.thinking, null, "pending")}
													</span>
												</li>
											);
										})}
									</ul>
								</section>
							))}
						</div>
						<div className="mf-modal-f">
							<button
								type="button"
								className="btn"
								data-variant="ghost"
								disabled={busy}
								onClick={() => {
									setReview(false);
								}}
							>
								Cancel
							</button>
							<button
								ref={reviewPrimary}
								type="button"
								className="btn"
								data-variant="primary"
								data-action="commit"
								disabled={
									busy || !included_.length || included_.some(id => Object.keys(drafts[id].roles).length > 16)
								}
								onClick={() => void commit()}
							>
								{busy
									? "Saving…"
									: `Save ${includedCount} change${includedCount === 1 ? "" : "s"} to ${included_.length} machine${included_.length === 1 ? "" : "s"}`}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
