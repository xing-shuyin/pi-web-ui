/**
 * 问卷答案的投递登记簿 —— 解决「点了选项还是反复弹出」的根因。
 *
 * 背景（bug）：QuestionDialog 用 appSend 发 question_answer，而 appSend 在 WebSocket
 * 未开时直接返回 false（见 app-globals.ts）。对话框不看返回值，乐观地以为提交成功；
 * 若此刻连接正好断了（笔记本睡眠唤醒、服务重启、代理掐连接，长时间挂机后尤其常见），
 * 答案就此丢失 —— 服务端仍挂起提问，重连后快照把问卷重新推回面板，用户再答再丢，
 * 无限循环。
 *
 * 因此答案改为「登记后投递」：
 *  1. sendQuestionAnswer 发送并登记（未确认）；
 *  2. 服务端 settle 会回 question_retracted，那才是确认，确认后才从登记簿删除；
 *  3. 每次 (重)连 ready 与快照恢复时重投未确认答案（幂等：服务端对已 settle 的 id
 *     静默忽略，见 AgentService.resolveQuestion）；
 *  4. 有待投答案的问卷不再从快照恢复成弹窗，避免同一张问卷重生。
 */
import type { ClientMessage } from "../../server/protocol.js";
import { appSend } from "./app-globals";

/** key 合并 owner：跨页作答与本地作答的 id 作用域不同，不能互相覆盖。 */
function keyOf(id: string, owner?: string): string {
	return owner ? `${owner}\u0000${id}` : id;
}

/** 未确认的答案（按 id 去重，重复提交只会替换）。 */
const unconfirmed = new Map<string, ClientMessage>();

/** 提交答案：登记并尝试发送；返回是否"立刻送进了 socket"。
 *  无论是否送出都登记 —— 连接断开时由下次 ready 重投，用户不必重答。 */
export function sendQuestionAnswer(msg: ClientMessage & { type: "question_answer" }): boolean {
	const key = keyOf(msg.id, msg.owner);
	unconfirmed.delete(key);
	unconfirmed.set(key, msg);
	// 登记簿只是补投缓冲，不设上限会让长时间挂机堆积；64 张问卷足够覆盖。
	if (unconfirmed.size > 64) {
		const oldest = unconfirmed.keys().next().value;
		if (oldest !== undefined) unconfirmed.delete(oldest);
	}
	return appSend(msg);
}

/** 服务端确认（question_retracted）后清理。 */
export function confirmQuestionAnswer(id: string, owner?: string): void {
	unconfirmed.delete(keyOf(id, owner));
}

/** 该问卷是否已有待投答案（有 → 不要再从快照恢复成弹窗）。 */
export function hasUnconfirmedAnswer(id: string, owner?: string): boolean {
	return unconfirmed.has(keyOf(id, owner));
}

/** (重)连后重投全部未确认答案；幂等，服务端对已 settle 的 id 静默忽略。 */
export function resendUnconfirmedAnswers(): void {
	const pending = Array.from(unconfirmed.values());
	for (const msg of pending) {
		// 连接又断了：全部留着，下次 ready 再投。
		if (!appSend(msg)) return;
	}
}

/** 服务端换了运行实例（runId 变化 / 未知）时清空：新实例的 q-1 是另一张问卷。 */
export function resetUnconfirmedAnswers(): void {
	unconfirmed.clear();
}

/** 单测用：当前登记数量。 */
export function unconfirmedAnswerCount(): number {
	return unconfirmed.size;
}
