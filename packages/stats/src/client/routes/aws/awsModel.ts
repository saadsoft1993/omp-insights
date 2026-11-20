export type Periods = Record<string, Record<string, number>>;
export interface AwsCosts {
	monthly: Periods;
	daily: Periods;
	usage: Periods;
	usage_week: Periods;
	region: Periods;
	billed_monthly?: Record<string, number>;
	billed_daily?: Record<string, number>;
	credits_monthly?: Periods;
	credits_daily?: Periods;
	refunds_monthly?: Periods;
	refunds_daily?: Periods;
	tags?: Record<string, Periods>;
	tags_daily?: Record<string, Periods>;
	tag_service?: Record<string, Periods>;
	tag_aliases?: Record<string, Record<string, string>>;
	forecast_rest_of_month: number | null;
	estimated_days?: string[];
	unknown_record_types?: string[];
}
export interface AwsResource {
	account: string;
	status: string;
	kind: string;
	name: string;
	id: string;
	project?: string;
	region: string;
	monthly: number | null;
	recoverable?: number;
	evidence?: string;
	action?: string;
	state?: string;
	since?: string;
	ri?: { covered: number };
}
export interface Grant {
	description?: string;
	type?: string;
	remaining: number;
	initial: number;
	end: string;
	status?: string;
	estimated_remaining?: number;
	exhausted?: string;
}
export interface Reservation {
	count: number;
	type: string;
	kind: string;
	platform: string;
	offering: string;
	region: string;
	hourly: number;
	utilisation: number;
	unused_monthly: number;
	end: string;
}
export interface AwsAccount {
	key: string;
	label: string;
	account_id: string;
	note?: string;
	costs: AwsCosts;
	resources: AwsResource[];
	reservations?: Reservation[];
	credit_grants?: Grant[];
	credit_grants_error?: string;
	stale?: string | null;
	collected_at?: string;
}
export interface AwsData {
	today: string;
	generated: string;
	lookback_days: number;
	accounts: AwsAccount[];
}
export interface ServiceRow {
	acc: string;
	svc: string;
	last: number;
	prev: number;
	mtd: number;
	spark: number[];
	rr: number;
	total: number;
	change: number | null;
	trend?: string;
}
export type PivotGroup = "Project" | "Client" | "Environment" | "Service";
export interface PivotOptions {
	group: PivotGroup;
	split: string;
	months: number;
}
export interface PivotRow {
	g: string;
	per: number[];
	tot: number;
}
const SHORT: Record<string, string> = {
	"Amazon Elastic Compute Cloud - Compute": "EC2 instances",
	"EC2 - Other": "EC2 other (EBS, NAT, IPs)",
	"Amazon Relational Database Service": "RDS databases",
	"Amazon Virtual Private Cloud": "VPC (public IPs, NAT)",
	AmazonCloudWatch: "CloudWatch",
	"Amazon Elastic Load Balancing": "Load balancers",
	"Amazon ElastiCache": "ElastiCache",
	"Amazon Elastic Container Service": "ECS (Fargate)",
	"Amazon Simple Storage Service": "S3",
	"Amazon EC2 Container Registry (ECR)": "ECR",
	"Amazon Route 53": "Route 53",
	"AWS Key Management Service": "KMS",
	"Amazon GuardDuty": "GuardDuty",
	"Amazon Lightsail": "Lightsail",
	"AWS Config": "AWS Config",
	"AWS Cost Explorer": "Cost Explorer",
	"Amazon CloudFront": "CloudFront",
	"AWS Secrets Manager": "Secrets Manager",
	"AWS WAF": "WAF",
	"AWS CloudTrail": "CloudTrail",
	"Amazon Simple Notification Service": "SNS",
	"Amazon Simple Queue Service": "SQS",
	"AWS Lambda": "Lambda",
	"Amazon Elastic File System": "EFS",
	"AWS Systems Manager": "Systems Manager",
};
export const shortName = (s: string) => SHORT[s] || s.replace(/^Amazon |^AWS /, "");
export const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
export const money = (n: number, dp?: number) => {
	if (Math.abs(n) < 0.005) n = 0;
	const d = dp ?? (Math.abs(n) < 100 ? 2 : 0);
	return (
		(n < 0 ? "−$" : "$") +
		Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
	);
};
export function addDays(s: string, n: number) {
	const d = new Date(s + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
export function addMonths(s: string, n: number) {
	const d = new Date(s + "T00:00:00Z");
	d.setUTCMonth(d.getUTCMonth() + n);
	return d.toISOString().slice(0, 10);
}
export const recoverable = (r: AwsResource) => r.recoverable ?? r.monthly ?? 0;
export function awsModel(data: AwsData, view = "all") {
	const accounts = data.accounts.filter(a => view === "all" || view === "both" || a.key === view);
	const cur = data.today.slice(0, 7) + "-01",
		last = addMonths(cur, -1),
		prev = addMonths(cur, -2);
	const months = Array.from({ length: 13 }, (_, i) => addMonths(cur, i - 12));
	const rrDays = Array.from({ length: 7 }, (_, i) => addDays(data.today, i - 8));
	const sumBy = (field: keyof AwsCosts, period: string) => {
		const out: Record<string, number> = {};
		for (const a of accounts)
			for (const [k, v] of Object.entries(((a.costs[field] as Periods | undefined) || {})[period] || {}))
				out[k] = (out[k] || 0) + v;
		return out;
	};
	const adjustment = (a: AwsAccount, gran: "monthly" | "daily", p: string) =>
		total((a.costs[`credits_${gran}`] || {})[p] || {}) + total((a.costs[`refunds_${gran}`] || {})[p] || {});
	const billed = (gran: "monthly" | "daily", p: string) =>
		accounts.reduce(
			(t, a) => t + ((a.costs[`billed_${gran}`] || {})[p] ?? total(a.costs[gran][p] || {}) + adjustment(a, gran, p)),
			0,
		);
	const rows: ServiceRow[] = [];
	for (const a of accounts) {
		const c = a.costs;
		const names = new Set(Object.values(c.monthly).flatMap(m => Object.keys(m)));
		const mine: ServiceRow[] = [];
		for (const svc of names) {
			const spark = months.map(m => c.monthly[m]?.[svc] || 0),
				l = c.monthly[last]?.[svc] || 0,
				p = c.monthly[prev]?.[svc] || 0,
				mtd = c.monthly[cur]?.[svc] || 0;
			const rr = svc === "Tax" ? 0 : (rrDays.reduce((t, d) => t + (c.daily[d]?.[svc] || 0), 0) / 7) * 30,
				sum = spark.reduce((t, v) => t + v, 0),
				change = l > 0.5 ? (rr - l) / l : null,
				before = spark.slice(0, 10).reduce((t, v) => t + v, 0);
			const trend =
				rr < 0.05 && mtd < 0.05 && (l > 1 || before > 1)
					? "gone"
					: l < 0.05 && p < 0.05 && rr > 0.5
						? "new"
						: change !== null && change > 0.2 && rr - l > 5
							? "up"
							: change !== null && change < -0.2 && l - rr > 5
								? "down"
								: undefined;
			mine.push({ acc: a.key, svc, last: l, prev: p, mtd, spark, rr, total: sum, change, trend });
		}
		const tax = mine.find(r => r.svc === "Tax");
		if (tax) {
			const m = c.monthly[last] || {},
				rest = total(m) - (m.Tax || 0);
			tax.rr = (rest > 1 ? (m.Tax || 0) / rest : 0) * mine.reduce((t, r) => t + (r.svc === "Tax" ? 0 : r.rr), 0);
			tax.change = tax.last > 0.5 ? (tax.rr - tax.last) / tax.last : null;
			if (tax.change !== null && tax.change > 0.2 && tax.rr - tax.last > 5) tax.trend = "up";
			else if (tax.change !== null && tax.change < -0.2 && tax.last - tax.rr > 5) tax.trend = "down";
		}
		rows.push(...mine.filter(r => r.total >= 0.5));
	}
	rows.sort((a, b) => b.rr - a.rr || b.last - a.last || b.total - a.total);
	const resources = accounts.flatMap(a => a.resources || []),
		waste = resources
			.filter(r => r.status !== "live" && (r.monthly == null || recoverable(r) >= 0.05))
			.sort((a, b) => recoverable(b) - recoverable(a));
	const grants = accounts.flatMap(a =>
		(a.credit_grants || [])
			.filter(g => g.remaining >= 0.01 && (g.status || "ENABLED") === "ENABLED" && (g.end || "9") >= data.today)
			.map(g => ({ ...g, account: a.key })),
	);
	const mtd = total(sumBy("monthly", cur)),
		lastTotal = total(sumBy("monthly", last)),
		rr = rows.reduce((t, r) => t + r.rr, 0),
		forecast = accounts.every(a => a.costs.forecast_rest_of_month != null)
			? Math.max(
					accounts.reduce((t, a) => t + (a.costs.forecast_rest_of_month || 0), 0),
					mtd,
				)
			: null;
	const creditLeft = grants.reduce((t, g) => t + g.remaining, 0),
		coveredRate = rows.filter(r => grants.some(g => g.account === r.acc)).reduce((t, r) => t + r.rr, 0);
	return {
		data,
		accounts,
		cur,
		last,
		prev,
		months,
		rrDays,
		sumBy,
		adjustment,
		billed,
		rows,
		resources,
		waste,
		grants,
		mtd,
		lastTotal,
		rr,
		forecast,
		creditLeft,
		coveredRate,
		monthsLeft: coveredRate > 1 ? Math.floor(creditLeft / coveredRate) : null,
		wasteTotal: waste.reduce((t, r) => t + recoverable(r), 0),
		growing: rows.filter(r => r.trend === "up" || r.trend === "new").sort((a, b) => b.rr - b.last - (a.rr - a.last)),
	};
}
export type AwsModel = ReturnType<typeof awsModel>;
export interface AwsCallout {
	title: string;
	text: string;
	warning: boolean;
}
export function callouts(model: AwsModel, view: string): AwsCallout[] {
	const notes: AwsCallout[] = [];
	const add = (title: string, text: string, warning = false) => notes.push({ title, text, warning });
	for (const a of model.accounts) {
		if (a.stale)
			add(
				`Stale data — ${a.label}`,
				`${a.stale}. Figures for this account are from ${a.collected_at || "an earlier run"}.`,
				true,
			);
		const unknown = a.costs.unknown_record_types || [];
		if (unknown.length)
			add(
				`Unrecognised charge types — ${a.label}`,
				`${unknown.join(", ")} are being counted as usage. If they are discounts or credits, the service figures are netted; add them to collect.py.`,
				true,
			);
	}
	if (model.grants.length && model.coveredRate > 1 && model.creditLeft < model.coveredRate * 3)
		add(
			"Credits running low",
			`${money(model.creditLeft, 0)} of credit left covers about ${Math.floor(model.creditLeft / model.coveredRate)} months at the current run-rate. After that, usage is billed.`,
			true,
		);
	for (const a of model.accounts) {
		const usage = total(a.costs.monthly[model.last] || {}),
			billed = a.costs.billed_monthly?.[model.cur];
		if (usage > 1 && -model.adjustment(a, "monthly", model.last) / usage > 0.9 && billed != null && billed > 5)
			add(
				`Credits no longer covering ${a.label}`,
				`Credits covered last month in full, but ${money(billed)} has been billed this month.`,
				true,
			);
	}
	const live = model.rows.filter(r => r.svc !== "Tax");
	if (live.length) {
		const b = live[0],
			label = model.data.accounts.find(a => a.key === b.acc)?.label;
		add(
			"Biggest cost",
			`${shortName(b.svc)}${view === "all" || view === "both" ? ` on ${label}` : ""} — ${money(b.rr, 0)}/mo, ${Math.round((b.rr / (model.rr || 1)) * 100)}% of the run-rate. Open it in section 06 to see what inside it charges.`,
		);
	}
	if (model.growing.length)
		add(
			"Growing",
			model.growing
				.slice(0, 3)
				.map(
					r =>
						`${shortName(r.svc)}${view === "all" || view === "both" ? ` (${model.data.accounts.find(a => a.key === r.acc)?.label})` : ""} ${money(r.last, 0)} → ${money(r.rr, 0)}`,
				)
				.join(" · "),
			true,
		);
	if (model.waste.length)
		add(
			"Dead or underused",
			`${model.waste.length} dead or idle resources; removing them would save about ${money(model.wasteTotal, 0)}/mo (Reserved Instance fees are paid either way and are not counted). See section 08.`,
			true,
		);
	return notes;
}
export function pivot(model: AwsModel, opts: PivotOptions) {
	const data: Record<string, Record<string, Record<string, number>>> = {},
		missing: string[] = [];
	const add = (g: string, s: string, m: string, v: number) => {
		const a = (data[g] ||= {}),
			b = (a[s] ||= {});
		b[m] = (b[m] || 0) + v;
	};
	for (const a of model.accounts) {
		const c = a.costs;
		if (opts.group === "Service" && !["Project", "Client", "Environment"].includes(opts.split)) {
			for (const [m, values] of Object.entries(c.monthly))
				for (const [s, v] of Object.entries(values))
					add(shortName(s), opts.split === "account" ? a.label : "", m, v);
			continue;
		}
		const tag = opts.group === "Service" ? opts.split : opts.group;
		let src = c.tag_service?.[tag];
		if (!src) {
			missing.push(a.label);
			src = {};
			for (const [m, values] of Object.entries(c.monthly)) {
				src[m] = {};
				for (const [s, v] of Object.entries(values)) src[m][`(untagged)||${s}`] = v;
			}
		}
		for (const [m, values] of Object.entries(src))
			for (const [key, v] of Object.entries(values)) {
				const [val, svc] = key.split("||");
				if (opts.group === "Service") add(shortName(svc), val, m, v);
				else add(val, opts.split === "service" ? shortName(svc) : opts.split === "account" ? a.label : "", m, v);
			}
	}
	const months = model.months.slice(13 - opts.months),
		rows: PivotRow[] = Object.keys(data)
			.map(g => {
				const per = months.map(m => Object.values(data[g]).reduce((t, x) => t + (x[m] || 0), 0));
				return { g, per, tot: per.reduce((t, v) => t + v, 0) };
			})
			.filter(r => Math.abs(r.tot) >= 0.01)
			.sort((a, b) => b.tot - a.tot);
	const normalized: Record<string, string[]> = {};
	if (opts.group !== "Service")
		for (const r of rows) (normalized[r.g.toLowerCase().replace(/[^a-z0-9]/g, "")] ||= []).push(r.g);
	const aliases = Object.assign(
		{},
		...model.accounts.map(a => a.costs.tag_aliases?.[opts.group === "Service" ? opts.split : opts.group] || {}),
	);
	const totals = months.map((_, i) => rows.reduce((t, r) => t + r.per[i], 0));
	return {
		data,
		months,
		rows,
		missing,
		aliases,
		duplicates: Object.values(normalized).filter(a => a.length > 1),
		totals,
	};
}
export function pivotCsv(p: ReturnType<typeof pivot>, opts: PivotOptions) {
	const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
	const split =
		opts.split === "service"
			? "Service"
			: opts.split === "account"
				? "Account"
				: opts.split === "none"
					? ""
					: opts.split;
	const lines = [[opts.group, split, ...p.months.map(m => m.slice(0, 7)), "Total"].map(q).join(",")];
	for (const r of p.rows) {
		lines.push([r.g, "TOTAL", ...r.per.map(v => v.toFixed(2)), r.tot.toFixed(2)].map(q).join(","));
		if (opts.split !== "none")
			for (const [key, values] of Object.entries(p.data[r.g])) {
				const per = p.months.map(m => values[m] || 0),
					t = per.reduce((a, b) => a + b, 0);
				if (Math.abs(t) >= 0.01)
					lines.push([r.g, key, ...per.map(v => v.toFixed(2)), t.toFixed(2)].map(q).join(","));
			}
	}
	return lines.join("\n") + "\n";
}
export function explain(u: string) {
	const rules: [RegExp, string][] = [
		[/BoxUsage:(.+)/, "EC2 instance hours ($1)"],
		[/InstanceUsage:(.+)/, "DB instance hours ($1)"],
		[/Multi-AZUsage:(.+)/, "Multi-AZ DB hours ($1)"],
		[/NodeUsage:(.+)/, "Cache node hours ($1)"],
		[/PublicIPv4:InUseAddress/, "Public IPv4 addresses in use"],
		[/PublicIPv4:IdleAddress/, "Public IPv4 — idle (unattached)"],
		[/NatGateway-Hours/, "NAT gateway hours"],
		[/NatGateway-Bytes/, "Data through NAT gateway"],
		[/LoadBalancerUsage/, "Load balancer hours"],
		[/LCUUsage/, "Load balancer capacity units"],
		[/VolumeUsage\.gp3/, "EBS gp3 storage"],
		[/VolumeUsage\.gp2/, "EBS gp2 storage"],
		[/EBS:VolumeUsage/, "EBS storage"],
		[/SnapshotUsage/, "Snapshot storage"],
		[/RDS:GP2-Storage|RDS:GP3-Storage|StorageUsage/, "Database storage"],
		[/ChargedBackupUsage/, "Backup storage beyond free tier"],
		[/DataTransfer-Out-Bytes/, "Data transfer out to internet"],
		[/DataTransfer-Regional-Bytes/, "Cross-AZ data transfer"],
		[/DataProcessing-Bytes/, "CloudWatch Logs ingestion"],
		[/TimedStorage-ByteHrs/, "Storage (log or S3)"],
		[/CW:MetricMonitorUsage/, "Custom / detailed metrics"],
		[/CW:Requests/, "CloudWatch API requests"],
		[/CW:AlarmMonitorUsage/, "CloudWatch alarms"],
		[/Fargate-vCPU-Hours/, "Fargate vCPU hours"],
		[/Fargate-GB-Hours/, "Fargate memory hours"],
		[/SpotUsage-Fargate-vCPU/, "Fargate Spot vCPU"],
		[/SpotUsage-Fargate-GB/, "Fargate Spot memory"],
		[/VendedLog-Bytes/, "VPC flow logs / vended logs ingestion"],
		[/HostedZone/, "Route 53 hosted zone"],
		[/Requests-Tier|Requests/, "API requests"],
		[/KMS-Keys/, "KMS keys"],
		[/BundleUsage/, "Lightsail bundle"],
		[/ConfigurationItemRecorded/, "AWS Config recorded items"],
		[/VPCEndpoint-Hours/, "VPC endpoint hours"],
		[/APIRequest/, "API requests"],
		[/Paid Hosted Zone|Queries/, "DNS queries"],
	];
	for (const [re, text] of rules) {
		const m = u.match(re);
		if (m) return text.replace("$1", m[1] || "");
	}
	return "";
}
export function usageRows(model: AwsModel, row: ServiceRow) {
	const c = model.accounts.find(a => a.key === row.acc)!.costs,
		pre = row.svc + "||",
		names = new Set<string>();
	for (const m of [model.last, model.cur])
		for (const k of Object.keys(c.usage[m] || {})) if (k.startsWith(pre)) names.add(k.slice(pre.length));
	for (const values of Object.values(c.usage_week))
		for (const k of Object.keys(values)) if (k.startsWith(pre)) names.add(k.slice(pre.length));
	return [...names]
		.map(u => ({
			u,
			last: c.usage[model.last]?.[pre + u] || 0,
			mtd: c.usage[model.cur]?.[pre + u] || 0,
			rr: (model.rrDays.reduce((t, d) => t + (c.usage_week[d]?.[pre + u] || 0), 0) / 7) * 30,
		}))
		.filter(r => r.last >= 0.01 || r.mtd >= 0.01 || r.rr >= 0.01)
		.sort((a, b) => b.rr - a.rr || b.last - a.last);
}
