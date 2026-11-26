import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BackgroundPort } from "../../contracts/background.js";
import { BG_TASK_TOOL_NAME } from "../../tool-names.js";

const parameters = Type.Object({
	action: Type.String(),
	jobId: Type.Optional(Type.String()),
	tailLines: Type.Optional(Type.Integer()),
});

export function makeBgTaskTool(options: { background: () => BackgroundPort | undefined }): ToolDefinition {
	return defineTool<typeof parameters, Record<string, unknown>>({
		name: BG_TASK_TOOL_NAME,
		label: "Background Tasks",
		description: "Inspect, tail, or stop running background jobs started by bash.",
		promptSnippet: "list, tail, or stop background jobs",
		promptGuidelines: [
			"Prefer bg_task(action='status'/'kill') over raw ps/kill commands when managing background jobs",
		],
		parameters,
		execute: async (_toolCallId, rawInput) => {
			const bg = options.background();
			if (!bg) throw new Error("Background task port is unavailable");
			const input = (rawInput ?? {}) as { action?: string; jobId?: string; tailLines?: number };
			const action = String(input.action ?? "").trim();

			if (action === "list") {
				const jobs = bg.listJobs?.() ?? [];
				const details = { action, jobs };
				const text = jobs.length
					? jobs
							.map(
								(j) =>
									`${j.id} (pid ${j.pid}) — ${j.command}\n  since: ${new Date(j.since).toISOString()}\n  log: ${j.logPath}`,
							)
							.join("\n")
					: "No running background jobs.";
				return { content: [{ type: "text", text }], details };
			}

			if (action === "status") {
				const jobId = String(input.jobId ?? "").trim();
				if (!jobId) throw new Error("action='status' requires jobId");
				const tailLines =
					typeof input.tailLines === "number" && Number.isFinite(input.tailLines)
						? Math.max(1, Math.min(200, Math.floor(input.tailLines)))
						: 40;
				const res = bg.getJobStatus?.(jobId, tailLines);
				if (!res || !res.ok || !res.job) {
					return {
						content: [{ type: "text", text: res?.error ?? `Job "${jobId}" not found` }],
						details: { action, jobId, found: false },
					};
				}
				const j = res.job;
				const text = [
					`Job ${j.id} (pid ${j.pid}, state=${j.state})`,
					`Command: ${j.command}`,
					`Log: ${j.logPath}`,
					res.tail?.trim() ? `Tail:\n${res.tail.trim()}` : "(no output yet)",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { action, jobId, found: true, job: j, tail: res.tail ?? "" },
				};
			}

			if (action === "kill") {
				const jobId = String(input.jobId ?? "").trim();
				if (!jobId) throw new Error("action='kill' requires jobId");
				const res = await bg.killJob?.(jobId);
				if (!res?.ok) {
					return {
						content: [{ type: "text", text: `Job "${jobId}" not found or already exited.` }],
						details: { action, jobId, ok: false },
					};
				}
				const text = res.timedOut
					? `Job "${jobId}" stop timed out; force-removed from list.`
					: `Stopped background job "${jobId}".`;
				return {
					content: [{ type: "text", text }],
					details: { action, jobId, ok: true, timedOut: Boolean(res.timedOut) },
				};
			}

			throw new Error(`Unsupported bg_task action "${action}"; expected "list", "status", or "kill"`);
		},
	});
}
