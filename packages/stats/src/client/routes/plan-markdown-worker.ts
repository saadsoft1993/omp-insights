import { parsePlan } from "./plan-markdown-parser";

self.addEventListener("message", (event: MessageEvent<string>) => {
	try {
		self.postMessage({ ok: true, result: parsePlan(event.data) });
	} catch {
		self.postMessage({ ok: false });
	}
});
