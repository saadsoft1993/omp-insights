import { BellRing, Copy } from "lucide-react";
import { useState } from "react";
import { getHubAlerts, sendHubTestAlert } from "../data/hub";
import { useQuery } from "../data/query";
import { Card, EmptyState, PageHeader, QueryView, TableSkeleton } from "../ui";
import { ago, Help, type Notice, NoticeLine } from "./hub-common";

export interface AlertsRouteProps {
	active: boolean;
}

export function AlertsRoute({ active }: AlertsRouteProps) {
	const alerts = useQuery(["hub-alerts"], ({ signal }) => getHubAlerts(signal), { enabled: active, pollMs: 30_000 });
	const [notice, setNotice] = useState<Notice | null>(null);
	const [sending, setSending] = useState(false);

	const copy = async (topic: string) => {
		try {
			await navigator.clipboard.writeText(topic);
			setNotice({ tone: "ok", text: "Topic copied." });
		} catch {
			setNotice({ tone: "bad", text: "Could not copy here; select the topic above and copy it by hand." });
		}
	};

	const test = async () => {
		setSending(true);
		setNotice(null);
		try {
			await sendHubTestAlert();
			setNotice({ tone: "ok", text: "Test alert sent: it should reach your phone in a few seconds." });
			alerts.refetch();
		} catch (error) {
			setNotice({ tone: "bad", text: `Could not send: ${error instanceof Error ? error.message : String(error)}` });
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="page">
			<PageHeader
				title="Phone alerts"
				description="A push to your phone when a session needs you or finishes a long turn."
			/>
			<Help summary="How do alerts work?">
				<p>
					The hub watches the sessions and sends a push notification through ntfy when one needs your answer, or
					finishes a turn that ran over a minute. Alerts carry only the project folder and its state: no prompt
					text, no transcript, no links.
				</p>
				<p>
					On the phone, install the <b>ntfy</b> app and subscribe to the topic below (server{" "}
					<code>https://ntfy.sh</code>), then click <b>Send test alert</b>.
				</p>
			</Help>
			<QueryView query={alerts} skeleton={<TableSkeleton rows={2} />}>
				{a =>
					!a.enabled || !a.topic ? (
						<Card>
							<EmptyState
								title="Alerts are off"
								hint={<>Set the hub's ntfy topic in its configuration and restart the hub.</>}
							/>
						</Card>
					) : (
						<Card
							title="ntfy topic"
							description="Keep it private: anyone who knows the name can read the alerts."
						>
							<p className="hub-topic mono">{`${a.server.replace(/\/$/, "")}/${a.topic}`}</p>
							<p className="micro">
								{a.sent} sent since the hub started{a.last_sent_at ? `, last ${ago(a.last_sent_at)}` : ""}.
							</p>
							{a.last_error && (
								<p className="hub-notice" data-tone="bad">
									{a.last_error}
								</p>
							)}
							<div className="hub-actions">
								<button type="button" className="btn" onClick={() => copy(a.topic ?? "")}>
									<Copy size={14} /> Copy topic
								</button>
								<button type="button" className="btn" data-variant="accent" disabled={sending} onClick={test}>
									<BellRing size={14} /> {sending ? "Sending…" : "Send test alert"}
								</button>
							</div>
							<NoticeLine notice={notice} />
						</Card>
					)
				}
			</QueryView>
		</div>
	);
}
