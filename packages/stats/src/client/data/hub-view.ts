/** Display rules for the quota card and the Jobs view (pure, so they are tested without a DOM). */
import type { HubGap, HubJob, HubJobStatus, HubQuota, HubQuotaAccount, HubQuotaWindow } from "./hub";

/** "3h 20m", "45m", "<1m" for a span of milliseconds. */
export function span(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return minutes % 60 === 0 || hours >= 10 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d`;
}

export function resetsText(resetsAt: number | null, now: number): string | null {
	if (!resetsAt) return null;
	return resetsAt <= now ? "reset time passed" : `resets in ${span(resetsAt - now)}`;
}

const PROVIDER_NAMES: Record<string, string> = {
	"openai-codex": "Codex",
	anthropic: "Claude",
	"github-copilot": "Copilot",
	"google-gemini-cli": "Gemini",
};

export function providerName(provider: string): string {
	return PROVIDER_NAMES[provider] ?? provider;
}

/** What one window says: the percent (or why there is none), how fresh the reading is, when it resets. */
export function windowView(
	w: HubQuotaWindow,
	now: number,
): { percent: string; detail: string; tone: "ok" | "warn" | "bad" | "neutral" } {
	const read = w.observedAt ? `read ${span(now - w.observedAt)} ago` : null;
	const reset = resetsText(w.resetsAt, now);
	if (w.state === "stale") {
		return {
			percent: "stale",
			detail: ["reading is from before the window reset, not current", read].filter(Boolean).join(" · "),
			tone: "warn",
		};
	}
	if (w.state === "unknown" || w.usedPercent === null) {
		return { percent: "unknown", detail: ["no usable reading", read].filter(Boolean).join(" · "), tone: "neutral" };
	}
	const percent = `${Number.isInteger(w.usedPercent) ? w.usedPercent : w.usedPercent.toFixed(1)}%`;
	return {
		percent,
		detail: [reset, read].filter(Boolean).join(" · "),
		tone: w.high ? "bad" : w.usedPercent >= 80 ? "warn" : "ok",
	};
}

/** The account's own problem (it needs a login, or omp is holding its traffic back), else null. */
export function accountProblem(a: HubQuotaAccount): { label: string; tone: "warn" | "bad" } | null {
	if (a.state === "needs_login") return { label: "Needs login", tone: "bad" };
	if (a.state === "rate_limited") return { label: "Rate limited", tone: "warn" };
	return null;
}

/** Highest current used percent across all accounts and windows, with where it is; null when nothing is current. */
export function highest(q: HubQuota): { percent: number; provider: string } | null {
	let best: { percent: number; provider: string } | null = null;
	for (const a of q.accounts) {
		for (const w of a.windows) {
			if (w.state === "ok" && w.usedPercent !== null && (!best || w.usedPercent > best.percent)) {
				best = { percent: w.usedPercent, provider: providerName(a.provider) };
			}
		}
	}
	return best;
}

/** One line for the collapsed phone row, e.g. "Codex 97% used · 1 account needs attention". */
export function quotaHeadline(q: HubQuota): string {
	const top = highest(q);
	const problems = q.accounts.filter(a => accountProblem(a)).length;
	const parts = [top ? `${top.provider} ${top.percent}% used` : "no current readings"];
	if (problems > 0)
		parts.push(`${problems} account${problems === 1 ? "" : "s"} need${problems === 1 ? "s" : ""} attention`);
	return parts.join(" · ");
}

/** Providers with exactly one account and no backup worth saying so for (Codex). */
export function noBackupNotes(q: HubQuota): string[] {
	return Object.entries(q.providers)
		.filter(([provider, count]) => count === 1 && provider.includes("codex"))
		.map(([provider]) => `${providerName(provider)}: one account, no backup`);
}

const STATUS_ORDER: Record<HubJobStatus, number> = { failed: 0, unknown: 1, running: 2, ok: 3, "not loaded": 4 };

/** Failed first, then unknown (and unreadable), running, ok, not loaded; each by label. */
export function jobOrder(a: HubJob, b: HubJob): number {
	return (
		STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
		Number(a.readable) - Number(b.readable) ||
		a.label.localeCompare(b.label)
	);
}

export function statusLabel(job: HubJob): { label: string; tone: "ok" | "warn" | "bad" | "neutral" | "accent" } {
	switch (job.status) {
		case "running":
			return { label: "Running", tone: "accent" };
		case "ok":
			return { label: "Last exit ok", tone: "ok" };
		case "failed":
			return { label: job.exit ? job.exit.replace(/^last exit/, "Failed, exit") : "Failed", tone: "bad" };
		case "not loaded":
			return { label: "Not loaded", tone: "neutral" };
		default:
			return { label: "Unknown", tone: "warn" };
	}
}

/** "last log write 3h ago", or "no log written" (the plist names no log, or the file does not exist). */
export function logText(job: HubJob, now: number): string {
	return job.lastLogWrite ? `last log write ${span(now - job.lastLogWrite)} ago` : "no log written";
}

export function gapText(g: HubGap): string {
	const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const sameDay = new Date(g.start).toDateString() === new Date(g.end).toDateString();
	const day = (ms: number) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
	const from = sameDay ? clock(g.start) : `${day(g.start)} ${clock(g.start)}`;
	const to = sameDay ? clock(g.end) : `${day(g.end)} ${clock(g.end)}`;
	return `${from}–${to} (${span(g.end - g.start)})`;
}

/** Counts per status for the page header, in display order, skipping zeros. */
export function statusCounts(jobs: HubJob[]): { status: HubJobStatus; count: number }[] {
	return (Object.keys(STATUS_ORDER) as HubJobStatus[])
		.sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b])
		.map(status => ({ status, count: jobs.filter(j => j.status === status).length }))
		.filter(entry => entry.count > 0);
}
