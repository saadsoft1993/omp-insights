import { parsePlan } from "../../src/client/routes/plan-markdown-parser";
import { installGlobal } from "./memory-dom";

export class PlanWorker {
	static instances: PlanWorker[] = [];
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessageerror: (() => void) | null = null;
	terminated = false;
	constructor(
		public url: string,
		public options: unknown,
	) {
		PlanWorker.instances.push(this);
	}
	postMessage(source: string) {
		if (source === "a*b*".repeat(50000) || source === "- > ".repeat(1000)) return;
		queueMicrotask(() => {
			if (this.terminated) return;
			try {
				this.onmessage?.({ data: { ok: true, result: parsePlan(source) } });
			} catch {
				this.onmessage?.({ data: { ok: false } });
			}
		});
	}
	terminate() {
		this.terminated = true;
	}
}

export function installPlanWorker() {
	PlanWorker.instances = [];
	installGlobal("Worker", PlanWorker);
}
