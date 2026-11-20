import { concreteMachine, useFleet } from "../app/machine";
/**
 * Single-session trace viewer: summary strip, axis-mode toolbar, minimap,
 * flamegraph canvas, transcript list, tool aggregates, and the span drawer.
 * Owns the shared viewport/selection state so all pieces stay in sync.
 */

import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSessionEntryDetail, getSessionTrace, getSessionTraceTrack } from "../api";
import { namedStatsReason, statsFailureSentence } from "../app/stats-reasons";
import { useQuery } from "../data/query";
import type { SessionTrace, SessionTraceTrackResponse, TraceSpan, TraceSpanKind, TraceTrack } from "../types";
import { Card, ChartSkeleton, PageHeader, QueryView, SearchInput, Segmented } from "../ui";
import { AggregatesPanel } from "./AggregatesPanel";
import { Minimap } from "./Minimap";
import { SpanDrawer, type TraceEntryLoader } from "./SpanDrawer";
import { SummaryStrip } from "./SummaryStrip";
import { TimelineCanvas, type TimelineViewport } from "./TimelineCanvas";
import { TranscriptList } from "./TranscriptList";
import { CATEGORY_VARS } from "./trace-colors";
import { type AxisMode, buildScale } from "./time-scale";

export interface TraceViewProps {
	file: string;
	machine?: string;
	active: boolean;
	onBack: () => void;
}

const MODE_OPTIONS: Array<{ value: AxisMode; label: string; title?: string }> = [
	{ value: "time", label: "Duration", title: "Real wall-clock time" },
	{ value: "turns", label: "Turns", title: "Equal width per user turn" },
	{ value: "calls", label: "Calls", title: "Equal width per model/tool call boundary" },
];

const LEGEND: Array<{ kind: TraceSpanKind; label: string }> = [
	{ kind: "turn", label: "Input" },
	{ kind: "model", label: "Model" },
	{ kind: "tool", label: "Tool" },
	{ kind: "subagent", label: "Agent" },
	{ kind: "background", label: "Background" },
];

interface LazyTracks {
	key: string;
	requested: ReadonlySet<string>;
	loaded: ReadonlyMap<string, TraceTrack>;
	failed: ReadonlySet<string>;
	/** The raw reason each failed track gave, for its plain wording and Details tooltip. */
	reasons: ReadonlyMap<string, string>;
	/** Loaded tracks whose latest refresh failed: the last good spans stay, marked, with the raw reason. */
	stale: ReadonlyMap<string, string>;
	/** Try again presses per loaded track; each one refetches that track. */
	retries: ReadonlyMap<string, number>;
}

const EMPTY_LAZY: LazyTracks = {
	key: "",
	requested: new Set(),
	loaded: new Map(),
	failed: new Set(),
	reasons: new Map(),
	stale: new Map(),
	retries: new Map(),
};

function TrackSpansLoader({
	file,
	trackId,
	machine,
	active,
	parent,
	parentUpdatedAt,
	retry,
	onLoaded,
	onFailed,
}: {
	file: string;
	trackId: string;
	machine: string | undefined;
	active: boolean;
	parent: SessionTrace | null;
	/** When the parent trace last answered (a 304 included): a failed refresh is asked again then. */
	parentUpdatedAt: number | null;
	/** Bumped by Try again on a loaded track whose refresh failed. */
	retry: number;
	onLoaded: (id: string, track: TraceTrack) => void;
	/** `stale`: the track had loaded before, so its last good spans stay on screen. */
	onFailed: (id: string, reason: string, stale: boolean) => void;
}): null {
	const query = useQuery<SessionTraceTrackResponse>(
		["trace-track", file, trackId, machine],
		({ signal }, previous) => getSessionTraceTrack(file, trackId, signal, previous, machine),
		{ enabled: active, retain: false },
	);
	// Reported on every answer, so a recovery after a failed refresh (even an unchanged 304) clears the mark.
	useEffect(() => {
		if (query.data && !query.error) onLoaded(trackId, query.data.track);
	}, [query.data, query.error, onLoaded, trackId]);
	// A refresh failing after a good load is reported too: the old spans stay, marked as not refreshed.
	useEffect(() => {
		if (query.error) onFailed(trackId, query.error.message, !!query.data);
	}, [query.error, query.data, onFailed, trackId]);
	const lastParent = useRef(parent);
	useEffect(() => {
		if (lastParent.current !== parent) {
			lastParent.current = parent;
			query.refetch();
		}
	}, [parent, query.refetch]);
	// The parent's refresh (a 304 too) asks a failed track again, so it never stays stale for good.
	const lastParentAnswer = useRef(parentUpdatedAt);
	const failing = !!query.error;
	useEffect(() => {
		if (lastParentAnswer.current === parentUpdatedAt) return;
		lastParentAnswer.current = parentUpdatedAt;
		if (failing) query.refetch();
	}, [parentUpdatedAt, failing, query.refetch]);
	const lastRetry = useRef(retry);
	useEffect(() => {
		if (lastRetry.current === retry) return;
		lastRetry.current = retry;
		query.refetch();
	}, [retry, query.refetch]);
	return null;
}

export function TraceView({ file, machine, active, onBack }: TraceViewProps) {
	const traceMachine = machine ?? concreteMachine();
	const stateKey = `${file}\n${traceMachine}`;
	const [lazy, setLazy] = useState<LazyTracks>(EMPTY_LAZY);
	const current = lazy.key === stateKey ? lazy : EMPTY_LAZY;
	const requestTrack = useCallback(
		(id: string) => {
			setLazy(previous => {
				const base = previous.key === stateKey ? previous : EMPTY_LAZY;
				const requested = new Set(base.requested);
				const failed = new Set(base.failed);
				requested.add(id);
				failed.delete(id);
				return { ...base, key: stateKey, requested, failed };
			});
		},
		[stateKey],
	);
	const onLoaded = useCallback(
		(id: string, track: TraceTrack) => {
			setLazy(previous => {
				const base = previous.key === stateKey ? previous : EMPTY_LAZY;
				if (base.loaded.get(id) === track && !base.stale.has(id)) return previous;
				const loaded = new Map(base.loaded);
				loaded.set(id, track);
				const stale = new Map(base.stale);
				stale.delete(id);
				return { ...base, key: stateKey, loaded, stale };
			});
		},
		[stateKey],
	);
	const onFailed = useCallback(
		(id: string, reason: string, hadSpans: boolean) => {
			setLazy(previous => {
				const base = previous.key === stateKey ? previous : EMPTY_LAZY;
				if (hadSpans) {
					// Keep the loader (and its last good spans); mark the track as not refreshed.
					if (base.stale.get(id) === reason) return previous;
					const stale = new Map(base.stale);
					stale.set(id, reason);
					return { ...base, key: stateKey, stale };
				}
				const requested = new Set(base.requested);
				const failed = new Set(base.failed);
				const reasons = new Map(base.reasons);
				requested.delete(id);
				failed.add(id);
				reasons.set(id, reason);
				return { ...base, key: stateKey, requested, failed, reasons };
			});
		},
		[stateKey],
	);
	// Try again on a loaded track whose refresh failed: ask that track again.
	const retryTrack = useCallback(
		(id: string) => {
			setLazy(previous => {
				const base = previous.key === stateKey ? previous : EMPTY_LAZY;
				const retries = new Map(base.retries);
				retries.set(id, (retries.get(id) ?? 0) + 1);
				return { ...base, key: stateKey, retries };
			});
		},
		[stateKey],
	);
	const loadEntry = useCallback<TraceEntryLoader>(
		(entryFile, entryId, signal) => getSessionEntryDetail(entryFile, entryId, signal, traceMachine),
		[traceMachine],
	);
	const query = useQuery<SessionTrace>(
		["trace", file, traceMachine],
		({ signal }, previous) => getSessionTrace(file, signal, previous, traceMachine),
		{ pollMs: 15000, enabled: active },
	);
	// A previous session's trace must never render under this file's header.
	const trace = query.stale ? null : query.data;
	const mergedTrace = useMemo(
		() =>
			trace && {
				...trace,
				tracks: trace.tracks.map(t => (t.omittedSpans === undefined ? t : (current.loaded.get(t.id) ?? t))),
			},
		[trace, current.loaded],
	);
	const loadingTracks = useMemo(
		() => new Set([...current.requested].filter(id => !current.loaded.has(id))),
		[current.requested, current.loaded],
	);
	// Each failed track says why in plain words (no "retrying": a track loads only when asked), raw cause as Details.
	const machineName = useMachineName(traceMachine);
	const trackFailures = useMemo(
		() =>
			new Map(
				[...current.failed].map(id => {
					const raw = current.reasons.get(id) ?? null;
					const plain = `Couldn't load these spans: ${namedStatsReason(machineName, raw)}.`;
					return [id, raw ? `${plain} Details: ${raw}` : plain] as const;
				}),
			),
		[current.failed, current.reasons, machineName],
	);
	// Loaded tracks whose refresh failed: the parent's next refresh asks them again, so say so.
	const staleTracks = useMemo(
		() =>
			new Map(
				[...current.stale].map(([id, raw]) => {
					const plain = `Couldn't refresh these spans: ${namedStatsReason(machineName, raw)}. Showing the last loaded spans; they're asked again with the trace's next refresh.`;
					return [id, `${plain} Details: ${raw}`] as const;
				}),
			),
		[current.stale, machineName],
	);

	return (
		<div className="stack traces-view">
			<div>
				<button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={onBack}>
					<ArrowLeft size={14} aria-hidden="true" />
					Sessions
				</button>
			</div>
			<PageHeader
				title={<span className="traces-title truncate">{trace?.title ?? file.split("/").pop()}</span>}
				description={trace?.cwd ? <span className="mono">{trace.cwd}</span> : undefined}
				actions={
					<button
						type="button"
						className="btn"
						data-variant="ghost"
						data-icon="true"
						onClick={query.refetch}
						aria-label="Refresh trace"
						title="Refresh trace"
					>
						<RefreshCw size={14} className={query.refreshing ? "traces-spin" : undefined} />
					</button>
				}
			/>
			{[...current.requested].map(id => (
				<TrackSpansLoader
					key={id}
					file={file}
					trackId={id}
					machine={traceMachine}
					active={active}
					parent={trace}
					parentUpdatedAt={query.updatedAt}
					retry={current.retries.get(id) ?? 0}
					onLoaded={onLoaded}
					onFailed={onFailed}
				/>
			))}
			<QueryView
				query={{ ...query, data: mergedTrace }}
				skeleton={<ChartSkeleton height={420} />}
				errorMessage={reason =>
					reason === "session not found"
						? "This session's file is gone; it may have been moved or deleted."
						: statsFailureSentence(null, reason, { refreshing: query.polling })
				}
			>
				{loaded => (
					<SessionTraceView
						trace={loaded}
						loadEntry={loadEntry}
						onLoadTrack={requestTrack}
						loadingTracks={loadingTracks}
						failedTracks={current.failed}
						trackFailures={trackFailures}
						staleTracks={staleTracks}
						onRetryTrack={retryTrack}
					/>
				)}
			</QueryView>
		</div>
	);
}

/** Data and host integration supplied to the shared live/offline trace viewer. */
export interface SessionTraceViewProps {
	trace: SessionTrace;
	view?: "timeline" | "full";
	loadEntry?: TraceEntryLoader;
	/** Embedded viewers keep details inside their own layout, without a modal. */
	embedded?: boolean;
	onNavigate?: (trackId: string, entryId: string) => void;
	onLoadTrack?: (trackId: string) => void;
	loadingTracks?: ReadonlySet<string>;
	failedTracks?: ReadonlySet<string>;
	/** Plain explanation (with the raw cause as Details) for each failed track, shown on its Try again button. */
	trackFailures?: ReadonlyMap<string, string>;
	/** Loaded tracks whose refresh failed, with their explanation; they get a "couldn't refresh" Try again. */
	staleTracks?: ReadonlyMap<string, string>;
	onRetryTrack?: (trackId: string) => void;
}

/** Data-driven viewer shared by the live route and self-contained HTML exports. */
export function SessionTraceView({
	trace,
	view = "full",
	loadEntry,
	embedded = false,
	onNavigate,
	onLoadTrack,
	loadingTracks,
	failedTracks,
	trackFailures,
	staleTracks,
	onRetryTrack,
}: SessionTraceViewProps) {
	const [mode, setMode] = useState<AxisMode>("time");
	const [compressIdle, setCompressIdle] = useState(true);
	const [selection, setSelection] = useState<string | null>(null);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [matchIndex, setMatchIndex] = useState(0);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [viewport, setViewport] = useState<TimelineViewport | null>(null);

	const tracks = useMemo(() => trace?.tracks ?? [], [trace]);
	const scale = useMemo(() => buildScale(tracks, mode, compressIdle), [tracks, mode, compressIdle]);
	const scaleRef = useRef(scale);

	// File change: reset viewport/selection and default-collapse deep tracks.
	const lastFileRef = useRef<string | null>(null);
	useEffect(() => {
		if (!trace) return;
		if (lastFileRef.current === trace.file) return;
		lastFileRef.current = trace.file;
		setSelection(null);
		setSearch("");
		setViewport(null);
		const deep = new Set<string>();
		for (const track of trace.tracks) {
			const depth = track.id === "main" ? 0 : track.id.split("/").length;
			if (depth >= 1) deep.add(track.id);
		}
		setCollapsed(deep);
	}, [trace]);

	// Axis-mode / compression switches remap the viewport through wall time so
	// the visible window stays put; selection survives untouched.
	useEffect(() => {
		const prev = scaleRef.current;
		scaleRef.current = scale;
		setViewport(current => {
			if (!current) return current;
			const t0 = prev.toT(current.u0);
			const t1 = prev.toT(current.u1);
			const u0 = scale.toU(t0);
			const u1 = scale.toU(t1);
			return u1 - u0 > 0 ? { u0, u1 } : null;
		});
	}, [scale]);

	const effectiveViewport = useMemo<TimelineViewport>(
		() => viewport ?? { u0: scale.domain[0], u1: scale.domain[1] },
		[viewport, scale],
	);

	const allSpans = useMemo(() => {
		const spans: Array<{ span: TraceSpan; track: TraceTrack }> = [];
		for (const track of tracks) {
			for (const span of track.spans) spans.push({ span, track });
		}
		spans.sort((a, b) => a.span.start - b.span.start);
		return spans;
	}, [tracks]);

	const matches = useMemo(() => {
		const needle = search.trim().toLowerCase();
		if (!needle) return [];
		return allSpans.filter(({ span }) => `${span.label} ${span.detail ?? ""}`.toLowerCase().includes(needle));
	}, [allSpans, search]);
	// Shared with the canvas and transcript so the match test runs once per search.
	const matchIds = useMemo(
		() => (search.trim() ? new Set(matches.map(({ span }) => span.id)) : null),
		[matches, search],
	);

	const centerOnSpan = useCallback(
		(span: TraceSpan) => {
			const u = scale.toU(span.start);
			const uEnd = scale.toU(span.end);
			setViewport(current => {
				const vp = current ?? { u0: scale.domain[0], u1: scale.domain[1] };
				if (u >= vp.u0 && uEnd <= vp.u1) return current;
				const window = vp.u1 - vp.u0;
				const mid = (u + uEnd) / 2;
				const [d0, d1] = scale.domain;
				let u0 = mid - window / 2;
				if (u0 < d0) u0 = d0;
				if (u0 + window > d1) u0 = Math.max(d0, d1 - window);
				return { u0, u1: u0 + window };
			});
		},
		[scale],
	);

	const selectAndReveal = useCallback(
		(spanId: string) => {
			setSelection(spanId);
			const found = allSpans.find(({ span }) => span.id === spanId);
			if (found) centerOnSpan(found.span);
		},
		[allSpans, centerOnSpan],
	);
	// Canvas click / transcript click: select AND open the detail drawer.
	// Search cycling only selects, so the timeline stays visible.
	const selectAndOpen = useCallback((spanId: string | null) => {
		setSelection(spanId);
		setDrawerOpen(spanId !== null);
	}, []);

	const cycleMatch = useCallback(
		(direction: 1 | -1) => {
			if (matches.length === 0) return;
			const next = (((matchIndex + direction) % matches.length) + matches.length) % matches.length;
			setMatchIndex(next);
			selectAndReveal(matches[next].span.id);
		},
		[matches, matchIndex, selectAndReveal],
	);

	const toggleCollapse = useCallback((trackId: string) => {
		setCollapsed(current => {
			const next = new Set(current);
			if (next.has(trackId)) next.delete(trackId);
			else next.add(trackId);
			return next;
		});
	}, []);

	const selected = useMemo(() => {
		if (!selection) return null;
		return allSpans.find(({ span }) => span.id === selection) ?? null;
	}, [selection, allSpans]);

	const pendingRevealRef = useRef<string | null>(null);
	const openChildTrack = useCallback(
		(childTrackId: string) => {
			const child = tracks.find(track => track.id === childTrackId);
			const first = child?.spans[0];
			// Expand ancestors so the track is visible.
			setCollapsed(current => {
				const next = new Set(current);
				let cursor = child;
				while (cursor?.parentId) {
					next.delete(cursor.parentId);
					cursor = tracks.find(track => track.id === cursor?.parentId);
				}
				return next;
			});
			if (child?.omittedSpans !== undefined && onLoadTrack) {
				pendingRevealRef.current = child.id;
				onLoadTrack(child.id);
				return;
			}
			if (first) selectAndReveal(first.id);
		},
		[tracks, selectAndReveal, onLoadTrack],
	);

	useEffect(() => {
		const id = pendingRevealRef.current;
		if (!id) return;
		const track = tracks.find(t => t.id === id);
		if (track && track.omittedSpans === undefined && track.spans[0]) {
			selectAndReveal(track.spans[0].id);
			pendingRevealRef.current = null;
		} else if (track?.omittedSpans !== undefined && !loadingTracks?.has(id)) {
			pendingRevealRef.current = null;
		}
	}, [tracks, loadingTracks, selectAndReveal]);

	const collapseAll = useCallback(
		(collapse: boolean) => {
			if (!collapse) {
				setCollapsed(new Set());
				return;
			}
			const all = new Set<string>();
			for (const track of tracks) {
				if (track.id !== "main") all.add(track.id);
			}
			setCollapsed(all);
		},
		[tracks],
	);

	const openFromTranscript = useCallback(
		(spanId: string) => {
			selectAndReveal(spanId);
			setDrawerOpen(true);
		},
		[selectAndReveal],
	);
	const closeDrawer = useCallback(() => setDrawerOpen(false), []);

	const traceStart = trace.startedAt;

	return (
		<div className="stack traces-view" data-view={view}>
			{view === "full" && <SummaryStrip summary={trace.summary} />}
			{allSpans.length === 0 && <p className="muted">No spans recorded in this session.</p>}

			<Card
				index={1}
				title="Timeline"
				description="W/S zoom · A/D pan · drag pan · wheel zoom · 0 fit · F focus selection · dbl-click focus · Esc deselect"
				actions={
					<>
						<button
							type="button"
							className="btn"
							data-variant="ghost"
							data-size="sm"
							onClick={() => collapseAll(false)}
						>
							Expand all
						</button>
						<button
							type="button"
							className="btn"
							data-variant="ghost"
							data-size="sm"
							onClick={() => collapseAll(true)}
						>
							Collapse all
						</button>
					</>
				}
			>
				<div className="stack">
					<div className="traces-toolbar">
						<Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} size="sm" aria-label="Axis mode" />
						{mode === "time" && (
							<label className="traces-check">
								<input
									type="checkbox"
									checked={compressIdle}
									onChange={event => setCompressIdle(event.target.checked)}
								/>
								Compress idle
							</label>
						)}
						<div className="traces-search">
							<SearchInput
								value={search}
								onChange={value => {
									setSearch(value);
									setMatchIndex(0);
								}}
								label="Search spans"
								placeholder="Search spans…"
								width={200}
							/>
							{search.trim() && (
								<>
									<span className="num muted traces-match-count">
										{matches.length === 0
											? "0"
											: `${(matchIndex % Math.max(matches.length, 1)) + 1}/${matches.length}`}
									</span>
									<button
										type="button"
										className="btn"
										data-variant="ghost"
										data-size="sm"
										data-icon="true"
										onClick={() => cycleMatch(-1)}
										aria-label="Previous match"
										disabled={matches.length === 0}
									>
										<ChevronLeft size={14} />
									</button>
									<button
										type="button"
										className="btn"
										data-variant="ghost"
										data-size="sm"
										data-icon="true"
										onClick={() => cycleMatch(1)}
										aria-label="Next match"
										disabled={matches.length === 0}
									>
										<ChevronRight size={14} />
									</button>
								</>
							)}
						</div>
						{search.trim() && tracks.some(t => t.omittedSpans !== undefined) && (
							<p className="muted">
								Search covers loaded tracks only; {tracks.filter(t => t.omittedSpans !== undefined).length}{" "}
								subagent tracks are not loaded.
							</p>
						)}
						<div className="traces-legend">
							{LEGEND.map(item => (
								<span key={item.kind} className="traces-legend-item">
									<span className="swatch" style={{ background: `var(${CATEGORY_VARS[item.kind]})` }} />
									{item.label}
								</span>
							))}
						</div>
					</div>
					<Minimap tracks={tracks} scale={scale} viewport={effectiveViewport} onViewportChange={setViewport} />
					<TimelineCanvas
						tracks={tracks}
						scale={scale}
						viewport={effectiveViewport}
						onViewportChange={setViewport}
						selected={selected}
						onSelect={selectAndOpen}
						matchIds={matchIds}
						collapsed={collapsed}
						onToggleCollapse={toggleCollapse}
						traceStart={traceStart}
						onLoadTrack={onLoadTrack}
						loadingTracks={loadingTracks}
						failedTracks={failedTracks}
						trackFailures={trackFailures}
						staleTracks={staleTracks}
						onRetryTrack={onRetryTrack}
						autoFocus={!embedded}
					/>
				</div>
			</Card>

			<SpanDrawer
				span={drawerOpen ? (selected?.span ?? null) : null}
				track={selected?.track ?? null}
				onClose={closeDrawer}
				onOpenChildTrack={openChildTrack}
				loadEntry={loadEntry}
				inline={embedded}
				onNavigate={onNavigate}
			/>

			{view === "full" && (
				<Card index={2} title="Transcript" description="Every span and marker in order; click to inspect" flush>
					<TranscriptList
						tracks={tracks}
						selection={selection}
						onSelect={openFromTranscript}
						search={search}
						matchIds={matchIds}
						traceStart={traceStart}
					/>
				</Card>
			)}
			{view === "full" && <AggregatesPanel toolStats={trace.summary.toolStats} index={3} />}
		</div>
	);
}

/** The fleet name of the machine a trace comes from, or null without a fleet. */
function useMachineName(id: string | undefined): string | null {
	const fleet = useFleet();
	return fleet?.find(machine => machine.id === id)?.name ?? null;
}
