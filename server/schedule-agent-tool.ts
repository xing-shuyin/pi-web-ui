import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { SCHEDULE_TOOL_NAME } from "./tool-manager.js";
import {
	computeNextFire,
	describeIntervalMs,
	SCHEDULER_MIN_INTERVAL_MS,
	SchedulerValidationError,
	type SchedulerStore,
	type SchedulerTaskView,
} from "./scheduler-tasks.js";
import { parseCronSpec } from "./plugin-schedule.js";

export interface ScheduleToolHost {
	store: () => SchedulerStore | undefined;
	executionSource?: () => { cwd: string; conversationId: string; sessionFile: string };
	cwd: () => string;
	activeConversationId: () => string;
	conversationInfo?: (id?: string) => { cwd: string; sessionFile: string } | undefined;
}

export interface ParsedSchedule {
	kind: "cron" | "interval";
	spec: string;
}

export function parseScheduleSpec(raw: unknown): ParsedSchedule {
	const s = String(raw ?? "").trim();
	if (!s) throw new Error("empty");
	const single = s.replace(/\s+/g, " ");
	if (single.split(" ").length === 5 && parseCronSpec(single)) {
		return { kind: "cron", spec: single };
	}
	const m =
		/^(?:in\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days|w|week|weeks)?$/i.exec(
			single,
		);
	if (!m) {
		throw new Error(
			`无法解析的时间写法：${s}（要 5 字段 cron 如 "0 * * * *"，或相对时间如 "in 30m" / "in 1h" / "30m"）`,
		);
	}
	const n = Number(m[1]);
	const unit = (m[2] ?? "m").toLowerCase();
	const mult = unit.startsWith("s")
		? 1000
		: unit.startsWith("m")
			? 60_000
			: unit.startsWith("h")
				? 3_600_000
				: unit.startsWith("d")
					? 86_400_000
					: 7 * 86_400_000;
	const ms = Math.floor(n * mult);
	if (!Number.isFinite(ms) || ms <= 0) throw new Error(`时长非法：${s}`);
	return { kind: "interval", spec: String(ms) };
}

function fmtTime(ms: number | null, lang: ServerLang): string {
	if (ms === null || !Number.isFinite(ms)) return lang === "zh" ? "（未知）" : "(unknown)";
	try {
		return new Date(ms).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { hour12: false });
	} catch {
		return new Date(ms).toISOString();
	}
}

function taskLine(t: SchedulerTaskView, lang: ServerLang): string {
	const when =
		t.kind === "cron"
			? `cron ${t.spec}`
			: lang === "zh"
				? describeIntervalMs(Number(t.spec))
				: `every ${Math.round(Number(t.spec) / 1000)}s`;
	const state = !t.enabled
		? lang === "zh"
			? "已暂停"
			: "paused"
		: t.running
			? lang === "zh"
				? "执行中"
				: "running"
			: lang === "zh"
				? "启用"
				: "on";
	const once = t.oneShot ? (lang === "zh" ? " · 单次" : " · one-shot") : "";
	const target =
		t.target === "canvas"
			? lang === "zh"
				? ` · 画布→${t.graphId}`
				: ` · canvas→${t.graphId}`
			: t.conversationId
				? lang === "zh"
					? ` · 汇报→对话${t.conversationId}`
					: ` · reports→${t.conversationId}`
				: lang === "zh"
					? " · 无头执行"
					: " · headless";
	const last = t.lastRun
		? lang === "zh"
			? ` · 上次${t.lastRun.ok ? "成功" : `失败（${t.lastRun.error ?? "未知错误"}）`}`
			: ` · last ${t.lastRun.ok ? "ok" : `failed (${t.lastRun.error ?? "unknown"})`}`
		: "";
	return `• ${t.id} · ${t.name} · ${when} · ${state}${once}${target} · ${lang === "zh" ? "下次" : "next"} ${fmtTime(t.nextFire, lang)}${last}`;
}

export const SCHEDULE_ACTIONS = ["create", "list", "cancel"] as const;

export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

export function makeScheduleTool(
	host: ScheduleToolHost,
	ownerConversationId?: string,
	lang?: () => ServerLang,
): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	const noStore = () =>
		text(
			pick(
				getLang(),
				"当前引擎不支持定时任务（调度存储未接入）。",
				"Scheduled tasks are not wired for the current engine.",
				"sched.not.wired",
			),
		);

	return defineTool({
		name: SCHEDULE_TOOL_NAME,
		label: "Manage scheduled tasks",
		description:
			"Create, list, or cancel persistent scheduled tasks. Without graphId, delivers a required prompt to the current conversation; " +
			"if unavailable, falls back to the project's active conversation or a headless run. With graphId, runs that existing canvas; " +
			"prompt is optional and otherwise uses the graph's input. Canvas tasks do not bind a conversation or override node models. " +
			"One-shot by default; recurring=true repeats. Minimum delay 60s.",
		promptSnippet: "Create, list, or cancel conversation or canvas schedules",
		promptGuidelines: [
			"Use action=create for periodic checks, delayed reminders, and scheduled summaries — never sleep loops (they cannot push messages back)",
			"Use action=list to inspect existing tasks and action=cancel to stop one by id",
		],
		parameters: Type.Object({
			action: Type.Unsafe<ScheduleAction>({
				type: "string",
				enum: [...SCHEDULE_ACTIONS],
				description: "The schedule action to perform.",
			}),
			schedule: Type.Optional(
				Type.String({
					description:
						'create: when to fire — 5-field cron ("0 * * * *" hourly) or relative delay ("in 30m", "in 1h", "30m"). Minimum 60s.',
				}),
			),
			graphId: Type.Optional(
				Type.String({
					description: "create: existing canvas graph id; when provided, targets the canvas instead of a conversation.",
				}),
			),
			prompt: Type.Optional(
				Type.String({
					description:
						"create: instruction for the conversation or canvas. Required for conversations; omit for canvas to use graph input. Max 8000 chars.",
				}),
			),
			label: Type.Optional(
				Type.String({
					description: "create: short name shown in the background-tasks panel. Defaults to the prompt head.",
				}),
			),
			recurring: Type.Optional(
				Type.Boolean({
					description: "create: repeat on schedule (default false = one-shot, auto-deleted after firing).",
				}),
			),
			id: Type.Optional(Type.String({ description: "cancel: task id from action=list." })),
		}),
		execute: async (_id, p, signal) => {
			signal?.throwIfAborted();
			const source = host.executionSource?.();
			const action = (p.action ?? "").trim().toLowerCase();
			if (!action) {
				return text(
					pick(
						getLang(),
						"schedule 工具缺少 action 参数（可选：create, list, cancel）。",
						"schedule tool requires an action parameter (one of: create, list, cancel).",
						"sched.action.missing",
					),
				);
			}
			const store = host.store();
			if (!store) return noStore();
			switch (action) {
				case "create": {
					let parsed: ParsedSchedule;
					try {
						parsed = parseScheduleSpec(p.schedule);
					} catch (err) {
						const errorMsg = (err as Error).message;
						return text(
							pick(
								getLang(),
								`时间写法非法：${String(p.schedule ?? "")}（要 5 字段 cron 如 "0 * * * *" 或相对时间如 "in 30m"）：${errorMsg}`,
								`Invalid schedule: ${String(p.schedule ?? "")} (want 5-field cron like "0 * * * *" or a delay like "in 30m"): ${errorMsg}`,
								"sched.task.bad.schedule",
								{ schedule: String(p.schedule ?? ""), error: errorMsg },
							),
						);
					}
					if (parsed.kind === "interval" && Number(parsed.spec) < SCHEDULER_MIN_INTERVAL_MS) {
						return text(
							pick(
								getLang(),
								`间隔太短（最短 60s，防 token 烧穿）。`,
								`Interval too short (minimum 60s, prevents token burn).`,
								"sched.task.interval.too.short",
							),
						);
					}
					const isCanvas = p.graphId !== undefined;
					const graphId = String(p.graphId ?? "").trim();
					const prompt = String(p.prompt ?? "").trim();
					if (!prompt && !isCanvas) {
						return text(
							pick(
								getLang(),
								"触发指令（prompt）不能为空：写清楚触发时要检查什么、汇报什么。",
								"Prompt must not be empty: say what to check and report on fire.",
								"sched.task.empty.prompt",
							),
						);
					}
					const cwd = String(source?.cwd ?? host.cwd() ?? "").trim();
					if (!cwd) {
						return text(
							pick(
								getLang(),
								"当前没有工作目录，无法创建定时任务。",
								"No working directory, cannot create the scheduled task.",
								"sched.task.no.cwd",
							),
						);
					}
					const labelRaw = typeof p.label === "string" ? p.label.trim().slice(0, 80) : "";
					const name = labelRaw || prompt.split("\n")[0]!.slice(0, 40) || (isCanvas ? `Canvas ${graphId}` : "定时任务");
					const convId =
						source?.conversationId ??
						((ownerConversationId ?? "").trim() || String(host.activeConversationId() ?? "").trim());
					let bindCwd = cwd;
					let bindSessionFile = source?.sessionFile ?? "";
					try {
						const info =
							isCanvas || source
								? undefined
								: host.conversationInfo?.((ownerConversationId ?? "").trim() || convId || undefined);
						if (info) {
							if (String(info.cwd ?? "").trim()) bindCwd = String(info.cwd).trim();
							bindSessionFile = String(info.sessionFile ?? "")
								.trim()
								.slice(0, 1024);
						}
					} catch {}
					const recurring = p.recurring === true;
					let task;
					try {
						signal?.throwIfAborted();
						task = store.upsert(
							{
								name,
								target: isCanvas ? "canvas" : "conversation",
								...(isCanvas ? { graphId } : {}),
								cwd: bindCwd,
								kind: parsed.kind,
								spec: parsed.spec,
								prompt,
								conversationId: convId,
								sessionFile: bindSessionFile,
								oneShot: !recurring,
							},
							source?.sessionFile ? { sessionFile: source.sessionFile, toolCallId: _id } : undefined,
						);
					} catch (err) {
						signal?.throwIfAborted();
						const L = getLang();
						if (err instanceof SchedulerValidationError) {
							return text(L === "zh" ? err.messageZh : err.messageEn);
						}
						return text(String((err as Error)?.message ?? err));
					}
					const L = getLang();
					const next = computeNextFire(task, Date.now());
					const head =
						L === "zh"
							? `定时任务已创建：${task.id}（${task.name}）`
							: `Scheduled task created: ${task.id} (${task.name})`;
					const whenLine =
						L === "zh"
							? `触发：${parsed.kind === "cron" ? `cron ${parsed.spec}` : describeIntervalMs(Number(parsed.spec))}，下次 ${fmtTime(next, L)}${recurring ? "（周期）" : "（单次，触发后自动删除）"}`
							: `Fires: ${parsed.kind === "cron" ? `cron ${parsed.spec}` : `every ${Math.round(Number(parsed.spec) / 1000)}s`}, next ${fmtTime(next, L)}${recurring ? " (recurring)" : " (one-shot, auto-deleted after firing)"}`;
					const targetLine = isCanvas
						? L === "zh"
							? `目标：画布 ${graphId}；${prompt ? "使用提供的触发指令" : "使用图自带输入"}，模型由画布节点配置。`
							: `Target: canvas ${graphId}; ${prompt ? "uses the supplied instruction" : "uses the graph's input"}, with models configured by canvas nodes.`
						: convId
							? L === "zh"
								? `汇报：触发时自动唤醒本对话（${convId}）；压缩/重启后按会话文件自动重绑，原对话不在时先回落同项目活跃对话（明确提示），无存活对话才无头执行。`
								: `Reports: wakes this conversation (${convId}) on fire; re-binds by session file after compaction/restart, falls back to the project's active conversation (with a visible note), headless only with no live conversation.`
							: L === "zh"
								? "汇报：无头执行，报告进调度面板历史（创建时没拿到对话 id）。"
								: "Reports: headless run, report in panel history (no conversation id captured at creation).";
					const tail =
						L === "zh"
							? `取消：schedule(action="cancel", id="${task.id}")，或后台任务面板手动取消；查看：schedule(action="list")。`
							: `Cancel: schedule(action="cancel", id="${task.id}"), or from the background-tasks panel; inspect: schedule(action="list").`;
					return text(`${head}\n${whenLine}\n${targetLine}\n${tail}`, { task });
				}
				case "list": {
					const L = getLang();
					const tasks = store.list();
					if (tasks.length === 0) {
						return text(
							pick(
								getLang(),
								'当前没有定时任务。用 schedule(action="create") 创建（cron 或 in 30m 这类延迟，最短 60s）。',
								'No scheduled tasks. Create one with schedule(action="create") (cron or a delay like in 30m, minimum 60s).',
								"sched.list.empty",
							),
							{ tasks: [] },
						);
					}
					const lines = tasks.slice(0, 50).map((t) => taskLine(t, L));
					const more =
						tasks.length > 50
							? L === "zh"
								? `\n…还有 ${tasks.length - 50} 条没列（去后台任务面板看全量）。`
								: `\n…${tasks.length - 50} more not shown (see the background-tasks panel).`
							: "";
					const head = L === "zh" ? `定时任务（${tasks.length}）：` : `Scheduled tasks (${tasks.length}):`;
					return text(`${head}\n${lines.join("\n")}${more}`, { tasks });
				}
				case "cancel": {
					const id = String(p.id ?? "").trim();
					if (!id) {
						return text(
							pick(
								getLang(),
								'要删哪个任务？给 id（先 schedule(action="list") 查）。',
								'Which task? Give its id (see schedule(action="list") first).',
								"sched.cancel.empty.id",
							),
						);
					}
					if (!store.remove(id)) {
						return text(
							pick(
								getLang(),
								`没有 id=${id} 的任务（可能已触发自删或被删过，用 schedule(action="list") 看现有的）。`,
								`No task id=${id} (may have fired-and-deleted or been removed; see schedule(action="list")).`,
								"sched.cancel.not.found",
								{ id },
							),
						);
					}
					return text(
						pick(
							getLang(),
							`定时任务 ${id} 已删除，不再触发。`,
							`Scheduled task ${id} deleted, will not fire again.`,
							"sched.cancel.ok",
							{ id },
						),
						{ id },
					);
				}
				default:
					return text(
						pick(
							getLang(),
							`未知 action：${action}。支持的 action：create, list, cancel。`,
							`Unknown action: ${action}. Supported actions: create, list, cancel.`,
							"sched.action.unknown",
							{ action },
						),
					);
			}
		},
	});
}
