import {
	Activity,
	History,
	BellRing,
	CalendarClock,
	CircleAlert,
	Coins,
	Cpu,
	FolderGit2,
	ChartNoAxesCombined,
	CloudCog,
	School,
	Frown,
	LayoutGrid,
	type LucideIcon,
	MonitorSmartphone,
	Radio,
	ScanSearch,
	Server,
	Sparkles,
	SquareChartGantt,
	SquareTerminal,
	UserRound,
	Waypoints,
	Workflow,
	Wrench,
} from "lucide-react";

export const SECTION_IDS = [
	"delivery",
	"aws",
	"sms",
	"sessions",
	"history",
	"relay",
	"alerts",
	"jobs",
	"flow",
	"devices",
	"machines",
	"overview",
	"models",
	"accounts",
	"live",
	"costs",
	"requests",
	"errors",
	"traces",
	"tools",
	"frustration",
	"projects",
	"gain",
	"spotlight",
] as const;

export type DashboardSection = (typeof SECTION_IDS)[number];

export interface NavItem {
	id: DashboardSection;
	label: string;
	icon: LucideIcon;
	/** Second key of the `g <key>` jump shortcut. */
	hotkey?: string;
	visible?: (ctx: NavVisibility) => boolean;
	/** Only listed when the hub fronts several machines. */
	fleetOnly?: boolean;
	hubOnly?: boolean;
}

export interface NavVisibility {
	reports: ReadonlySet<string>;
}

/** Pages about one machine (what the header's machine selector picks); the rest is about the hub itself. */
export const PER_MACHINE_SECTIONS: ReadonlySet<DashboardSection> = new Set<DashboardSection>([
	// The session list itself spans every machine; its quota card follows the selection.
	"sessions",
	"history",
	"relay",
	"jobs",
	"alerts",
	"devices",
	"flow",
	"overview",
	"models",
	"accounts",
	"live",
	"costs",
	"requests",
	"errors",
	"traces",
	"tools",
	"frustration",
	"projects",
	"gain",
	"spotlight",
]);

export interface NavGroup {
	heading: string;
	items: readonly NavItem[];
}

/** Sidebar structure; the order here is the order on screen. */
export const NAV: readonly NavGroup[] = [
	{
		heading: "Control center",
		items: [
			{
				id: "delivery",
				label: "Delivery analytics",
				icon: ChartNoAxesCombined,
				hubOnly: true,
				visible: ctx => ctx.reports.has("delivery"),
			},
			{ id: "aws", label: "AWS costs", icon: CloudCog, hubOnly: true, visible: ctx => ctx.reports.has("aws") },
			{ id: "sms", label: "SMS", icon: School, hubOnly: true, visible: ctx => ctx.reports.has("sms") },
		],
	},
	{
		// Served by the omp hub that fronts this dashboard (`/api/hub/*`).
		heading: "Control",
		items: [
			{ id: "sessions", label: "Sessions", icon: SquareTerminal, hotkey: "n", hubOnly: true },
			{ id: "history", label: "Old sessions", icon: History, hotkey: "h", hubOnly: true },
		],
	},
	{
		heading: "Settings",
		items: [
			{ id: "relay", label: "Relay", icon: Waypoints, hotkey: "y", hubOnly: true },
			{ id: "alerts", label: "Alerts", icon: BellRing, hotkey: "b", hubOnly: true },
			{ id: "jobs", label: "Jobs", icon: CalendarClock, hotkey: "w", hubOnly: true },
			{ id: "devices", label: "Devices", icon: MonitorSmartphone, hotkey: "d", hubOnly: true },
			{ id: "flow", label: "Model flow", icon: Workflow, hotkey: "q", hubOnly: true },
			{ id: "machines", label: "Machines", icon: Server, hotkey: "i", fleetOnly: true, hubOnly: true },
		],
	},
	{
		heading: "Usage",
		items: [
			{ id: "overview", label: "Overview", icon: LayoutGrid, hotkey: "o" },
			{ id: "models", label: "Models", icon: Cpu, hotkey: "m" },
			{ id: "accounts", label: "Accounts & quota", icon: UserRound, hotkey: "a" },
			{ id: "live", label: "Live", icon: Radio, hotkey: "v" },
			{ id: "costs", label: "Costs", icon: Coins, hotkey: "c" },
		],
	},
	{
		heading: "Activity",
		items: [
			{ id: "requests", label: "Requests", icon: Activity, hotkey: "r" },
			{ id: "errors", label: "Errors", icon: CircleAlert, hotkey: "e" },
			{ id: "traces", label: "Traces", icon: SquareChartGantt, hotkey: "t" },
		],
	},
	{
		heading: "Insights",
		items: [
			{ id: "tools", label: "Tools", icon: Wrench, hotkey: "l" },
			{ id: "frustration", label: "Frustration", icon: Frown, hotkey: "f" },
			{ id: "projects", label: "Projects", icon: FolderGit2, hotkey: "j" },
			{ id: "gain", label: "Gain", icon: Sparkles, hotkey: "g" },
			{ id: "spotlight", label: "Spotlight", icon: ScanSearch, hotkey: "s" },
		],
	},
];

export const NAV_ITEMS: readonly NavItem[] = NAV.flatMap(group => group.items);

export const SECTIONS: readonly DashboardSection[] = NAV_ITEMS.map(item => item.id);

export function shortcutSection(
	key: string,
	fleet: boolean,
	hubPresent = true,
	visibility: NavVisibility = { reports: new Set() },
): DashboardSection | undefined {
	return NAV_ITEMS.find(
		item =>
			item.hotkey === key &&
			(fleet || !item.fleetOnly) &&
			(hubPresent || !item.hubOnly) &&
			(!item.visible || item.visible(visibility)),
	)?.id;
}

export function navItem(section: DashboardSection): NavItem {
	return NAV_ITEMS.find(item => item.id === section) ?? NAV_ITEMS[0];
}
