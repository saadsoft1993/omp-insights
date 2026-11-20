import { Inbox, RotateCw, TriangleAlert } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useFleet, useSelectedMachine } from "../app/machine";
import { AllMachinesFailed } from "../app/MachineBanner";
import { statsFailureSentence } from "../app/stats-reasons";
import { FleetFailedError } from "../data/fleet-query";

export function EmptyState({ title = "Nothing here yet", hint }: { title?: ReactNode; hint?: ReactNode }) {
	return (
		<div className="empty">
			<Inbox size={20} />
			<div className="empty-title">{title}</div>
			{hint !== undefined && <div className="empty-hint">{hint}</div>}
		</div>
	);
}

export function ErrorState({
	error,
	onRetry,
	detail,
	retryLabel = "Retry",
	busy = false,
}: {
	error: ReactNode | Error;
	onRetry?: () => void;
	/** The raw reason behind a reworded message, shown only as a tooltip. */
	detail?: string | null;
	retryLabel?: string;
	/** A retry is in progress: the button says "Checking…" and waits. */
	busy?: boolean;
}) {
	return (
		<div className="error-state" role="alert">
			<TriangleAlert size={15} />
			<span className="error-state-message" title={detail ? `Details: ${detail}` : undefined}>
				{error instanceof Error ? error.message : error}
			</span>
			{onRetry && (
				<button
					type="button"
					className="btn"
					data-size="sm"
					data-variant="ghost"
					disabled={busy}
					onClick={() => onRetry()}
				>
					<RotateCw size={13} className={busy ? "spin" : undefined} /> {busy ? "Checking…" : retryLabel}
				</button>
			)}
		</div>
	);
}

export function Skeleton({
	width = "100%",
	height = 14,
	style,
}: {
	width?: number | string;
	height?: number | string;
	style?: CSSProperties;
}) {
	return <div className="skeleton" style={{ width, height, ...style }} />;
}

/** Placeholder block matching a chart's footprint. */
export function ChartSkeleton({ height = 220 }: { height?: number }) {
	return <Skeleton height={height} style={{ borderRadius: 8 }} />;
}

/** Placeholder rows matching a table's footprint. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 16px 16px" }}>
			{Array.from({ length: rows }, (_, i) => (
				<Skeleton key={i} height={16} width={`${92 - ((i * 13) % 30)}%`} />
			))}
		</div>
	);
}

export interface QueryViewProps<T> {
	query: {
		data: T | null;
		error: Error | null;
		loading: boolean;
		refetch: () => void;
		checking?: boolean;
		/** It asks again by itself, so its error may say "retrying". */
		polling?: boolean;
	};
	/** Rendered on first load. */
	skeleton: ReactNode;
	/** Treat loaded data as empty (renders `empty`). */
	isEmpty?: (data: T) => boolean;
	empty?: ReactNode;
	children: (data: T) => ReactNode;
	/** Whose numbers these are, for the error sentence ("Ada Server's stats didn't answer in time…"). */
	machine?: string | null;
	/** A page-specific error message; replaces the standard wording (the raw reason stays in the tooltip). */
	errorMessage?: ReactNode | ((reason: string) => ReactNode);
	/**
	 * Another QueryView on the page shows this query's error: say it once per failed query, not once per area.
	 * Without data this area renders nothing; with data it renders the data alone.
	 */
	hideError?: boolean;
}

/**
 * Standard load/error/empty switch for one `useQuery` result. Errors with
 * data already on screen keep the data and show the error above it.
 * Errors read in plain words ({@link statsFailureSentence}); the raw reason is only in the tooltip.
 */
export function QueryView<T>({
	query,
	skeleton,
	isEmpty,
	empty,
	children,
	machine,
	errorMessage,
	hideError = false,
}: QueryViewProps<T>) {
	const fleet = useFleet();
	const selected = useSelectedMachine();
	// One machine picked: its name makes the sentence say whose stats failed.
	const name = machine ?? fleet?.find(item => item.id === selected)?.name ?? null;
	// Under All machines with every machine failed: one plain line; the banner above gives each machine's reason.
	const fleetFailed = query.error instanceof FleetFailedError;
	const error =
		query.error && !hideError ? (
			<ErrorState
				error={
					query.error instanceof FleetFailedError ? (
						<AllMachinesFailed machines={query.error.machines} />
					) : errorMessage === undefined ? (
						statsFailureSentence(name, query.error.message, { refreshing: query.polling ?? false })
					) : typeof errorMessage === "function" ? (
						errorMessage(query.error.message)
					) : (
						errorMessage
					)
				}
				detail={fleetFailed ? null : query.error.message || null}
				retryLabel="Try again"
				busy={query.checking ?? false}
				onRetry={query.refetch}
			/>
		) : null;
	if (query.data === null) return <>{query.error ? error : skeleton}</>;
	return (
		<>
			{error}
			{isEmpty?.(query.data) ? (empty ?? <EmptyState />) : children(query.data)}
		</>
	);
}
