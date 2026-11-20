import { PageActiveContext } from "./data/page-active";
import { useCallback, useRef, useState } from "react";
import { type DashboardSection } from "./app/nav";
import { PairScreen } from "./app/PairScreen";
import { Shell } from "./app/Shell";
import { LiveProvider } from "./data/live";
import { ALL_MACHINES, useFleetReady } from "./app/machine";
import { useUnpaired } from "./data/pairing";
import { useHashRoute } from "./data/useHashRoute";
import {
	AccountsRoute,
	AlertsRoute,
	CostsRoute,
	DevicesRoute,
	ErrorsRoute,
	FrustrationRoute,
	GainRoute,
	JobsRoute,
	LiveRoute,
	MachinesRoute,
	ModelFlowRoute,
	ModelsRoute,
	OverviewRoute,
	ProjectsRoute,
	RelayRoute,
	RequestsRoute,
	SessionsRoute,
	SpotlightRoute,
	ToolsRoute,
	TracesRoute,
} from "./routes";
import { HistoryRoute } from "./routes/HistoryRoute";
import DeliveryRoute from "./routes/delivery";
import AwsRoute from "./routes/aws";
import SmsRoute from "./routes/sms";
import { RequestDrawer } from "./ui/RequestDrawer";

export default function App() {
	// The hub in front answers 401 until this browser is paired; the event stream closes with the dashboard.
	const unpaired = useUnpaired();
	// Fleet mode decides every request's path prefix: find out before anything is fetched.
	const fleetReady = useFleetReady();
	if (unpaired) return <PairScreen />;
	// Usually a blink; on a busy hub it can take a few seconds, so say what is happening.
	if (!fleetReady)
		return (
			<p className="app-connecting" role="status">
				Connecting to the hub…
			</p>
		);
	return (
		<LiveProvider>
			<Dashboard />
		</LiveProvider>
	);
}

export function Dashboard() {
	const {
		section,
		setSection,
		range,
		setRange,
		session,
		setSession,
		hubSession,
		setHubSession,
		sub,
		params,
		setSub,
		setParams,
		setControl,
		openTranscript,
		machine,
		traceMachine,
	} = useHashRoute();
	const [selectedRequest, setSelectedRequest] = useState<{ id: number; machine?: string } | null>(null);
	const openRequest = useCallback((id: number, machine?: string) => setSelectedRequest({ id, machine }), []);
	// Stable identity so the drawer's effects don't tear down on every render.
	const closeDrawer = useCallback(() => setSelectedRequest(null), []);

	// Visited pages stay mounted (hidden) so revisits are instant and keep their
	// scroll-independent UI state; only the active page fetches (`active`).
	const mounted = useRef(new Set<DashboardSection>());
	mounted.current.add(section);

	const render = (target: DashboardSection) => {
		const active = target === section;
		switch (target) {
			case "sessions":
				return <SessionsRoute active={active} selected={hubSession} onSelect={setHubSession} />;
			case "history":
				return <HistoryRoute active={active} range={range} onTranscript={openTranscript} onLive={setHubSession} />;
			case "machines":
				return <MachinesRoute active={active} />;
			case "relay":
				return <RelayRoute active={active} />;
			case "alerts":
				return <AlertsRoute active={active} />;
			case "delivery":
				return (
					<DeliveryRoute
						active={active}
						sub={sub}
						params={params}
						setSub={setSub}
						setParams={setParams}
						setControl={setControl}
					/>
				);
			case "aws":
				return (
					<AwsRoute
						active={active}
						sub={sub}
						params={params}
						setSub={setSub}
						setParams={setParams}
						setControl={setControl}
					/>
				);
			case "sms":
				return (
					<SmsRoute
						active={active}
						sub={sub}
						params={params}
						setSub={setSub}
						setParams={setParams}
						setControl={setControl}
					/>
				);
			case "jobs":
				return <JobsRoute active={active} />;
			case "flow":
				return <ModelFlowRoute active={active} />;
			case "devices":
				return <DevicesRoute active={active} />;
			case "overview":
				return <OverviewRoute active={active} range={range} onRequestClick={openRequest} />;
			case "requests":
				return <RequestsRoute active={active} range={range} onRequestClick={openRequest} />;
			case "errors":
				return <ErrorsRoute active={active} range={range} onRequestClick={openRequest} />;
			case "traces":
				return (
					<TracesRoute
						active={active}
						session={session}
						sessionMachine={traceMachine ?? (machine === ALL_MACHINES ? undefined : machine)}
						onOpenSession={setSession}
					/>
				);
			case "models":
				return <ModelsRoute active={active} range={range} />;
			case "accounts":
				return <AccountsRoute active={active} range={range} />;
			case "live":
				return <LiveRoute active={active} />;
			case "costs":
				return <CostsRoute active={active} range={range} />;
			case "tools":
				return <ToolsRoute active={active} range={range} />;
			case "frustration":
				return <FrustrationRoute active={active} range={range} />;
			case "projects":
				return <ProjectsRoute active={active} range={range} />;
			case "gain":
				return <GainRoute active={active} range={range} />;
			case "spotlight":
				return <SpotlightRoute active={active} range={range} />;
		}
	};

	return (
		<>
			<Shell section={section} onSectionChange={setSection} range={range} onRangeChange={setRange}>
				{[...mounted.current].map(target => (
					<div key={target} hidden={target !== section}>
						<PageActiveContext.Provider value={target === section}>{render(target)}</PageActiveContext.Provider>
					</div>
				))}
			</Shell>
			<RequestDrawer id={selectedRequest?.id ?? null} machine={selectedRequest?.machine} onClose={closeDrawer} />
		</>
	);
}
