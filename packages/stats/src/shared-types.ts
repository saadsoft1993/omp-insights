/**
 * Shared type definitions consumed by both the server-side stats code and the
 * standalone client bundle. Keep this file free of any imports from server-only
 * packages (e.g. `@oh-my-pi/pi-ai`, `bun:sqlite`) so the client can import it
 * without dragging server dependencies into its bundle.
 */

/**
 * Aggregated stats for a model or folder.
 */
export interface AggregatedStats {
	/** Total number of requests */
	totalRequests: number;
	/** Number of successful requests */
	successfulRequests: number;
	/** Number of failed requests */
	failedRequests: number;
	/** Error rate (0-1) */
	errorRate: number;
	/** Total input tokens */
	totalInputTokens: number;
	/** Total output tokens */
	totalOutputTokens: number;
	/** Total cache read tokens */
	totalCacheReadTokens: number;
	/** Total cache write tokens */
	totalCacheWriteTokens: number;
	/** Percentage of prompt input tokens served from cache (0-1). */
	cacheRate: number;
	/**
	 * Prompt-input cost saved relative to billing the same tokens uncached
	 * (0-1; negative when cache writes cost more than reads save).
	 */
	cacheSavings: number;
	/** Total cost */
	totalCost: number;
	/** Requests with token usage but no public-equivalent subscription price. */
	unpricedRequests: number;
	/** Total premium requests */
	totalPremiumRequests: number;
	/** Average duration in ms */
	avgDuration: number | null;
	/** Average TTFT in ms */
	avgTtft: number | null;
	/** Average tokens per second (output tokens / duration) */
	avgTokensPerSecond: number | null;
	/** Time range */
	firstTimestamp: number;
	lastTimestamp: number;
}

/**
 * Stats grouped by model.
 */
export interface ModelStats extends AggregatedStats {
	model: string;
	provider: string;
}

/**
 * Stats grouped by folder.
 */
export interface FolderStats extends AggregatedStats {
	folder: string;
}

/**
 * Time series data point.
 */
export interface TimeSeriesPoint {
	/** Bucket timestamp (start of hour/day) */
	timestamp: number;
	/** Request count */
	requests: number;
	/** Error count */
	errors: number;
	/** Total tokens */
	tokens: number;
	/** Total cost */
	cost: number;
}

/**
 * Model usage time series data point (daily buckets).
 */
export interface ModelTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Request count */
	requests: number;
}

/**
 * Model performance time series data point (daily buckets).
 */
export interface ModelPerformancePoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Request count */
	requests: number;
	/** Average TTFT in ms */
	avgTtft: number | null;
	/** Average tokens per second */
	avgTokensPerSecond: number | null;
}

/**
 * Cost time series data point (daily buckets).
 */
export interface CostTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Total cost for this bucket */
	cost: number;
	/** Requests excluded because no public-equivalent subscription price exists. */
	unpricedRequests: number;
	/** Cost breakdown */
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	/** Request count */
	requests: number;
}

/**
 * One local calendar day of aggregate request activity, for the `/usage`
 * activity heatmap in the coding-agent TUI.
 */
export interface DailyActivityPoint {
	/** Local calendar date, `YYYY-MM-DD`. */
	day: string;
	/** Summed API-equivalent cost for the day. */
	cost: number;
	/** Request count for the day. */
	requests: number;
	/** Total tokens (input + output + cache) for the day. */
	totalTokens: number;
}

/**
 * Overall dashboard stats.
 */
export interface DashboardStats {
	overall: AggregatedStats;
	byModel: ModelStats[];
	byFolder: FolderStats[];
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
	costSeries: CostTimeSeriesPoint[];
}

/**
 * Which agent produced a message, derived from its transcript file location
 * inside the session directory: the top-level `<project>/<file>.jsonl` is the
 * `main` agent, an `__advisor.jsonl` is the passive `advisor`, and any other
 * nested transcript is a task `subagent`.
 */
export type AgentType = "main" | "subagent" | "advisor";

/**
 * Token usage aggregated by {@link AgentType} over the active range. Token
 * columns are explicit so the dashboard's share denominator matches the
 * counts it renders (input + output + cache read + cache write).
 */
export interface AgentTypeStats {
	agentType: AgentType;
	/** Total number of requests */
	totalRequests: number;
	/** Total input tokens */
	totalInputTokens: number;
	/** Total output tokens */
	totalOutputTokens: number;
	/** Total cache read tokens */
	totalCacheReadTokens: number;
	/** Total cache write tokens */
	totalCacheWriteTokens: number;
	/** Total cost */
	totalCost: number;
}

/**
 * Frustration tallies over a set of user messages. Each message counts once,
 * classified by its cached judge verdict when one exists, else by the regex
 * behavior signals stored at ingest (see `frustration.ts` for both rules).
 */
export interface FrustrationCounts {
	/** User messages with non-empty prose. */
	messages: number;
	/** Messages whose prose has a cached judge verdict; the rest use regex fallback. */
	judged: number;
	/** Annoyed at anything (the assistant, tooling, other people, ...). */
	annoyed: number;
	/** Annoyed and aimed at the assistant. Subset of `annoyed`. */
	atAssistant: number;
	/** Aimed at the assistant and hostile/angry. Subset of `atAssistant`. */
	angry: number;
}

/**
 * Frustration tallies for one model version. Provider/spelling variants of the
 * same model (`claude-opus-4.6`, `anthropic/claude-opus-4-6`) merge under one
 * catalog identity.
 */
export interface FrustrationModelStats extends FrustrationCounts {
	/** Stable key: `class/family/revision` when classified, else the raw model id. */
	key: string;
	/** Display label, e.g. `opus 4.5`; the raw model id when unclassified. */
	label: string;
	/** Catalog identity class, e.g. `anthropic`; `unknown` when unclassified. */
	modelClass: string;
	/** Catalog family within the class, e.g. `opus`. */
	family: string | null;
	/** Canonical `major.minor.patch`, e.g. `4.5.0`. */
	revision: string | null;
	/** Raw model ids merged into this row. */
	models: string[];
	/** Earliest message timestamp (ms) in range. */
	firstSeen: number;
}

/** Lifecycle of the dashboard-host judge run that classifies unjudged messages. */
export type FrustrationJobState = "idle" | "running" | "done" | "cancelled" | "failed";

/** Progress of the (single, process-wide) frustration judge run. */
export interface FrustrationJobStatus {
	state: FrustrationJobState;
	/** Unique prose texts queued for judgment. */
	total: number;
	/** Texts judged successfully. */
	done: number;
	/** Texts that exhausted their retries. */
	failed: number;
	/** Accumulated USD cost of every judge attempt, retries included. */
	cost: number;
	/** Judge label (`provider/model`) of the run, when known. */
	judge: string | null;
	/** Why the run failed; null otherwise. */
	error: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	/** Judge requests the run currently keeps in flight (adapts to the judge's rate limits). */
	concurrency: number;
}

/** Payload of `GET /api/stats/frustration`. */
export interface FrustrationDashboardStats {
	overall: FrustrationCounts;
	/** Every model with messages in range, ordered by class, then revision, then family. */
	byModel: FrustrationModelStats[];
	/** Whether this dashboard host can run the judge (standalone `omp-stats` cannot). */
	judgeAvailable: boolean;
	job: FrustrationJobStatus;
}

/** Payload of `GET /api/frustration/estimate`: the pre-run cost quote shown before judging. */
export type FrustrationEstimate =
	| {
			available: true;
			/** Unique unjudged prose texts in range (identical messages share one verdict). */
			messages: number;
			/** Total prose characters sent. */
			chars: number;
			/** Estimated billed input tokens. */
			inputTokens: number;
			/** Estimated USD cost. */
			cost: number;
			/** Judge label (`provider/model`) the run will route to first. */
			judge: string;
	  }
	| { available: false; reason: string };

/** Token savings from a single source type. */
export interface GainSourceTotals {
	savedTokens: number;
	savedBytes: number;
	hits: number;
	/** originalBytes - savedBytes, when original is known */
	outputBytes: number;
	/** Total original bytes before compression, when known */
	originalBytes: number;
	/** savedBytes / originalBytes when both are known, else null */
	reductionPercent: number | null;
}

/** Per-source breakdown. */
export type GainSource = "snapcompact";

/** Time-series point for gain (daily bucket). */
export interface GainTimeSeriesPoint {
	date: string;
	snapcompact: number;
	total: number;
}

/** Complete gain dashboard payload. */
export interface GainDashboardStats {
	/** Aggregate across all sources for the active range. */
	overall: GainSourceTotals;
	/** Per-source breakdown. */
	bySource: Record<GainSource, GainSourceTotals>;
	/** Daily time series. */
	timeSeries: GainTimeSeriesPoint[];
	/** Active project filter (cwd prefix), or null for all projects. */
	project: string | null;
	/** All distinct projects seen in the data, for the selector. */
	projects: string[];
}

/**
 * A tool the Spotlight experiment shaped, by the name it was called with (`read`, `grep`, an MCP tool's name, …).
 * Every tool's results are shaped (`spotlight.experiment.tools`, default all); read, bash and eval have their own
 * paths in pi, every other tool goes through the generic one.
 */
export type SpotlightTool = string;

/** One tool's totals, for lists ordered by the tool's saving. */
export interface SpotlightToolRow extends SpotlightToolTotals {
	tool: SpotlightTool;
}

/**
 * How the model got back output a shortened result hid:
 * - `artifact`: a later call read or searched an artifact the shortened result named (`artifact://N`);
 * - `reread`: a later `read` of the same file whose selection overlaps the hidden lines, or the whole file again;
 * - `rerun`: a later call of the same tool repeating the shortened one: a bash command with a pipe, redirect or
 *   changed flags; any other tool with near-identical arguments (same tool, argument tokens' Jaccard ≥ 0.6).
 */
export type SpotlightRecoveryKind = "artifact" | "reread" | "rerun";

/** A ratio over sessions with its bootstrap 90% interval (`lo`/`hi` null under 3 sessions; `value` null with none). */
export interface SpotlightEstimate {
	value: number | null;
	lo: number | null;
	hi: number | null;
}

/**
 * Token totals of one tool's evaluated results. Savings are measured against the `plain` text pi would have shown
 * unshaped for the same call (its inline cap and read page), not against the full output shaping reads.
 */
export interface SpotlightToolTotals {
	/** Results the experiment evaluated. */
	results: number;
	/** Results it shortened. */
	shaped: number;
	/** The full output shaping read (a spilled bash output's whole artifact, a whole file up to 2 MiB). */
	inTokens: number;
	/**
	 * What `plain` would have shown: the trace's `plainTokens`, else (read, bash and eval traces written before pi
	 * recorded it) estimated from the inline cap.
	 */
	plainTokens: number;
	outTokens: number;
	/**
	 * Σ (plainTokens − outTokens) over shortened results; a cut that showed more than `plain` would have counts
	 * negative (see {@link SpotlightGross.widerThanPlain}).
	 */
	savedTokens: number;
	/** Σ (inTokens − outTokens): the saving against the full output, which overstates what the model was spared. */
	fullSavedTokens: number;
}

/** Strategy 1, gross savings: what the cuts removed. */
export interface SpotlightGross extends SpotlightToolTotals {
	/** savedTokens / (savedTokens + every tool-output token the model saw in the same sessions). */
	ofToolOutput: number | null;
	/** savedTokens / every token of the same sessions' requests (input + output + cache read + cache write). */
	ofSessionTokens: number | null;
	/** Every tool with an evaluated result in the range, the largest saving first. */
	byTool: SpotlightToolRow[];
	/** Shortened results whose `plainTokens` is estimated (journaled before pi recorded it). */
	estimatedPlain: number;
	/**
	 * Shortened results whose cut was wider than what `plain` would have shown (out > plain): a loss where the cut
	 * was shown, a saving of 0 where pi capped it at `plain`'s text (counted by the would-be cut).
	 */
	widerThanPlain: number;
}

/** Recovery totals of one kind. */
export interface SpotlightRecoveryTotals {
	events: number;
	/** Tokens of the recovery calls' results, which re-enter the context. */
	tokens: number;
	/** Requests that issued nothing but recovery calls. */
	turns: number;
	/** Provider cost of those requests. */
	turnsUsd: number;
	/**
	 * The recovery tokens carried through later requests, priced like {@link SpotlightCompounding.savedUsd}
	 * (excluding `turnsUsd`); Σ over kinds + clawback.turnsUsd = compounding.recoveryUsd.
	 */
	usd: number;
}

/** Strategy 2, clawback: what getting hidden output back cost. */
export interface SpotlightClawback extends SpotlightRecoveryTotals {
	/** Shortened results with hidden lines: the ones a recovery can follow. */
	withHidden: number;
	/** Of those, the results at least one recovery followed. */
	recovered: number;
	byKind: Record<SpotlightRecoveryKind, SpotlightRecoveryTotals>;
	/** gross.savedTokens − tokens. */
	netTokens: number;
}

/** Strategy 3, compounding: savings as every later request of the session would have re-read them. */
export interface SpotlightCompounding {
	/** Σ over shortened results of saved tokens × later requests of the session until a compaction. */
	avoidedTokens: number;
	/** Recovery tokens carried the same way: they undo what the cut avoided. */
	recoveredCarriedTokens: number;
	/** Prompt tokens the same sessions' requests processed (input + cache read + cache write). */
	promptTokens: number;
	/** (avoided − recoveredCarried) / (promptTokens + avoided − recoveredCarried). */
	avoidedShare: number | null;
	/** Avoided tokens priced at each later request's own cache-read rate, plus one cache write. */
	savedUsd: number;
	/** recoveredCarriedTokens priced the same way, plus clawback.turnsUsd. */
	recoveryUsd: number;
	/** Spotlight's own bill (`spotlight:shape` costUsd). */
	spotlightUsd: number;
	/** savedUsd − recoveryUsd − spotlightUsd. */
	netUsd: number;
	/** Wall time shaping added to tool calls (Σ `spotlight:shape` ms). */
	shapeMs: number;
}

/** Strategy 4: one bucket of the tool-output share of context, per session group. */
export interface SpotlightSharePoint {
	/** Bucket start (the range's bucket size, as every time series). */
	timestamp: number;
	/** `shaped`: an experiment session from its marker on; `outside`: everything else. */
	group: "shaped" | "outside";
	sessions: number;
	/** Tool-result tokens the model saw. */
	toolTokens: number;
	/** Everything that entered the context: tool results, assistant output, user prompts and the first request's prompt. */
	contextTokens: number;
}

/** One bucket of savings over time. */
export interface SpotlightBucket {
	timestamp: number;
	results: number;
	shaped: number;
	savedTokens: number;
	recoveries: number;
	recoveredTokens: number;
	netTokens: number;
	savedUsd: number;
	netUsd: number;
}

/** A recovery attributed to the latest shortened result it fetches from. */
export interface SpotlightRecovery {
	kind: SpotlightRecoveryKind;
	toolCallId: string;
	tool: string;
	/** The call's command, path or pattern, clipped to 200 chars. */
	target: string;
	timestamp: number;
	tokens: number;
	/** Tool calls between the shortened result and this one. */
	after: number;
	/** Its request issued nothing but recovery calls. */
	turn: boolean;
}

/** One evaluated result that changed the output, or would have (`holdout`). */
export interface SpotlightResultRow {
	sessionFile: string;
	toolCallId: string;
	timestamp: number;
	tool: SpotlightTool;
	/** Held out: the model saw the result unshaped; `savedTokens` is what the cut would have saved. */
	holdout: boolean;
	/** Command, path (with selector) or eval code head, clipped to 200 chars. */
	target: string;
	inTokens: number;
	outTokens: number;
	savedTokens: number;
	hiddenLines: number;
	steps: string[];
	spotlightUsd: number;
	shapeMs: number;
	/** What `plain` would have shown (see {@link SpotlightToolTotals.plainTokens}). */
	plainTokens: number;
	/** Cut by the no-score fallback rules because the score-free coin skipped Spotlight. */
	scoreFree: boolean;
	recoveries: SpotlightRecovery[];
	/** savedTokens − Σ recovery tokens. */
	netTokens: number;
}

/**
 * Who saw what for a result in the fetch-back comparison:
 * - `applied`: Spotlight shortened it and the model saw the shortened text;
 * - `holdout`: Spotlight would have shortened it, but the result was held out at random and the model saw it
 *   unshaped (the experiment's true counterfactual);
 * - `reference`: shaping left it unchanged (results of the same tool and sessions, standardized to the applied
 *   cuts' original-size mix), the stand-in until held-out results accumulate;
 * - `scoreFree`: shortened by the no-score fallback rules because a random coin skipped Spotlight
 *   (`spotlight.experiment.scoreFree`), the model saw the cut: against `applied`, what Spotlight's scores add;
 * - `gated`: a read pi's former edit gate (removed) kept whole, the model saw plain's page; only in transcripts
 *   journaled while the gate ran.
 * `applied` holds only cuts Spotlight scored (score-free cuts and cuts whose Spotlight calls failed are not in it).
 */
export type SpotlightCutGroup = "applied" | "holdout" | "reference" | "scoreFree" | "gated";

/**
 * Share of results the agent fetched more of within 12 calls, by one rule for every group: a later `read` of the
 * same path overlapping the result's own window (the whole file without a selector), a rerun (see
 * {@link SpotlightRecoveryKind}), or a read of an artifact the result named; not counted after an edit of that path
 * (reads) or any edit (reruns), nor from the same request.
 */
export interface SpotlightFetchBackCell {
	tool: SpotlightTool;
	group: SpotlightCutGroup;
	results: number;
	sessions: number;
	/** Session-clustered bootstrap over the group's results. */
	rate: SpotlightEstimate;
}

/** What the cuts of one tool earned, in tokens and dollars (applied cuts only; held-out results save nothing). */
export interface SpotlightCutEconomics {
	tool: SpotlightTool;
	cuts: number;
	savedTokens: number;
	recoveredTokens: number;
	/** Requests that did nothing but fetch back output these cuts hid. */
	extraTurns: number;
	savedUsd: number;
	/** Recovered tokens carried through later requests, priced like the savings. */
	recoveryUsd: number;
	/** Provider cost of the extra turns. */
	turnUsd: number;
	/** savedUsd − recoveryUsd − turnUsd − this cell's Spotlight bill. */
	netUsd: number;
	extraTurnsPer100Cuts: number;
	netUsdPer100Cuts: number;
}

/** Calls between a cut (or held-out result) and the first fetch-back after it. */
export type SpotlightGapBin = "1" | "2" | "3" | "4–6" | "7–12";

/** Fetch-backs per gap bin and tool, for applied and held-out results: every bin of each tool with at least one. */
export interface SpotlightGapCount {
	tool: SpotlightTool;
	gap: SpotlightGapBin;
	applied: number;
	holdout: number;
}

/** What shaping costs in time and reliability (all evaluated results, held-out ones included). */
export interface SpotlightOverhead {
	results: number;
	/** Wall time shaping added to a tool call. */
	shapeMsP50: number | null;
	shapeMsP90: number | null;
	/** Spotlight's own request time, over results whose calls all answered. */
	spotlightMsP50: number | null;
	spotlightMsP90: number | null;
	/** Results whose Spotlight calls failed or timed out (shaped by the no-score fallback). */
	failureRate: number | null;
	/** Wall time tool calls spent shaping results whose Spotlight calls failed (mostly the 5 s timeout per call). */
	failedWaitMs: number;
	spotlightUsd: number;
}

/**
 * The net once fetch-backs that would have happened anyway are taken out: held-out results (the model saw them
 * unshaped) show how much of a would-be cut's output the agent reads again regardless, per tool; only recoveries
 * beyond that baseline are the cut's cost. A tool's baseline is thin while it has fewer than `minHoldouts`.
 */
export interface SpotlightAdjustedTool {
	tool: SpotlightTool;
	/** Applied cuts (scored and score-free) and their recovered tokens. */
	cuts: number;
	recoveredTokens: number;
	/** Held-out would-be cuts the baseline is measured on. */
	holdouts: number;
	/** Recovered tokens per held-out would-be cut, over all the tool's holdouts (session-clustered bootstrap). */
	baselinePerCut: SpotlightEstimate;
	/** max(0, recovered − baseline per cut × cuts). */
	excessTokens: SpotlightEstimate;
}

/** Holdout-adjusted net savings (tokens, against the `plain` baseline). */
export interface SpotlightAdjusted {
	byTool: SpotlightAdjustedTool[];
	/** Σ tools' excess (bootstrapped jointly over sessions). */
	excessTokens: SpotlightEstimate;
	/** gross.savedTokens − excessTokens. */
	netTokens: SpotlightEstimate;
	/** compounding.savedUsd − recoveryUsd × (excess / recovered) − spotlightUsd. */
	netUsd: SpotlightEstimate;
	/** Holdouts per tool below which its baseline is too thin to trust (the UI marks the tool). */
	minHoldouts: number;
}

/**
 * Lines of a shaped read's original the agent needed later: lines a later `read` of the same file selected, and lines
 * a later `edit` of it changed (located by its Find text in the original), until the file's first edit or a later
 * whole-file read.
 */
export type SpotlightNeedSource = "reread" | "edit";

/**
 * How well a group's per-line choices match what the agent needed later, over shaped reads with at least one needed
 * line. Applied and score-free cuts are biased alike (the agent re-reads what it lacks), so compare them with each
 * other; held-out would-be cuts are the unbiased measure.
 */
export interface SpotlightRankingCell {
	group: "applied" | "holdout" | "scoreFree";
	results: number;
	neededLines: number;
	/** P(heat of a needed line > heat of an unneeded line of the same result), ties half; 0.5 is chance. Null for `scoreFree` (no heat). */
	auc: SpotlightEstimate;
	/** Needed-line rate among each result's hottest 10% of lines over its rate among all lines; 1 is no better than chance. */
	topLift: SpotlightEstimate;
	/** Share of needed lines the cut kept over the share of all lines it kept; 1 is a random cut of the same size. */
	keptLift: SpotlightEstimate;
}

/** Mean heat (0–9) of one line position over shaped results of at least 40 lines. */
export interface SpotlightHeatPosition {
	/** `line 1`, `lines 2–3`, then `0–10%` … `90–100%` of the output. */
	label: string;
	meanHeat: number;
	lines: number;
}

/** Ranking quality: does Spotlight keep the lines the agent comes back for? */
export interface SpotlightRanking {
	cells: SpotlightRankingCell[];
	position: SpotlightHeatPosition[];
	/** Results with needed lines, by how the need was observed (a result can count under both). */
	sources: Record<SpotlightNeedSource, number>;
}

/** Saved-token bins (against `plain`) the step economics split cuts by; a negative saving falls in `<250`. */
export type SpotlightSizeBin = "<250" | "250–1k" | "1k–4k" | "≥4k";

/** What one shaping step (or combination) earns at one cut size: applied cuts of one tool. */
export interface SpotlightStepCell {
	tool: SpotlightTool;
	/** The cut's shaping steps joined with `+` (`outline+window`); combinations under 10 cuts in the range fold into `other`. */
	steps: string;
	size: SpotlightSizeBin;
	cuts: number;
	fetchBackRate: SpotlightEstimate;
	/** Σ (plain − out), negative cuts (wider than `plain`) included. */
	savedTokens: number;
	recoveredTokens: number;
	/** max(0, recovered − Σ each cut's holdout baseline (its tool's)). */
	excessTokens: number;
	/** (saved − excess) / saved: the share of the saving that stays saved; null when the cell saved nothing (≤ 0). */
	keptShare: number | null;
}

/** What the experiment costs in agent time. */
export interface SpotlightTimeCost {
	/** Model time of the experiment sessions' requests (Σ request duration). */
	agentMs: number;
	/** Requests that did nothing but fetch back cut output, and their model time. */
	fetchBackTurns: number;
	fetchBackMs: number;
	/** Wall time tool calls spent shaping (Spotlight requests included). */
	shapeMs: number;
	/** (fetchBackMs + shapeMs) / agentMs. */
	share: number | null;
}

/** One tool's share of the tool output experiment sessions' models saw (chars ÷ 4). */
export interface SpotlightCoverageRow {
	tool: string;
	/** The experiment evaluated results of it in the range. */
	shaped: boolean;
	calls: number;
	tokens: number;
	share: number;
}

/**
 * Which transcripts the Spotlight dashboard measures (`GET /api/stats/spotlight?agent=`, default `all`): `main`
 * agents only, task `subagent`s only, or everything (advisors appear only under `all`). Every metric, the share
 * trend's `outside` group included, is filtered the same way.
 */
export type SpotlightAgentScope = "all" | "main" | "subagent";

/** An experiment session, for the context chart's picker. */
export interface SpotlightSessionSummary {
	sessionFile: string;
	title: string | null;
	folder: string;
	/** Which agent wrote the transcript (each subagent transcript is its own experiment session). */
	agentType: AgentType;
	/** The session's first Spotlight marker: activity before it (a resumed pre-experiment session) is not measured. */
	startedAt: number;
	requests: number;
	savedTokens: number;
	netUsd: number;
}

/**
 * Spotlight dashboard payload (`GET /api/stats/spotlight?range=&agent=`). Every experiment session shapes tool
 * output; held-out results within them are the counterfactual. Only activity at or after a session's Spotlight
 * marker is the experiment's; earlier activity of the same transcript counts as `outside` in the share trend and is
 * left out of every other metric.
 */
export interface SpotlightDashboardStats {
	/** Experiment sessions with activity in the range. */
	sessions: number;
	/** First Spotlight marker ever seen (not range-bound), for the trend's marker; null before the experiment. */
	experimentStart: number | null;
	gross: SpotlightGross;
	clawback: SpotlightClawback;
	compounding: SpotlightCompounding;
	series: SpotlightBucket[];
	share: SpotlightSharePoint[];
	/** Latest 60 shortened results, newest first. */
	recent: SpotlightResultRow[];
	/** Latest 30 experiment sessions in the range, newest first. */
	sessionList: SpotlightSessionSummary[];
	/** Held-out results in the range (would-be cuts the model saw unshaped). */
	holdouts: number;
	/** Score-free cuts in the range (shortened without Spotlight by the fallback rules). */
	scoreFree: number;
	adjusted: SpotlightAdjusted;
	ranking: SpotlightRanking;
	steps: SpotlightStepCell[];
	timeCost: SpotlightTimeCost;
	coverage: SpotlightCoverageRow[];
	fetchBack: SpotlightFetchBackCell[];
	economics: SpotlightCutEconomics[];
	gaps: SpotlightGapCount[];
	overhead: SpotlightOverhead;
}

/** One request of a session's context chart. */
export interface SpotlightContextPoint {
	timestamp: number;
	/** input + cache read + cache write of this request. */
	contextTokens: number;
	/** The context without shaping: contextTokens + net tokens saved so far (reset at a compaction). */
	withoutTokens: number;
	/** The context shrank sharply before this request (a compaction). */
	compacted: boolean;
	/** Tokens saved and recovered by results that landed since the previous request. */
	saved: number;
	recovered: number;
}

/** A session's context with and without shaping (`GET /api/stats/spotlight/session?file=`). */
export interface SpotlightSessionContext {
	session: SpotlightSessionSummary;
	points: SpotlightContextPoint[];
}

/**
 * Aggregated usage for a single tool over the active range.
 *
 * Token/cost fields are the *real* provider usage of the assistant turns that
 * invoked the tool, split evenly across that turn's tool calls so the numbers
 * stay additive (a turn with 3 calls contributes a third of its usage to each
 * tool). Payload fields (`argsChars`/`resultChars`) are raw character counts
 * of the serialized arguments and the text fed back into context — a size
 * proxy, not provider-counted tokens.
 */
export interface ToolUsageStats {
	/** Tool name as recorded on the tool call. */
	tool: string;
	/** Number of tool calls. */
	calls: number;
	/** Calls whose result came back with `isError`. */
	errors: number;
	/** Serialized tool-call argument characters. */
	argsChars: number;
	/** Text characters of tool results fed back into context. */
	resultChars: number;
	/** Total provider tokens of invoking turns, attributed per call share. */
	totalTokensShare: number;
	/** Output tokens of invoking turns, attributed per call share. */
	outputTokensShare: number;
	/** Cost (USD) of invoking turns, attributed per call share. */
	costShare: number;
	/** Share of unpriced subscription requests attributed to this tool. */
	unpricedRequestsShare: number;
	/** Unix ms of the most recent call in range. */
	lastUsed: number;
}

/** Per-(tool, model) breakdown with the same attribution as {@link ToolUsageStats}. */
export interface ToolModelStats extends ToolUsageStats {
	model: string;
	provider: string;
}

/** Tool-call time-series point (one bucket per tool). */
export interface ToolTimeSeriesPoint {
	timestamp: number;
	tool: string;
	calls: number;
	errors: number;
}

/** Complete tools dashboard payload. */
export interface ToolDashboardStats {
	byTool: ToolUsageStats[];
	byToolModel: ToolModelStats[];
	series: ToolTimeSeriesPoint[];
}

/**
 * Aggregated request/token/cost totals for one provider over the active range.
 */
export interface ProviderAggregate {
	provider: string;
	totalRequests: number;
	failedRequests: number;
	/** Distinct models used through this provider in the range. */
	models: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	/** Uncached input + cache reads + cache writes + output. */
	totalTokens: number;
	totalCost: number;
	/** Requests excluded because no public-equivalent subscription price exists. */
	unpricedRequests: number;
	totalPremiumRequests: number;
	avgTokensPerSecond: number | null;
}

/**
 * Token burn attributed to one local hour-of-day (0-23) for one provider.
 * Powers the "peak burn hours" histogram.
 */
export interface ProviderHourlyPoint {
	provider: string;
	/** Local hour of day, 0-23. */
	hour: number;
	totalTokens: number;
	outputTokens: number;
	requests: number;
}

/** Provider token/cost time-series point (bucketed like the model series). */
export interface ProviderTimeSeriesPoint {
	timestamp: number;
	provider: string;
	totalTokens: number;
	cost: number;
	/** Requests excluded because no public-equivalent subscription price exists. */
	unpricedRequests: number;
	requests: number;
}

/** One recorded usage-limit snapshot for an (account, window) series. */
export interface UsageWindowPoint {
	timestamp: number;
	/** Used fraction 0..1 (>1 = overage) when the provider reported one. */
	usedFraction: number | null;
	exhausted: boolean;
}

/**
 * Utilization history for one (account, limit window) pair of a provider,
 * sourced from the auth store's recorded usage-limit snapshots.
 */
export interface UsageWindowSeries {
	provider: string;
	accountKey: string;
	/** Email/account id when known, else the stable account key. */
	accountLabel: string;
	/** Groups the same limit window across accounts: the limit id, or quota family + window for positional Codex slots. */
	windowKey: string;
	/** Human label of the limit (distinguishes same-duration windows). */
	windowLabel: string;
	points: UsageWindowPoint[];
}

/**
 * Derived subscription insight for one provider limit window across all
 * accounts: how much of the window was consumed, what one window is worth in
 * tokens, and how many accounts peak demand would have needed.
 */
export interface ProviderWindowInsight {
	provider: string;
	/** Groups the same limit window across accounts: the limit id, or quota family + window for positional Codex slots. */
	windowKey: string;
	/** Human label of the limit (distinguishes same-duration windows). */
	windowLabel: string;
	/** Accounts with at least one snapshot for this window in range. */
	accounts: number;
	/** Window resets observed (drops in used fraction). */
	cycles: number;
	/**
	 * Subscription-window equivalents consumed in range: sum of positive
	 * used-fraction deltas across accounts (1.0 = one full window burned).
	 */
	fractionConsumed: number;
	/**
	 * Estimated tokens one full window buys: provider tokens burned in range
	 * divided by {@link fractionConsumed}. Null when too little of the window
	 * was consumed to extrapolate.
	 */
	estTokensPerWindow: number | null;
	/** Peak of sum-across-accounts used fraction at any sampled instant. */
	peakConcurrentFraction: number;
	/**
	 * Accounts needed to keep peak demand under 90% of fleet capacity:
	 * max(1, ceil(peakConcurrentFraction / 0.9)).
	 */
	idealAccounts: number;
	/** Transitions into an exhausted state observed in range. */
	exhaustedEvents: number;
}

/** Ingest state of the dashboard host's background session sync. */
export interface LiveSyncStatus {
	phase: "idle" | "syncing" | "error";
	/** Files completed in the running sync (0 when not yet known). */
	current: number;
	/** Files in the running sync's work set (0 while listing → indeterminate). */
	total: number;
	/** Rows inserted by the running (or last) sync. */
	processed: number;
	/** Wall-clock time the last sync finished, if any. */
	lastSyncedAt: number | null;
	/** Failure message of the last sync when `phase` is `"error"`. */
	error: string | null;
}

/**
 * Payload of every `GET /api/events` server-sent event (and `GET /api/status`).
 * `version` increases whenever stored stats may have changed, so clients
 * revalidate their queries when it moves.
 */
export interface LiveStatus {
	version: number;
	sync: LiveSyncStatus;
	/** Hours whose rollups are still being (re)built; ranges covering them may be incomplete. */
	indexingHours: number;
}

/** Providers dashboard payload: local request stats only (fast, DB-backed). */
export interface ProviderDashboardStats {
	providers: ProviderAggregate[];
	hourly: ProviderHourlyPoint[];
	series: ProviderTimeSeriesPoint[];
}

/**
 * Subscription-window payload (`GET /api/stats/provider-windows`). Snapshots
 * may come from the auth broker over the network, so it is fetched separately
 * from {@link ProviderDashboardStats}. `usageSeries` only carries the
 * requested provider's series (empty without a provider) — all of them can be
 * thousands of series.
 */
export interface ProviderWindowStats {
	windowInsights: ProviderWindowInsight[];
	usageSeries: UsageWindowSeries[];
}

/**
 * Account state, by precedence: `needs_login` (every stored credential of the
 * account is disabled), `blocked` (an enabled credential sits behind an active
 * rate-limit block), `active` (a request in the last 24 hours, whatever the
 * selected range), `idle` (requests, none in the last 24 hours), `never` (no
 * request recorded).
 */
export type AccountStatus = "needs_login" | "blocked" | "active" | "idle" | "never";

/** Active rate-limit block on one of an account's credentials. */
export interface AccountBlock {
	/** Block scope as stored (e.g. `tier:fable`); empty = every model. */
	scope: string;
	/** Epoch ms the block lifts. */
	until: number;
}

/** Latest recorded usage-limit reading for one quota window of an account. */
export interface AccountQuotaWindow {
	limitId: string;
	label: string;
	windowLabel: string | null;
	/** Used fraction 0..1 (>1 = overage) when the provider reported one. */
	usedFraction: number | null;
	status: string | null;
	/** Epoch ms the window resets, when reported. */
	resetsAt: number | null;
	/** Epoch ms the reading was fetched. */
	recordedAt: number;
}

/**
 * One provider account: every stored credential sharing a provider and an
 * identity (same email and organization) merged into one row.
 */
export interface AccountStats {
	/** Stable row key: provider plus identity. */
	key: string;
	provider: string;
	/** Email when known, else the stored identity key, else the credential id. */
	label: string;
	email: string | null;
	orgId: string | null;
	/** `oauth` or `api_key`; null for a credential id missing from the agent database. */
	credentialType: string | null;
	/** `auth_credentials` row ids merged into this account. */
	credentialIds: number[];
	status: AccountStatus;
	/** Why the newest disabled credential was disabled, when the account needs a login. */
	disabledCause: string | null;
	blocks: AccountBlock[];
	/** Requests served in the selected range. */
	requests: number;
	failedRequests: number;
	/** Uncached input + cache reads + cache writes + output, in range. */
	totalTokens: number;
	totalCost: number;
	/** Requests excluded from cost because no public-equivalent price exists. */
	unpricedRequests: number;
	/** Epoch ms of the newest request ever served, regardless of range. */
	lastUsed: number | null;
	/** Share of the provider's attributed requests in range (0..1). */
	requestShare: number;
	/** Share of the provider's attributed tokens in range (0..1). */
	tokenShare: number;
	/** Latest reading per quota window, newest-recorded first. */
	quotas: AccountQuotaWindow[];
	/** Requests served in the last {@link ProviderRouting.recent} window, regardless of range. */
	recentRequests: number;
	/** Share of the provider's attributed requests in that window (0..1). */
	recentShare: number;
	/** Served at least one request in that window. */
	servingNow: boolean;
	/** Served the first request of the provider's most recent new main session in the new-session window (see {@link ProviderRouting.newSessions}). */
	servedLatestNewSession: boolean;
}

/**
 * Traffic of one provider that no stored credential can be credited with:
 * environment API keys, gateways, background `model_usage` calls, and
 * sessions written before turns recorded their credential.
 */
export interface UnattributedUsage {
	provider: string;
	requests: number;
	failedRequests: number;
	totalTokens: number;
	totalCost: number;
	unpricedRequests: number;
	/** Epoch ms of the newest unattributed request in range. */
	lastUsed: number | null;
}

/** One account's slice of a provider's recent attributed requests. */
export interface RoutingRequestShare {
	accountKey: string;
	requests: number;
	/** Share of the provider's attributed requests in the window (0..1). */
	share: number;
}

/** New main sessions whose first request one account served. */
export interface RoutingSessionCount {
	accountKey: string;
	sessions: number;
}

/**
 * Latest observed change in which account served new main sessions' first
 * request, within the range. Historical observation; not the balancer's
 * current choice.
 */
export interface AssignmentChange {
	fromAccountKey: string;
	toAccountKey: string;
	/** Epoch ms of the first request of the first new session observed on `toAccountKey`. */
	at: number;
}

/**
 * Routing observations for one provider. The trailing request split is the
 * only measurement of current routing: omp keeps a session on one credential
 * but can rotate it to another at any time, so where traffic goes now is only
 * visible in recent requests. New-session assignments record which account
 * served the first request of recent main sessions; rotations can move those
 * sessions afterwards, so they are historical observations, not the balancer's
 * current choice.
 */
export interface ProviderRouting {
	provider: string;
	/** Attributed requests in the trailing window, per account, busiest first. */
	recent: { windowMs: number; requests: number; accounts: RoutingRequestShare[] };
	/**
	 * New main sessions (main-agent transcripts; subagents follow their parent's
	 * credential) whose first attributed request falls in the trailing window,
	 * counted per account observed serving that first request. `lastAccount` is
	 * that account for the most recent one; `lastAccountSince` is the first
	 * request of the uninterrupted run of new sessions first served there (at
	 * the earliest, the start of the range or of the window, whichever is
	 * earlier). `latest` is the most recent new session in that same span,
	 * inside the window or not. Rotations can move any of these sessions to
	 * another account after its first request.
	 */
	newSessions: {
		windowMs: number;
		sessions: number;
		accounts: RoutingSessionCount[];
		lastAccount: string | null;
		lastAccountSince: number | null;
		latest: { accountKey: string; at: number } | null;
	};
	/** Latest observed change in which account served new main sessions' first request, within the range. Historical observation; not the balancer's current choice. */
	lastAssignmentChange: AssignmentChange | null;
}

/**
 * One provider's requests in range, split into those tied to a stored account
 * and those that are not. Counted by the request's own provider from the same
 * rollups as the Providers page, so `requests` equals that page's total and
 * `accountRequests + unattributedRequests === requests`.
 */
export interface ProviderAccountTotals {
	provider: string;
	requests: number;
	accountRequests: number;
	unattributedRequests: number;
}

/** Accounts dashboard payload (`GET /api/stats/accounts`). */
export interface AccountDashboardStats {
	accounts: AccountStats[];
	unattributed: UnattributedUsage[];
	/** Every provider with requests in range, busiest first. */
	providerTotals: ProviderAccountTotals[];
	/** Per provider with attributed traffic in the routing windows or an assignment change in range. */
	routing: ProviderRouting[];
}

/** One stacked series of the account traffic chart. */
export interface AccountFlowSeries {
	key: string;
	provider: string;
	label: string;
	/** The {@link AccountStats.key} the series belongs to; null for the provider's unattributed traffic. */
	accountKey: string | null;
}

/** One series' traffic in one bucket. */
export interface AccountFlowPoint {
	timestamp: number;
	key: string;
	requests: number;
	/** Uncached input + cache reads + cache writes + output. */
	tokens: number;
}

/** Account traffic over time (`GET /api/stats/accounts/flow`), bucketed like the provider time series. */
export interface AccountFlowStats {
	series: AccountFlowSeries[];
	points: AccountFlowPoint[];
}

/**
 * What the live view can honestly say about a target from the logs. Requests
 * are written when they complete, so `quiet` means no completed request in the
 * last minute; one may still be in flight. `rate_limited` means an active block
 * in agent.db is holding traffic back; a nearly used quota is only a warning.
 */
export type LiveTargetState = "active" | "quiet" | "rate_limited" | "needs_login";

/**
 * A subagent's state, from its transcript: `running` (still writing, no exit),
 * `idle` (ended its turn with a plain answer; can be messaged again),
 * `finished` (exited after its last entry), `stopped` (no exit recorded and
 * silent for 15 minutes).
 */
export type LiveAgentStatus = "running" | "idle" | "finished" | "stopped";

/** The last tool a transcript started: its name and omp's short intent text (never the arguments). */
export interface LiveToolActivity {
	name: string | null;
	intent: string | null;
	/** Epoch ms it started. */
	at: number | null;
}

/** A subagent (or advisor) running inside a session. */
export interface LiveAgent {
	/** Its transcript path. */
	id: string;
	/** Path inside the session folder without `.jsonl` (`Builder`, `Parent/Child`); advisors read `Advisor`. */
	name: string;
	status: LiveAgentStatus;
	doing: LiveToolActivity | null;
	/** Epoch ms of its newest transcript entry. */
	last: number | null;
	/** Completed requests in the last minute. */
	rpm: number;
	/** Completed requests in the last five minutes. */
	requests: number;
	/** Targets its requests went to in the last five minutes. */
	targets: string[];
}

/**
 * A session that completed a request in the last five minutes or has
 * subagents worth listing; its subagent transcripts' requests count as it.
 */
export interface LiveSession {
	/** Root session transcript path. */
	id: string;
	/** Session title when the transcript has one, else the project label. */
	name: string;
	/** Project label: the session's working directory name, else its sessions folder. */
	project: string;
	/** Epoch ms the session started, from its file name. */
	started: number | null;
	/** Completed requests in the last minute, its subagents' included. */
	rpm: number;
	/** Epoch ms of its newest completed request. */
	last: number | null;
	/** The last tool the session's own transcript started. */
	doing: LiveToolActivity | null;
	/** Running first, then waiting, stopped and finished; each newest first. */
	agents: LiveAgent[];
	agentsRunning: number;
	/**
	 * Sent a request in the last minute or has a subagent running; a session
	 * whose own turn ended while its subagents work is still working.
	 */
	working: boolean;
}

/**
 * Requests of the five-minute window that recorded no account, split by kind:
 * housekeeping calls journaled as `model_usage` (titles, memory, judges and
 * the like, by purpose) versus ordinary assistant turns, for example turns
 * made with an API key.
 */
export interface LiveRequestBreakdown {
	housekeeping: number;
	turns: number;
	/** Housekeeping requests per `model_usage` purpose, most first. */
	purposes: Array<{ purpose: string; requests: number }>;
}

/** Where requests go: a stored account, a configured API-key gateway, or a provider's requests with no account recorded. */
export interface LiveTarget {
	key: string;
	provider: string;
	kind: "account" | "gateway" | "no_account";
	label: string;
	/**
	 * Accounts: the email when the label is something else, else the credential ids behind it. Gateways:
	 * `API-key gateway · host`. No account recorded: that the session log names no account.
	 */
	meta: string | null;
	state: LiveTargetState;
	/** A current quota window is at 95% or more. A warning only, not a state. */
	quotaWarning: boolean;
	/** Completed requests in the last minute. */
	rpm: number;
	/** Tokens of those requests (uncached input + cache reads + cache writes + output). */
	tpm: number;
	/** Epoch ms of the newest completed request, any age. */
	last: number | null;
	/** Latest quota readings whose window has not reset. */
	quotas: AccountQuotaWindow[];
	/** For gateways and requests with no account recorded; null for accounts. */
	breakdown: LiveRequestBreakdown | null;
}

/** Traffic from one session to one target in the five-minute window. */
export interface LiveEdge {
	from: string;
	to: string;
	/** Completed requests in the last minute; 0 = traffic in the last five minutes only. */
	rpm: number;
	last: number;
}

/** One completed request in the five-minute window. */
export interface LiveRequest {
	ts: number;
	session: string;
	/** The subagent that made it, when not the session's own transcript. */
	agent: string | null;
	target: string;
	model: string;
	tokens: number;
}

/** Live traffic payload (`GET /api/stats/live`). */
export interface LiveTrafficStats {
	now: number;
	/** Rates (`rpm`, `tpm`) count this trailing window. */
	windowMs: number;
	/** Sessions, edges and requests cover this trailing window. */
	flowWindowMs: number;
	sessions: LiveSession[];
	targets: LiveTarget[];
	edges: LiveEdge[];
	/** Newest first, at most 25. */
	recent: LiveRequest[];
}

/**
 * One row of the Traces session list: a root session with every child
 * transcript (task subagents, advisors) folded in.
 */
export interface SessionSummary {
	/** Absolute root session file path (trace key). */
	file: string;
	/** Decoded project path (e.g. `/work/pi`). */
	folder: string;
	title: string | null;
	/** ms epoch of first activity. */
	startedAt: number;
	/** ms epoch of last activity, children included. */
	endedAt: number;
	/** Assistant messages, children folded in. */
	requests: number;
	toolCalls: number;
	/** Child transcript count. */
	subagents: number;
	totalTokens: number;
	costTotal: number;
	/** Requests whose zero cost is unknown spend (scheduled card, no timestamp). */
	unpricedRequests: number;
	models: string[];
}

export type TraceSpanKind = "turn" | "model" | "tool" | "subagent" | "background";

/** One rendered block on a trace track lane. */
export interface TraceSpan {
	/** `${track.id}:${entryId}` (+`:${toolCallId}` for tool spans); stable across refetch. */
	id: string;
	kind: TraceSpanKind;
	/** ms epoch. */
	start: number;
	/** ms epoch, >= start. */
	end: number;
	/** ≤80 chars: tool name / model id / user-text head / agent name. */
	label: string;
	/** ≤160 chars: args projection / result head / task text. */
	detail?: string;
	/** Journal entry id for /api/session/entry. */
	entryId?: string;
	toolCallId?: string;
	model?: string;
	/** usage.totalTokens (model spans). */
	tokens?: number;
	/** usage.cost.total (model spans). */
	cost?: number;
	/** Time to first token, ms offset from start. */
	ttft?: number;
	isError?: boolean;
	/** End synthesized (no result / pending at session exit). */
	unterminated?: boolean;
	/** Set on `subagent` spans whose child transcript became a track. */
	childTrackId?: string;
}

/** Point event drawn on a track header row. */
export interface TraceMarker {
	/** ms epoch. */
	time: number;
	kind: "compaction" | "model_change" | "mode_change" | "reset" | "session_exit";
	/** e.g. "compaction 142k→38k", model id, mode name, exit kind. */
	label: string;
}

/** One transcript (main session, subagent, advisor) in a trace. */
export interface TraceTrack {
	/** "main" or slash-joined child key: "Scout1", "Scout1/Nested2", "__advisor". */
	id: string;
	parentId: string | null;
	label: string;
	/** session_init.agent when recorded. */
	agent: string | null;
	/** session_init.resolvedModel ?? first assistant model. */
	model: string | null;
	/** Absolute transcript path for live entry fetch, or the embedded snapshot key. */
	file: string;
	/** Sorted by start. */
	spans: TraceSpan[];
	markers: TraceMarker[];
}

/** Per-tool duration aggregate across all tracks of one trace. */
export interface TraceToolStat {
	tool: string;
	calls: number;
	errors: number;
	totalMs: number;
	maxMs: number;
}

/** Headline aggregates for one trace. */
export interface TraceSummary {
	wallMs: number;
	/** Summed model-span duration on the main track. */
	modelMs: number;
	/** Summed tool-span duration on the main track. */
	toolMs: number;
	/** Wall time not covered by any span on any track. */
	idleMs: number;
	turns: number;
	requests: number;
	toolCalls: number;
	subagents: number;
	totalTokens: number;
	costTotal: number;
	/** Model requests whose zero cost is unknown spend, not free usage. */
	unpricedRequests: number;
	/** Sorted totalMs desc. */
	toolStats: TraceToolStat[];
}

/** Complete span tree for one session, `/api/session/trace` payload. */
export interface SessionTrace {
	file: string;
	title: string | null;
	cwd: string | null;
	startedAt: number;
	endedAt: number;
	/** Root transcript mtime, or recorded root activity/header time for offline snapshots. */
	mtimeMs: number;
	/**
	 * Conditional-request fingerprint `"<rootMs>:<childHighMs>"` (see
	 * traceFingerprintForEtag): the server ETag is built from this, so a
	 * subagent-only append changes the ETag even when the root is untouched.
	 * Offline snapshots use "snapshot" and do not support HTTP revalidation.
	 */
	etag: string;
	/** DFS order, main first. */
	tracks: TraceTrack[];
	summary: TraceSummary;
}
