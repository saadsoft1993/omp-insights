import { Gauge } from "lucide-react";
import { ALL_MACHINES, concreteMachine, useSelectedMachine } from "../app/machine";
import { fleetQueryState, useFleetQuery } from "../data/fleet-query";
import { getHubQuota, type HubQuota, type HubQuotaAccount } from "../data/hub";
import { accountProblem, noBackupNotes, providerName, quotaHeadline, span, windowView } from "../data/hub-view";
import { parseHash } from "../data/useHashRoute";
import { useQuery } from "../data/query";
import { Badge, ErrorState } from "../ui";
import "./hub.css";
import { plainHubReason } from "./ops-common";

const REFRESH_MS = 30_000;

function AccountRow({ account, now }: { account: HubQuotaAccount; now: number }) {
	const problem = accountProblem(account);
	return (
		<li className="quota-account">
			<div className="quota-who">
				<span className="quota-provider">{providerName(account.provider)}</span>
				<span className="quota-label">{account.label}</span>
				{problem && <Badge tone={problem.tone}>{problem.label}</Badge>}
			</div>
			{account.windows.length === 0 ? (
				<p className="quota-window" data-tone="neutral">
					<span className="quota-window-name">quota</span>
					<span className="quota-percent">unknown</span>
					<span className="quota-detail">no reading in local usage records</span>
				</p>
			) : (
				account.windows.map(w => {
					const view = windowView(w, now);
					return (
						<p key={w.label ?? "window"} className="quota-window" data-tone={view.tone} data-state={w.state}>
							<span className="quota-window-name">{w.label ?? "window"}</span>
							{w.state === "ok" && w.usedPercent !== null && (
								<span className="quota-bar" aria-hidden="true">
									<span style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
								</span>
							)}
							<span className="quota-percent">{view.percent}</span>
							<span className="quota-detail">{view.detail}</span>
						</p>
					);
				})
			)}
		</li>
	);
}

function QuotaBody({ data, refreshError }: { data: HubQuota; refreshError?: string | null }) {
	// Ages and countdowns run on the real clock, not on when the hub collected the readings.
	const now = Date.now();
	const notes = noBackupNotes(data);
	return (
		<>
			{data.cacheStale && (
				<p className="hub-warn quota-note" role="status">
					The hub has not refreshed these readings{data.cacheAgeMs ? ` for ${span(data.cacheAgeMs)}` : ""}; they
					may be out of date.
				</p>
			)}
			{refreshError && (
				<p className="hub-warn quota-note" role="alert" title={refreshError}>
					Could not refresh quota: {plainHubReason(refreshError, { refreshing: true })}. Showing the last answer.
				</p>
			)}
			<ul className="quota-list">
				{data.accounts.map(a => (
					<AccountRow key={`${a.provider}:${a.label}`} account={a} now={now} />
				))}
			</ul>
			{notes.map(note => (
				<p key={note} className="micro quota-note">
					{note}
				</p>
			))}
			<p className="micro quota-note">From {data.source}; refreshes every 30 seconds.</p>
			<a
				className="btn"
				data-size="sm"
				data-variant="ghost"
				href={`#/accounts?range=${parseHash(window.location?.hash ?? "").range}`}
			>
				Details →
			</a>
		</>
	);
}

/** The card itself: nothing to say with no accounts, so it stays out of the way. */
export function QuotaView({
	data,
	wide,
	refreshError,
}: {
	data: HubQuota;
	wide: boolean;
	refreshError?: string | null;
}) {
	if (data.accounts.length === 0) return null;
	const title = (
		<span className="row">
			<Gauge size={14} /> Quota
		</span>
	);
	if (wide) {
		return (
			<section className="quota-card" aria-label="Quota">
				<h2 className="quota-title">{title}</h2>
				<QuotaBody data={data} refreshError={refreshError} />
			</section>
		);
	}
	return (
		<details className="quota-card" aria-label="Quota">
			<summary className="quota-summary">
				{title}
				<span className="quota-headline">{quotaHeadline(data)}</span>
			</summary>
			<QuotaBody data={data} refreshError={refreshError} />
		</details>
	);
}

/**
 * How full each account's quota windows are, from the hub's local usage records. On a wide screen (iPad) it is
 * a compact card above the sessions; on a phone it is one collapsible row. Nothing shows before the first answer
 * or when the request fails: the sessions list matters more.
 */
export function QuotaCard({ active, wide }: { active: boolean; wide: boolean }) {
	const all = useSelectedMachine() === ALL_MACHINES;
	const quota = useQuery(["hub-quota"], ({ signal }) => getHubQuota(concreteMachine() ?? "", signal), {
		enabled: active && !all,
		pollMs: REFRESH_MS,
	});
	const fleetQuota = useFleetQuery(
		["hub-quota"],
		async (machine, signal) => {
			const data = await getHubQuota(machine, signal);
			if (!Array.isArray(data.accounts)) throw new Error("Invalid quota response");
			return { machine, data };
		},
		answers => answers,
		{ enabled: active && all, pollMs: REFRESH_MS },
	);
	if (all) {
		// Every machine definitively failed (a held machine is reconnecting, not failed): one line with Try again,
		// which refreshes the machine list first.
		if (fleetQueryState(fleetQuota) === "failed")
			return (
				<ErrorState
					error="No machine's quota answered."
					detail={fleetQuota.machines.map(m => `${m.name}: ${m.error}`).join("; ")}
					onRetry={() => fleetQuota.refetch()}
					retryLabel="Try again"
					busy={fleetQuota.checking}
				/>
			);
		return (
			<div className="quota-fleet">
				{fleetQuota.machines.map(machine => {
					const answer = fleetQuota.data?.find(item => item.machine === machine.id);
					return (
						<section key={machine.id} className="quota-fleet-machine" aria-label={`${machine.name} quota`}>
							<h2>{machine.name}</h2>
							{answer ? (
								<QuotaView data={answer.data} wide={wide} refreshError={machine.error} />
							) : machine.lastKnown ? (
								<p role="status">Reconnecting; quota shows once {machine.name} answers.</p>
							) : machine.error ? (
								<p role="status" title={machine.error}>
									Quota unavailable: {plainHubReason(machine.error, { refreshing: true })}.
								</p>
							) : (
								<p>Loading quota…</p>
							)}
						</section>
					);
				})}
			</div>
		);
	}
	return quota.data ? <QuotaView data={quota.data} wide={wide} refreshError={quota.error?.message ?? null} /> : null;
}
