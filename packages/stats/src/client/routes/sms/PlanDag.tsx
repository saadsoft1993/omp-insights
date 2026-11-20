import { useMemo, useState } from "react";
import { STATUS_COLORS } from "./smsModel";
export interface PlanNode {
	key: string;
	title: string;
	url: string;
	lane: string;
	wave: number;
	slack: number;
	deps: string[];
	critical: boolean;
	high_risk: boolean;
	status: string;
	release: string;
	repos: string[];
	points: number | null;
	startable: boolean;
}
export interface Lane {
	id: string;
	name: string;
	builder: string;
	repos: string[];
}
export function PlanDag({ nodes, lanes }: { nodes: PlanNode[]; lanes: Lane[] }) {
	const [hover, setHover] = useState<string | null>(null);
	const graph = useMemo(() => {
		const cells = new Map<string, PlanNode[]>();
		const by = new Map(nodes.map(n => [n.key, n]));
		const children = new Map<string, string[]>();
		let waves = 1;
		for (const n of nodes) {
			waves = Math.max(waves, n.wave);
			const key = `${n.lane}|${n.wave}`;
			const cell = cells.get(key) || [];
			cell.push(n);
			cells.set(key, cell);
			for (const d of n.deps) {
				const c = children.get(d) || [];
				c.push(n.key);
				children.set(d, c);
			}
		}
		const pos = new Map<string, { x: number; y: number }>();
		let y = 26;
		const bands = lanes.map(lane => {
			let rows = 1;
			for (let w = 1; w <= waves; w++) rows = Math.max(rows, cells.get(`${lane.id}|${w}`)?.length || 0);
			const band = { lane, y, h: rows * 36 + 14 };
			for (let w = 1; w <= waves; w++)
				(cells.get(`${lane.id}|${w}`) || [])
					.sort((a, b) => a.slack - b.slack)
					.forEach((n, k) => pos.set(n.key, { x: 200 + (w - 1) * 150, y: y + 8 + k * 36 }));
			y += band.h;
			return band;
		});
		return { by, children, pos, bands, waves, height: y + 6 };
	}, [nodes, lanes]);
	const traced = useMemo(() => {
		if (!hover) return null;
		const seen = new Set([hover]);
		const visit = (key: string, dir: "up" | "down") => {
			for (const next of dir === "up" ? graph.by.get(key)?.deps || [] : graph.children.get(key) || []) {
				if (!seen.has(next)) {
					seen.add(next);
					visit(next, dir);
				}
			}
		};
		visit(hover, "up");
		visit(hover, "down");
		return seen;
	}, [hover, graph]);
	return (
		<div className="sms-dag">
			<svg
				width={200 + graph.waves * 150}
				height={graph.height}
				role="img"
				aria-label="Story dependencies by lane and wave"
				onMouseLeave={() => setHover(null)}
			>
				{graph.bands.map((b, k) => (
					<g key={b.lane.id}>
						<rect x="0" y={b.y} width="100%" height={b.h} fill={k % 2 ? "var(--surface-2)" : "transparent"} />
						<text x="10" y={b.y + 20}>
							{b.lane.name}
						</text>
					</g>
				))}
				{Array.from({ length: graph.waves }, (_, i) => (
					<text key={i} x={264 + i * 150} y="16" textAnchor="middle">
						wave {i + 1}
					</text>
				))}
				{nodes.flatMap(n =>
					n.deps.map(d => {
						const a = graph.pos.get(d),
							b = graph.pos.get(n.key);
						if (!a || !b) return null;
						const critical =
							graph.by.get(d)?.critical && n.critical && graph.by.get(d)?.slack === 0 && n.slack === 0;
						return (
							<path
								key={`${d}-${n.key}`}
								d={`M${a.x + 128},${a.y + 15} C${(a.x + 128 + b.x) / 2},${a.y + 15} ${(a.x + 128 + b.x) / 2},${b.y + 15} ${b.x},${b.y + 15}`}
								fill="none"
								stroke={critical ? "var(--chart-secondary)" : "currentColor"}
								opacity={traced ? (traced.has(d) && traced.has(n.key) ? 1 : 0.05) : critical ? 0.9 : 0.28}
								strokeWidth={critical ? 2 : 1}
							/>
						);
					}),
				)}
				{nodes.map(n => {
					const p = graph.pos.get(n.key);
					const dark = ["in-development", "in-review", "in-qa", "blocked", "done", "canceled"].includes(n.status);
					return (
						p && (
							<a
								href={n.url}
								target="_blank"
								rel="noopener noreferrer"
								key={n.key}
								onMouseEnter={() => setHover(n.key)}
								onFocus={() => setHover(n.key)}
								onBlur={() => setHover(null)}
								style={{ opacity: traced && !traced.has(n.key) ? 0.18 : 1 }}
							>
								<title>{`${n.key}: ${n.title}\n${n.status} · slack ${n.slack}\nNeeds: ${n.deps.join(", ") || "nothing"}`}</title>
								<rect
									x={p.x}
									y={p.y}
									width="128"
									height="30"
									rx="5"
									fill={STATUS_COLORS[n.status] || "var(--surface-2)"}
									stroke={n.critical ? "var(--chart-secondary)" : "currentColor"}
									strokeWidth={n.critical ? 3 : 1}
								/>
								<text fill={dark ? "#fff" : "#111"} x={p.x + 7} y={p.y + 13}>
									{n.high_risk ? "◆ " : ""}
									{n.key}
								</text>
								<text fill={dark ? "#fff" : "#111"} x={p.x + 7} y={p.y + 25}>
									{n.title.slice(0, 21)}
								</text>
							</a>
						)
					);
				})}
			</svg>
		</div>
	);
}
