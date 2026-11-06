import { performance } from "node:perf_hooks";

type Stage = { stage: string; ms: number };
export interface LoadTiming {
	mark(stage: string): void;
	finish(outcome: "loaded" | "reused" | "stopped" | "error"): void;
}
const disabled: LoadTiming = { mark() {}, finish() {} };

export function startLoadTiming(
	enabled = /^(1|true|on|yes)$/i.test(process.env.PI_WEB_LOAD_TIMING ?? ""),
	now: () => number = () => performance.now(),
	report: (record: { event: string; outcome: string; totalMs: number; stages: Stage[] }) => void = (record) =>
		console.info("[load-timing]", JSON.stringify(record)),
): LoadTiming {
	if (!enabled) return disabled;
	const start = now();
	let previous = start;
	let finished = false;
	const stages: Stage[] = [];
	return {
		mark(stage) {
			if (finished) return;
			const current = now();
			stages.push({ stage, ms: Number((current - previous).toFixed(3)) });
			previous = current;
		},
		finish(outcome) {
			if (finished) return;
			finished = true;
			try {
				report({ event: "history-open", outcome, totalMs: Number((now() - start).toFixed(3)), stages });
			} catch {}
		},
	};
}
