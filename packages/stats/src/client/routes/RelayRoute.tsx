import { getHubRelay } from "../data/hub";
import { useQuery } from "../data/query";
import { Badge, Card, ErrorState, PageHeader, QueryView, Stat, StatGrid, TableSkeleton } from "../ui";
import { Help } from "./hub-common";

export interface RelayRouteProps {
	active: boolean;
}

const REFRESH_MS = 15_000;

function uptime(seconds: number | null | undefined): string {
	if (seconds == null) return "–";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 172_800) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

export function RelayRoute({ active }: RelayRouteProps) {
	const relay = useQuery(["hub-relay"], ({ signal }) => getHubRelay(signal), { enabled: active, pollMs: REFRESH_MS });

	return (
		<div className="page">
			<PageHeader
				title="Collab relay"
				description="The small server on this Mac that connects your browser to omp sessions. Refreshes every 15 seconds."
				actions={
					relay.data && <Badge tone={relay.data.ok ? "ok" : "bad"}>{relay.data.ok ? "Running" : "Problem"}</Badge>
				}
			/>
			<Help summary="What is this?">
				<p>
					Sessions reach the relay on the Mac itself; browsers reach it only through Tailscale, and only if paired
					with this dashboard. Unpairing a browser in the hub also cuts its open session tabs within about 10
					seconds.
				</p>
				<p>
					<b>Rooms</b> are sessions currently sharing; <b>viewers</b> are open browser tabs. If it shows "not
					reachable", sessions keep working at the Mac but you can't open them from here; launchd restarts it on
					its own, and open tabs reconnect after a restart.
				</p>
			</Help>
			<QueryView query={relay} skeleton={<TableSkeleton rows={2} />}>
				{data => (
					<>
						{data.error && <ErrorState error={data.error} onRetry={relay.refetch} />}
						{data.rooms != null && (
							<Card>
								<StatGrid>
									<Stat label="Rooms" value={data.rooms} hint="Sessions sharing now" />
									<Stat label="Viewers" value={data.guests ?? 0} hint="Open browser tabs" />
									<Stat label="Up" value={uptime(data.uptime_s)} hint="Since the relay last started" />
									<Stat
										label="Web build"
										value={data.build ? data.build.split(" ")[0] : "–"}
										hint="collab-web the relay serves"
										size="sm"
									/>
								</StatGrid>
							</Card>
						)}
					</>
				)}
			</QueryView>
		</div>
	);
}
