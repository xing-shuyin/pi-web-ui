import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ClientRuntime } from "./client-runtime.js";
import type { FrameSender } from "./core-engine.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { DispatchSession } from "../engine-service.js";
import type { ServerMessage } from "../protocol.js";

export function findSessionOwner(
	runtimes: Map<string, ClientRuntime>,
	sockets: ReadonlyMap<string, Set<FrameSender>>,
	sessionFile: string,
	excludeClientId?: string,
): { title: string; isStreaming: boolean; clientId: string; conversationId: string } | undefined {
	const norm = resolve(sessionFile);
	for (const [cid, rt] of runtimes) {
		if (cid === excludeClientId) continue;
		if ((sockets.get(cid)?.size ?? 0) === 0) continue;
		for (const conv of rt.registry.list()) {
			if (conv.meta.sessionFile) {
				try {
					if (resolve(conv.meta.sessionFile) === norm) {
						return {
							title: conv.meta.title,
							isStreaming: conv.phase === "running",
							// 占用者身份：`switchSession` 撞上「别处开着」时要按它发起过户（issue #567 的单写者保护）。
							clientId: cid,
							conversationId: conv.id,
						};
					}
				} catch {}
			}
		}
	}
	return undefined;
}

export function checkParallelWork(
	deps: {
		runtimes: Map<string, ClientRuntime>;
		sockets: ReadonlyMap<string, Set<FrameSender>>;
		deliverTo: (clientId: string, msg: ServerMessage) => void;
	},
	clientId: string,
	conv: Conversation | undefined,
): void {
	if (!conv || !conv.meta.cwd) return;
	const targetCwd = conv.meta.cwd;
	const streamingOthers: Array<{ clientId: string; title: string }> = [];
	for (const [cid, rt] of deps.runtimes) {
		if (cid === clientId) continue;
		if ((deps.sockets.get(cid)?.size ?? 0) === 0) continue;
		for (const other of rt.registry.list()) {
			if (other.meta.cwd === targetCwd && other.phase === "running") {
				streamingOthers.push({ clientId: cid, title: other.meta.title });
				break;
			}
		}
	}
	if (streamingOthers.length === 0) return;
	const shown = streamingOthers
		.map((o) => `另一处「${o.title}」`)
		.slice(0, 3)
		.join("、");
	const more = streamingOthers.length > 3 ? `等 ${streamingOthers.length} 处` : "";
	deps.deliverTo(clientId, {
		type: "notice",
		level: "info",
		text: `同项目并行提醒：${shown}${more}正在同一项目运行。你可以继续（适合改不同文件），改动同一文件前请先确认；拿不准就等它跑完。`,
		textEn: `Parallel-work notice: ${shown}${more ? " and more" : ""} running in the same project. You may continue (fine for different files); confirm before touching the same files, or wait for it to finish when unsure.`,
	});
	for (const other of streamingOthers) {
		deps.deliverTo(other.clientId, {
			type: "notice",
			level: "info",
			text: `同项目并行提醒：另一处在「${conv.meta.cwd}」开始了对话（「${conv.meta.title}」），可能与你正在跑的任务并行改动同一项目。`,
			textEn: `Parallel-work notice: another window started a conversation ("${conv.meta.title}") in "${conv.meta.cwd}", possibly editing the same project in parallel with your running task.`,
		});
	}
}

export async function chatFromScheduler(
	deps: {
		isQuiesced: () => boolean;
		attach: (clientId: string, send: FrameSender) => Promise<DispatchSession>;
		runtimes: Map<string, ClientRuntime>;
	},
	task: {
		id: string;
		name?: string;
		cwd: string;
		prompt: string;
		model?: string;
		thinkingLevel?: string;
	},
): Promise<{ ok: boolean; conversationId?: string; sessionFile?: string; error?: string }> {
	const safe = String(task.id ?? "task").replace(/[^A-Za-z0-9_-]/g, "") || "task";
	const clientId = `scheduler:${safe}`;
	const text = String(task.prompt ?? "");
	if (!text.trim()) return { ok: false, error: "触发指令为空" };
	if (deps.isQuiesced()) return { ok: false, error: "服务器正忙（quiesced），请稍后重试" };
	const cwd = String(task.cwd ?? "").trim();
	try {
		if (!cwd || !statSync(cwd).isDirectory()) throw new Error("not-a-dir");
	} catch {
		return { ok: false, error: `目标项目不存在或不是目录：${cwd || "（空）"}` };
	}
	try {
		const cs = await deps.attach(clientId, () => {});
		if (cs.cwd !== cwd) await cs.setCwd(cwd);
		const model = String(task.model ?? "").trim();
		if (model) {
			try {
				await cs.setModel(model);
			} catch (err) {
				return { ok: false, error: `切换模型失败（${model}）：${(err as Error).message}` };
			}
		}
		const thinking = String(task.thinkingLevel ?? "").trim();
		if (thinking) {
			try {
				cs.setThinking(thinking);
			} catch (err) {
				return { ok: false, error: `切换思考强度失败（${thinking}）：${(err as Error).message}` };
			}
		}
		const conv = deps.runtimes.get(clientId)?.registry.activeConv();
		const conversationId = conv?.id ?? "";
		const taskTitle = (task.name || "").trim() || (text.length > 30 ? text.slice(0, 30) : text);
		if (conversationId && taskTitle && conv) {
			conv.meta.title = taskTitle;
		}
		await cs.prompt(text);
		return { ok: true, conversationId, sessionFile: conv?.meta.sessionFile };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

export function releaseSchedulerClient(
	deps: {
		runtimes: Map<string, ClientRuntime>;
		clearOffline: (clientId: string) => void;
		notifyExternalRunning: () => void;
	},
	taskId: string,
): void {
	const safe = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "task";
	for (const clientId of [`scheduler:${safe}`, `scheduler:wake-${safe}`]) {
		const rt = deps.runtimes.get(clientId);
		if (rt) {
			deps.runtimes.delete(clientId);
			deps.clearOffline(clientId);
			rt.dispose();
		}
	}
	deps.notifyExternalRunning();
}
