import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { getLiveTrafficStats } from "../api";
import { OTHER_COLOR, SERIES_COLORS } from "../data/colors";
import { formatCompact, formatInteger } from "../data/formatters";
import { useQuery } from "../data/query";
import type {
	LiveAgentStatus,
	LiveRequestBreakdown,
	LiveSession,
	LiveTarget,
	LiveTargetState,
	LiveTrafficStats,
} from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	Dot,
	PageHeader,
	QueryView,
	Stat,
	StatGrid,
	Table,
	type Tone,
} from "../ui";
import "./live.css";

export interface LiveRouteProps {
	active: boolean;
}

const REFRESH_MS = 2000;
/** Dots per second above which a line's dot rate is capped. */
const MAX_DOTS_PER_S = 6;
/** Seconds a dot takes to travel its line. */
const DOT_TRAVEL_S = 1.4;
const SVG_NS = "http://www.w3.org/2000/svg";

const STATE: Record<LiveTargetState, { label: string; tone: Tone }> = {
	active: { label: "Active", tone: "ok" },
	quiet: { label: "Quiet", tone: "neutral" },
	rate_limited: { label: "Rate-limited", tone: "bad" },
	needs_login: { label: "Needs login", tone: "bad" },
};

/** Short "12s ago" style age, for numbers that move every refresh. */
function ago(timestamp: number | null, now: number): string {
	if (!timestamp) return "never";
	const s = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 172_800) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86_400)}d ago`;
}

/** Stable color per account target (first seen keeps its hue across refreshes); gateways and no-account nodes are grey. */
function useTargetColors(): (target: Pick<LiveTarget, "key" | "kind">) => string {
	const colors = useRef(new Map<string, string>());
	return useMemo(
		() => target => {
			if (target.kind !== "account") return OTHER_COLOR;
			let color = colors.current.get(target.key);
			if (!color) {
				color = SERIES_COLORS[colors.current.size % SERIES_COLORS.length];
				colors.current.set(target.key, color);
			}
			return color;
		},
		[],
	);
}

export function LiveRoute({ active }: LiveRouteProps) {
	const live = useQuery(["live"], ({ signal }) => getLiveTrafficStats(signal), {
		enabled: active,
		pollMs: REFRESH_MS,
	});
	const colorOf = useTargetColors();

	return (
		<div className="page">
			<PageHeader
				title="Live traffic"
				description={
					live.data
						? `Which sessions are sending requests to which account right now. Updated ${new Date(live.data.now).toLocaleTimeString()} · refreshes every 2 seconds.`
						: "Which sessions are sending requests to which account right now."
				}
			/>
			<div className="live-legend">
				<span>
					<Dot tone="ok" /> Active: completed a request in the last minute
				</span>
				<span>
					<Dot /> Quiet: no completed request in the last minute (one may be in progress)
				</span>
				<span>
					<Dot tone="bad" /> Rate-limited (omp holding traffic back) / Needs login
				</span>
				<span>
					<Dot tone="warn" /> Quota ≥ 95%: warning
				</span>
			</div>

			<QueryView query={live} skeleton={<ChartSkeleton height={112} />}>
				{data => <LiveSummary data={data} />}
			</QueryView>

			<Card
				index={1}
				title="Sessions and accounts"
				description="Lines show where each session's requests went in the last 5 minutes"
			>
				<QueryView query={live} skeleton={<ChartSkeleton height={260} />}>
					{data => <FlowStage data={data} colorOf={colorOf} animate={active} />}
				</QueryView>
			</Card>

			<Card index={2} title="Latest requests" description="Last 5 minutes" flush>
				<QueryView query={live} skeleton={<ChartSkeleton height={160} />}>
					{data => <LatestRequests data={data} colorOf={colorOf} />}
				</QueryView>
			</Card>

			<p className="live-note">
				Dots are spawned at each line's average rate over the last minute (one dot per completed request; above 6 a
				second the rate is capped), so they show volume, not the exact moment each request happened. Requests appear
				when they complete: a long request in flight shows up only when it finishes. Dashed lines carried traffic in
				the last 5 minutes but not the last minute. Sources are omp sessions; their subagents' requests count toward
				the session's line and are listed per agent inside its card. ▸ is the last tool the session or agent
				started, with omp's intent text. Agent states come from their transcripts: running (still writing, no exit),
				done, waiting (ended its turn; can be messaged again), finished (exited), no activity (no exit recorded and
				silent for 15 minutes).
			</p>
		</div>
	);
}

function LiveSummary({ data }: { data: LiveTrafficStats }) {
	const totalRpm = data.targets.reduce((sum, t) => sum + t.rpm, 0);
	const working = data.sessions.filter(s => s.working).length;
	const byProvider = groupByProvider(data.targets);
	return (
		<StatGrid min={190}>
			<Stat label="Requests" value={`${formatInteger(totalRpm)} / min`} hint="last 60 seconds" />
			<Stat
				label="Sessions working"
				value={formatInteger(working)}
				hint={`of ${formatInteger(data.sessions.length)} seen in 5 min`}
			/>
			<Stat
				label="Subagents running"
				value={formatInteger(data.sessions.reduce((sum, s) => sum + s.agentsRunning, 0))}
				hint={`across ${formatInteger(data.sessions.filter(s => s.agentsRunning > 0).length)} session(s)`}
			/>
			{[...byProvider].map(([provider, targets]) => {
				const rpm = targets.reduce((sum, t) => sum + t.rpm, 0);
				const parts = targets
					.filter(t => t.rpm > 0)
					.map(t => `${t.label} ${Math.round((t.rpm / rpm) * 100)}%`)
					.join(" · ");
				return (
					<Stat
						key={provider}
						label={provider}
						value={`${formatInteger(rpm)} req/min`}
						hint={parts || "no completed requests in the last minute"}
					/>
				);
			})}
		</StatGrid>
	);
}

function groupByProvider(targets: readonly LiveTarget[]): Map<string, LiveTarget[]> {
	const groups = new Map<string, LiveTarget[]>();
	for (const target of targets) {
		const list = groups.get(target.provider) ?? [];
		list.push(target);
		groups.set(target.provider, list);
	}
	return groups;
}

interface Line {
	key: string;
	path: SVGPathElement;
	length: number;
	color: string;
	/** Dots per second. */
	rate: number;
	/** Fractional dots owed; a dot spawns each time it reaches 1. */
	owed: number;
}

interface Particle {
	key: string;
	line: Line;
	el: SVGCircleElement;
	/** Progress along the line, 0..1. */
	t: number;
}

function dotElement(color: string): SVGCircleElement {
	const circle = document.createElementNS(SVG_NS, "circle");
	circle.setAttribute("r", "3.5");
	circle.setAttribute("fill", color);
	circle.setAttribute("style", `filter: drop-shadow(0 0 4px ${color})`);
	return circle;
}

/**
 * Sessions on the left, accounts on the right, a line per (session, target)
 * pair with traffic in the last five minutes. Dots travel each line at its
 * average rate over the last minute.
 */
function FlowStage({
	data,
	colorOf,
	animate,
}: {
	data: LiveTrafficStats;
	colorOf: (target: Pick<LiveTarget, "key" | "kind">) => string;
	animate: boolean;
}) {
	const stageRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const lines = useRef<Line[]>([]);
	const particles = useRef<Particle[]>([]);
	const targetByKey = useMemo(() => new Map(data.targets.map(t => [t.key, t])), [data.targets]);

	// Redraw the lines after every refresh and resize; dots keep moving along their redrawn line.
	useLayoutEffect(() => {
		const stage = stageRef.current;
		const svg = svgRef.current;
		if (!stage || !svg) return;
		const draw = () => {
			const box = stage.getBoundingClientRect();
			svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
			svg.replaceChildren();
			const owedBefore = new Map(lines.current.map(line => [line.key, line.owed]));
			const next: Line[] = [];
			for (const edge of data.edges) {
				const from = stage.querySelector(`[data-live-session="${CSS.escape(edge.from)}"]`);
				const to = stage.querySelector(`[data-live-target="${CSS.escape(edge.to)}"]`);
				const target = targetByKey.get(edge.to);
				if (!from || !to || !target) continue;
				const a = from.getBoundingClientRect();
				const b = to.getBoundingClientRect();
				const x1 = a.right - box.left;
				const y1 = a.top + a.height / 2 - box.top;
				const x2 = b.left - box.left;
				const y2 = b.top + b.height / 2 - box.top;
				const dx = (x2 - x1) * 0.5;
				const path = document.createElementNS(SVG_NS, "path");
				path.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
				const color = colorOf(target);
				const live = edge.rpm > 0;
				path.setAttribute("fill", "none");
				path.setAttribute("stroke", color);
				path.setAttribute("stroke-width", String(live ? Math.min(6, 1.5 + Math.log2(1 + edge.rpm)) : 1));
				path.setAttribute("stroke-opacity", live ? "0.45" : "0.18");
				if (!live) path.setAttribute("stroke-dasharray", "4 5");
				svg.appendChild(path);
				const key = `${edge.from}\0${edge.to}`;
				next.push({
					key,
					path,
					length: path.getTotalLength(),
					color,
					// The line's real average rate over the last minute; no minimum, capped at MAX_DOTS_PER_S.
					rate: live ? Math.min(MAX_DOTS_PER_S, edge.rpm / 60) : 0,
					// Keep the spawn clock across refreshes; a line that just came alive starts with a dot.
					owed: owedBefore.get(key) ?? (live ? 1 : 0),
				});
			}
			lines.current = next;
			const byKey = new Map(next.map(line => [line.key, line]));
			const kept: Particle[] = [];
			for (const particle of particles.current) {
				const line = byKey.get(particle.key);
				if (!line) continue;
				particle.line = line;
				particle.el = dotElement(line.color);
				svg.appendChild(particle.el);
				kept.push(particle);
			}
			particles.current = kept;
		};
		draw();
		const observer = new ResizeObserver(draw);
		observer.observe(stage);
		return () => observer.disconnect();
	}, [data, targetByKey, colorOf]);

	useEffect(() => {
		if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		let frame = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const dt = Math.min(0.1, (now - last) / 1000);
			last = now;
			const svg = svgRef.current;
			if (svg && !document.hidden) {
				for (const line of lines.current) {
					if (line.rate === 0) continue;
					line.owed += line.rate * dt;
					while (line.owed >= 1) {
						line.owed -= 1;
						const el = dotElement(line.color);
						svg.appendChild(el);
						particles.current.push({ key: line.key, line, el, t: 0 });
					}
				}
				particles.current = particles.current.filter(p => {
					p.t += dt / DOT_TRAVEL_S;
					if (p.t >= 1) {
						p.el.remove();
						return false;
					}
					const point = p.line.path.getPointAtLength(p.t * p.line.length);
					p.el.setAttribute("cx", String(point.x));
					p.el.setAttribute("cy", String(point.y));
					p.el.setAttribute("opacity", String(p.t < 0.1 ? p.t * 10 : p.t > 0.85 ? (1 - p.t) / 0.15 : 1));
					return true;
				});
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [animate]);

	const byProvider = groupByProvider(data.targets);
	return (
		<div className="live-stage" ref={stageRef}>
			<svg className="live-flows" ref={svgRef} aria-hidden="true" />
			<div className="live-col">
				<div className="live-col-title">Sessions</div>
				{data.sessions.length === 0 ? (
					<div className="live-empty">No omp session has sent a request in the last 5 minutes.</div>
				) : (
					data.sessions.map(session => (
						<SessionCard
							key={session.id}
							session={session}
							now={data.now}
							colorOfKey={key => {
								const target = targetByKey.get(key);
								return target ? colorOf(target) : OTHER_COLOR;
							}}
						/>
					))
				)}
			</div>
			<div />
			<div className="live-col">
				<div className="live-col-title">Providers and accounts</div>
				{[...byProvider].map(([provider, targets]) => (
					<div key={provider} className="live-provider">
						<div className="live-provider-head">
							<b>{provider}</b>
							<span>{formatInteger(targets.reduce((sum, t) => sum + t.rpm, 0))} req/min</span>
						</div>
						{targets.map(target => (
							<TargetCard key={target.key} target={target} color={colorOf(target)} now={data.now} />
						))}
					</div>
				))}
			</div>
		</div>
	);
}

function SessionCard({
	session,
	now,
	colorOfKey,
}: {
	session: LiveSession;
	now: number;
	colorOfKey: (key: string) => string;
}) {
	const { working, agentsRunning } = session;
	const started = session.started
		? `started ${new Date(session.started).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
		: "";
	const project = session.name !== session.project ? session.project : "";
	return (
		<div className="live-card live-session" data-state={working ? "active" : "quiet"} data-live-session={session.id}>
			<div className="live-row">
				<div className="live-grow">
					<div className="live-name" title={session.id}>
						{working && <Dot tone="live" pulse />} {session.name}
					</div>
					<div className="live-meta live-started">{[project, started].filter(Boolean).join(" · ")}</div>
				</div>
				<div className="live-rate">
					{formatInteger(session.rpm)}
					<small>/min</small>
				</div>
			</div>
			<div className="live-meta">
				{[
					agentsRunning > 0 &&
						`Working · ${formatInteger(agentsRunning)} subagent${agentsRunning === 1 ? "" : "s"}`,
					session.last ? `last request ${ago(session.last, now)}` : "no requests in 5 min",
				]
					.filter(Boolean)
					.join(" · ")}
			</div>
			{session.doing && (
				<div className="live-doing" title={session.doing.name ?? undefined}>
					▸ {session.doing.intent ?? session.doing.name} <span className="dim">{ago(session.doing.at, now)}</span>
				</div>
			)}
			{session.agents.length > 0 && <AgentRows session={session} now={now} colorOfKey={colorOfKey} />}
		</div>
	);
}

const AGENT_STATE: Record<LiveAgentStatus, string> = {
	running: "running",
	idle: "done, waiting",
	finished: "finished",
	stopped: "no activity",
};
/** Agent rows shown per session card; the rest are counted. */
const SHOWN_AGENTS = 8;

/** "N subagents running · M done or quiet" and one row per agent: state dot, name, what it is doing, accounts, rate. */
function AgentRows({
	session,
	now,
	colorOfKey,
}: {
	session: LiveSession;
	now: number;
	colorOfKey: (key: string) => string;
}) {
	const { agents, agentsRunning } = session;
	const shown = agents.slice(0, SHOWN_AGENTS);
	const quiet = agents.length - agentsRunning;
	return (
		<div className="live-agents">
			<div className="live-agents-head">
				{formatInteger(agentsRunning)} subagent{agentsRunning === 1 ? "" : "s"} running
				{quiet > 0 ? ` · ${formatInteger(quiet)} done or quiet` : ""}
			</div>
			{shown.map(agent => (
				<div key={agent.id} className="live-agent" data-status={agent.status}>
					<span className="live-agent-dot" />
					<span className="live-agent-name" title={agent.name}>
						{agent.name}
					</span>
					<span className="live-agent-doing" title={agent.doing?.intent ?? undefined}>
						{agent.doing?.intent ?? agent.doing?.name ?? AGENT_STATE[agent.status]}
					</span>
					{agent.targets.map(key => (
						<span key={key} className="swatch" title={key} style={{ background: colorOfKey(key) }} />
					))}
					<span className="live-agent-rate">
						{agent.rpm > 0
							? `${formatInteger(agent.rpm)}/m`
							: agent.status === "running"
								? ago(agent.last, now)
								: AGENT_STATE[agent.status]}
					</span>
				</div>
			))}
			{agents.length > shown.length && (
				<div className="live-agent dim">+{formatInteger(agents.length - shown.length)} more</div>
			)}
		</div>
	);
}

function TargetCard({ target, color, now }: { target: LiveTarget; color: string; now: number }) {
	return (
		<div
			className="live-card live-target"
			data-state={target.state}
			data-kind={target.kind}
			data-live-target={target.key}
		>
			<div className="live-row">
				<span className="swatch" style={{ background: color }} />
				<div className="live-grow">
					<div className="live-name">{target.label}</div>
					<div className="live-meta">{target.meta ?? ""}</div>
				</div>
				{target.quotaWarning && (
					<span title="A quota window is at 95% or more">
						<Badge tone="warn">Quota ≥ 95%</Badge>
					</span>
				)}
				<Badge tone={STATE[target.state].tone}>{STATE[target.state].label}</Badge>
			</div>
			<div className="live-row live-meta">
				<span className="live-rate">
					{formatInteger(target.rpm)}
					<small>/min</small>
				</span>
				<span className="live-tpm">{formatCompact(target.tpm)} tokens/min</span>
				<span className="live-grow" />
				<span>last {ago(target.last, now)}</span>
			</div>
			{target.breakdown && target.breakdown.housekeeping + target.breakdown.turns > 0 && (
				<BreakdownLine breakdown={target.breakdown} />
			)}
			{target.quotas.length > 0 && (
				<div className="live-quotas">
					{target.quotas.map(q => {
						const used = q.usedFraction ?? 0;
						return (
							<div key={q.limitId} className="live-quota">
								<span>{q.label.replace(/^Claude /, "")}</span>
								<div className="live-bar" data-level={used >= 0.95 ? "full" : used >= 0.75 ? "warn" : "ok"}>
									<i style={{ width: `${Math.min(100, used * 100)}%` }} />
								</div>
								<span className="live-quota-pct">{Math.round(used * 100)}%</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** Top housekeeping purposes shown inline; the rest are in the tooltip. */
const SHOWN_PURPOSES = 4;

/** "N housekeeping (purposes…) · M turns" for the requests of the last five minutes that recorded no account. */
function BreakdownLine({ breakdown }: { breakdown: LiveRequestBreakdown }) {
	const { housekeeping, turns, purposes } = breakdown;
	const shown = purposes.slice(0, SHOWN_PURPOSES).map(p => `${p.purpose} ${formatInteger(p.requests)}`);
	if (purposes.length > SHOWN_PURPOSES) shown.push("…");
	return (
		<div
			className="live-meta live-breakdown"
			title={purposes.map(p => `${p.purpose}: ${formatInteger(p.requests)}`).join("\n") || undefined}
		>
			last 5 min: {formatInteger(housekeeping)} housekeeping{shown.length > 0 ? ` (${shown.join(", ")})` : ""} ·{" "}
			{formatInteger(turns)} {turns === 1 ? "turn" : "turns"}
		</div>
	);
}

interface RecentRow {
	id: string;
	ts: number;
	session: string;
	agent: string | null;
	target: LiveTarget | undefined;
	targetKey: string;
	model: string;
	tokens: number;
}

function LatestRequests({
	data,
	colorOf,
}: {
	data: LiveTrafficStats;
	colorOf: (target: Pick<LiveTarget, "key" | "kind">) => string;
}) {
	const rows = useMemo<RecentRow[]>(() => {
		const sessions = new Map(data.sessions.map(s => [s.id, s.name]));
		const targets = new Map(data.targets.map(t => [t.key, t]));
		return data.recent.map((r, i) => ({
			id: `${r.ts}:${i}`,
			ts: r.ts,
			session: sessions.get(r.session) ?? r.session,
			agent: r.agent,
			target: targets.get(r.target),
			targetKey: r.target,
			model: r.model,
			tokens: r.tokens,
		}));
	}, [data]);
	const columns = useMemo<Column<RecentRow>[]>(
		() => [
			{
				key: "time",
				header: "Time",
				render: r => <span className="num">{new Date(r.ts).toLocaleTimeString()}</span>,
			},
			{
				key: "session",
				header: "Session",
				render: r => (
					<span className="truncate live-cell">
						{r.session}
						{r.agent && <span className="dim"> › {r.agent}</span>}
					</span>
				),
			},
			{
				key: "target",
				header: "Target",
				render: r => (
					<span className="row" style={{ gap: 6 }}>
						<span className="swatch" style={{ background: r.target ? colorOf(r.target) : OTHER_COLOR }} />
						<span className="truncate live-cell">
							{r.target
								? r.target.kind === "no_account"
									? `${r.target.label} (${r.target.provider})`
									: r.target.label
								: r.targetKey}
						</span>
					</span>
				),
			},
			{ key: "model", header: "Model", render: r => <span className="mono truncate live-cell">{r.model}</span> },
			{
				key: "tokens",
				header: "Tokens",
				align: "right",
				render: r => <span className="num">{formatCompact(r.tokens)}</span>,
			},
		],
		[colorOf],
	);
	return (
		<div className="live-recent">
			<Table
				rows={rows}
				rowKey={r => r.id}
				columns={columns}
				dense
				empty={<div className="live-empty">No requests in the last 5 minutes.</div>}
			/>
		</div>
	);
}
