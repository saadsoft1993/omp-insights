import { Copy } from "lucide-react";
import { useState } from "react";
import { getHubAlerts, type HubAlerts, sendHubTestAlert } from "../data/hub";
import { type Column, EmptyState, PageHeader, Table } from "../ui";
import { type Notice, NoticeLine } from "./hub-common";
import {
	machineOffline,
	MachineProblems,
	plainAlertProblem,
	plainHubReason,
	type OpsMachine,
	OpsMachineCell,
	UpdateHubHint,
	useCapabilities,
	useOpsMachines,
	usePerMachine,
	When,
} from "./ops-common";

export interface AlertsRouteProps {
	active: boolean;
}

interface ChannelRow {
	machine: OpsMachine;
	alerts: HubAlerts | null;
	error: string | null;
	stale: boolean;
}

type RuleId = "needs_input" | "finished" | "gap";

interface RuleRow {
	id: RuleId;
	name: string;
	when: string;
	title: string;
	body: string;
	priority: "High" | "Default";
	machines: OpsMachine[];
	sent: number | null;
	lastFiredAt: number | null;
	/** Per machine "MacBook: 3 sent, last 2 h ago" for the tooltip. */
	detail: string;
}

/** The hub's three alert kinds and what the phone shows for each (hub.alert_message and jobs.gap_title). */
const RULES: readonly {
	id: RuleId;
	name: string;
	when: string;
	title: string;
	body: string;
	priority: "High" | "Default";
}[] = [
	{
		id: "needs_input",
		name: "Session needs you",
		when: "A session asks a question, waits for plan approval, or shows a dialog in its terminal",
		title: "my-app needs you",
		body: "my-app: waiting for your answer · claude-opus-5-5",
		priority: "High",
	},
	{
		id: "finished",
		name: "Turn finished",
		when: "A session's turn that ran over a minute ends after you left it",
		title: "my-app finished",
		body: "my-app: turn done · claude-opus-5-5",
		priority: "Default",
	},
	{
		id: "gap",
		name: "Monitoring gap",
		when: "The hub could not check its jobs for a while",
		title: "Monitoring gap 02:10–03:40",
		body: "Mac asleep or hub stopped",
		priority: "Default",
	},
];

/** Only the start of the topic: anyone who knows the whole name can read the alerts. */
export function maskTopic(topic: string | null): string {
	return topic ? `${topic.slice(0, 8)}…` : "–";
}

export function AlertsRoute({ active }: AlertsRouteProps) {
	const { machines, all, fleet } = useOpsMachines();
	const alerts = usePerMachine("alerts", machines, (id, signal) => getHubAlerts(signal, id || undefined), {
		active,
		pollMs: 30_000,
	});
	const capabilities = useCapabilities(machines, active);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [sending, setSending] = useState<string | null>(null);

	const copy = async (row: ChannelRow) => {
		const a = row.alerts;
		if (!a?.topic) return;
		try {
			await navigator.clipboard.writeText(a.topic);
			setNotice({ tone: "ok", text: `${row.machine.name}'s topic copied: subscribe to it in the ntfy app.` });
		} catch {
			setNotice({
				tone: "bad",
				// The topic is a secret: never show it in full, even as a fallback.
				text: "Couldn't copy: the browser blocked the clipboard. The topic stays hidden.",
			});
		}
	};
	const test = async (row: ChannelRow) => {
		setSending(row.machine.id);
		setNotice(null);
		try {
			await sendHubTestAlert(row.machine.id || undefined);
			setNotice({
				tone: "ok",
				text: `Test alert sent from ${row.machine.name}: it should reach your phone in a few seconds.`,
			});
			alerts.refetch();
		} catch (error) {
			setNotice({
				tone: "bad",
				text: `Could not send from ${row.machine.name}: ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			setSending(null);
		}
	};

	const channels: ChannelRow[] = alerts.answers.map(answer => ({
		machine: answer.machine,
		alerts: answer.data,
		error: answer.error,
		stale: answer.stale,
	}));
	const timedOut = channels.filter(c => c.error);

	/** Machines whose alerts are on: the rules apply to them. */
	const ruleMachines = channels.filter(c => c.alerts?.enabled);
	/** A hub without per-rule counts: the capability is missing from its version, or no `rules` came back. */
	const lacksRules = (c: ChannelRow) => {
		const caps = capabilities(c.machine.id);
		return !c.alerts?.rules || (caps !== null && caps.alertsPerRule !== true);
	};
	// Counts persist on each hub, so a machine whose alerts are now off still contributes its history.
	const withRules = channels.filter(c => c.alerts && !lacksRules(c));
	const lackRules = channels.filter(c => c.alerts && lacksRules(c));
	const prefix = fleet ? `[${machines.find(m => m.self)?.name ?? machines[0]?.name ?? ""}] ` : "";
	const rules: RuleRow[] = RULES.map(rule => {
		const per = withRules.map(c => ({ machine: c.machine, state: c.alerts?.rules?.[rule.id] }));
		const fired = per.map(p => p.state?.lastFiredAt ?? 0).filter(Boolean);
		return {
			...rule,
			title: prefix + rule.title,
			machines: ruleMachines.map(c => c.machine),
			sent: per.length ? per.reduce((sum, p) => sum + (p.state?.sent ?? 0), 0) : null,
			lastFiredAt: fired.length ? Math.max(...fired) : null,
			detail: per
				.map(p => `${p.machine.short}: ${p.state?.sent ?? 0} sent${p.state?.lastFiredAt ? "" : ", never fired"}`)
				.join(" · "),
		};
	});

	const channelColumns: Column<ChannelRow>[] = [
		{
			key: "machine",
			header: "Machine",
			kind: "machine",
			width: 150,
			sort: c => machines.indexOf(c.machine),
			render: c => <OpsMachineCell machine={c.machine} />,
		},
		{
			key: "target",
			header: "Target",
			render: c =>
				c.alerts?.enabled && c.alerts.topic ? (
					<span className="ops-target">
						<span className="ops-pc-text" title="The full topic is only copied, never shown">
							<span className="ops-pc-title ops-mono">ntfy · {maskTopic(c.alerts.topic)}</span>
							<span className="ops-pc-sub">{c.alerts.server}</span>
						</span>
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							data-icon="true"
							aria-label={`Copy ${c.machine.name}'s topic`}
							title="Copy the topic"
							onClick={() => copy(c)}
						>
							<Copy size={13} />
						</button>
					</span>
				) : c.alerts ? (
					<span className="ops-pc-text">
						<span className="ops-pc-title">No topic</span>
						<span className="ops-pc-sub">
							Set <code>OMP_HUB_NTFY_TOPIC</code> and restart the hub
						</span>
					</span>
				) : (
					<span className="ops-dim">–</span>
				),
		},
		{
			key: "state",
			header: "State",
			kind: "status",
			width: 150,
			render: c =>
				c.error ? (
					<span className="ops-pc-text">
						<span className="badge" data-tone="warn">
							Didn't answer
						</span>
						<span className="ops-pc-sub" title={c.error}>
							{plainHubReason(c.error, { reachable: c.machine.reachable, refreshing: alerts.polling })}
						</span>
					</span>
				) : !c.alerts?.enabled ? (
					<span className="badge">Off</span>
				) : c.alerts.last_error ? (
					<span className="ops-pc-text">
						<span className="badge" data-tone="bad">
							Failing
						</span>
						<span className="ops-pc-sub" title={c.alerts.last_error}>
							{plainAlertProblem(c.alerts.last_error)}
						</span>
					</span>
				) : (
					<span className="badge" data-tone="ok">
						On
					</span>
				),
		},
		{
			key: "sent",
			header: "Sent",
			kind: "number",
			width: 70,
			sort: c => c.alerts?.sent,
			render: c => <span title="Since the hub started">{c.alerts?.sent ?? "–"}</span>,
		},
		{
			key: "last",
			header: "Last fired",
			kind: "date",
			width: 100,
			sort: c => c.alerts?.last_sent_at,
			render: c => <When at={c.alerts?.last_sent_at} empty="never" />,
		},
		{
			key: "watch",
			header: "Watch check",
			kind: "date",
			width: 110,
			priority: 2,
			render: c => (
				<span title="When the hub's session watcher last completed a pass">
					<When at={c.alerts?.watchOkAt} />
				</span>
			),
		},
		{
			key: "actions",
			header: "",
			kind: "actions",
			width: 150,
			render: c => (
				<button
					type="button"
					className="btn"
					data-size="sm"
					disabled={!!c.error || !c.alerts?.enabled || sending !== null || machineOffline(c.machine) !== null}
					title={machineOffline(c.machine) ?? undefined}
					aria-label={`Send test alert from ${c.machine.name}`}
					onClick={() => test(c)}
				>
					{sending === c.machine.id ? "Sending…" : "Send test alert"}
				</button>
			),
		},
	];

	const ruleColumns: Column<RuleRow>[] = [
		{
			key: "rule",
			header: "Rule",
			render: r => (
				<span className="ops-pc-text">
					<span className="ops-pc-title">{r.name}</span>
					<span className="ops-pc-sub" title={r.when}>
						{r.when}
					</span>
				</span>
			),
		},
		{
			key: "phone",
			header: "What your phone shows",
			width: 320,
			priority: 2,
			render: r => (
				<span className="ops-pc-text" title="Example">
					<span className="ops-pc-title">{r.title}</span>
					<span className="ops-pc-sub">{r.body}</span>
				</span>
			),
		},
		{
			key: "priority",
			header: "Priority",
			width: 90,
			render: r => (
				<span className="badge" data-tone={r.priority === "High" ? "warn" : "neutral"}>
					{r.priority}
				</span>
			),
		},
		{
			key: "machines",
			header: "Machines",
			width: 100,
			priority: 3,
			render: r => (
				<span className="ops-dim" title={r.machines.map(m => m.name).join(", ")}>
					{r.machines.length === 0
						? "none"
						: r.machines.length === 1
							? r.machines[0].short
							: r.machines.length === machines.length
								? `all ${r.machines.length}`
								: `${r.machines.length} of ${machines.length}`}
				</span>
			),
		},
		{
			key: "sent",
			header: "Sent",
			kind: "number",
			width: 70,
			priority: 2,
			render: r => <span title={r.detail || undefined}>{r.sent ?? "–"}</span>,
		},
		{
			key: "last",
			header: "Last fired",
			kind: "date",
			width: 100,
			render: r =>
				r.sent === null ? (
					<span className="ops-dim">–</span>
				) : (
					<span title={r.detail || undefined}>
						<When at={r.lastFiredAt} empty="never" />
					</span>
				),
		},
	];

	const single = machines.length === 1 ? machines[0] : null;
	return (
		<div className="page ops-page">
			<PageHeader
				title="Alerts"
				description={`${all || !single ? "Each machine sends its own" : `${single.id ? single.name : "This machine"} sends its`} phone alerts through ntfy. Alerts carry no transcript, only the workspace, project and model.`}
			/>
			<MachineProblems
				answers={alerts.answers}
				what="its alert settings"
				onRetry={alerts.refetch}
				polling={alerts.polling}
			/>
			<NoticeLine notice={notice} />
			<Table
				variant="std"
				dense
				title="Channels"
				subtitle={
					<>
						One ntfy topic per machine · keep the topic private: anyone who knows it can read the alerts
						{timedOut.length > 0 && (
							<span className="ops-warn"> · {timedOut.map(c => c.machine.name).join(", ")} didn't answer</span>
						)}
					</>
				}
				columns={channelColumns}
				rows={channels}
				rowKey={c => c.machine.id || "local"}
				loading={alerts.loading}
				initialSort={{ key: "machine", dir: "asc" }}
				stale={c => !!c.error || !c.machine.reachable}
				empty={
					<EmptyState title="Alerts are off" hint="Set OMP_HUB_NTFY_TOPIC on a machine to turn its alerts on." />
				}
			/>
			<Table
				variant="std"
				dense
				title="Rules"
				subtitle={
					<>
						What sends an alert · on the phone, install ntfy and subscribe to the machine's topic, then Send test
						alert
						{lackRules.map(c => (
							<span key={c.machine.id}>
								{" "}
								· <UpdateHubHint machine={c.machine}>to see when each rule last fired.</UpdateHubHint>
							</span>
						))}
					</>
				}
				columns={ruleColumns}
				rows={alerts.loading ? [] : rules}
				rowKey={r => r.id}
				loading={alerts.loading}
				empty={<EmptyState title="No rules" />}
			/>
		</div>
	);
}
