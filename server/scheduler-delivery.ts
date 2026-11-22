/**
 * 定时任务把报告送回「当时那条对话」的策略（#959）。
 *
 * 起因：唤醒链路把「投不进去」当成「目标没了」，于是把任务改投到同项目最活跃的另一个
 * 对话，**并把新对话写回任务绑定**。触发条件可以只是一次几秒的上下文压缩窗口、一次
 * 会话退役换绑，或者对话被打开的对话数上限 LRU 收起——后果却是永久的（周期任务从此
 * 汇报到别处，二次失败还会把绑定清空、永久转无头）。
 *
 * 这里只做三件互不纠缠的事：
 * 1. **寻址只认持久身份**（`sessionFile`）。运行时 id 只在本进程内有意义，不参与寻址，
 *    更不写进绑定；老任务只有 id 时，靠宿主按 id + cwd 找，找不回来就如实失败。
 * 2. **一封回执说实话**：`wake` 说成了才是成了。门关着（压缩 / 退役窗口）不是失败——
 *    那是宿主的意图队列在存着，`wake` 返回 ok 就代表「已受理，一定会落到这条对话」。
 * 3. **绝不改换目标**。投不进就退到后台执行，绑定一字不改：下次触发仍然先找原对话。
 *    真要让任务改投别处，那是用户命令（面板/工具显式改绑），不是执行副作用。
 *
 * 本模块不 import 引擎、不碰 Conversation：宿主能力由 `SchedulerDeliveryHost` 注入，
 * 便于单测（策略在 `index.ts` 里当闭包时，四层回落没有任何测试能覆盖）。
 */
import { resolve } from "node:path";
import type { SchedulerExecutorResult, SchedulerTask } from "./scheduler-tasks.js";
import { describeMaterials, normalizeMaterials, planMaterialDelivery, stageMaterials } from "./material.js";

/** 唤醒回执：只说宿主真的知道的事。 */
export interface SchedulerWakeReceipt {
	ok: boolean;
	conversationId?: string;
	sessionFile?: string;
	/** true = 原对话当时没打开，是按转录恢复后投递的。 */
	resumed?: boolean;
	error?: string;
}

export interface SchedulerDeliveryHost {
	/**
	 * 把一段文字投进这条转录对应的对话：有活持有者就投，没有就按转录恢复一个再投。
	 * **不允许**换成别的对话（换了就不是「这条任务的对话」了）。
	 */
	wake(opts: {
		conversationId: string;
		sessionFile: string;
		cwd: string;
		text: string;
		taskId: string;
	}): Promise<SchedulerWakeReceipt>;
	/** 没有任何地址（老任务）或原对话确实不在了时的后台执行。 */
	headless(
		task: SchedulerTask,
	): Promise<{ ok: boolean; conversationId?: string; sessionFile?: string; error?: string }>;
	/** 用户可见的一次性回执。level 对应提示样式。 */
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
	/**
	 * 本次执行实际会用哪个 cwd（缺省 = 任务自己的 cwd）。
	 * 材料相对路径按任务 cwd 解释，执行在别处就得先把它们搬过去（契约 R7）。
	 */
	runCwd?(task: SchedulerTask): string | undefined;
}

/** 任务是否已经有可寻址的对话（有转录文件，或老任务至少有个运行时 id）。 */
export function hasConversationAddress(task: Pick<SchedulerTask, "conversationId" | "sessionFile">): boolean {
	return Boolean(String(task.sessionFile ?? "").trim() || String(task.conversationId ?? "").trim());
}

/** 同一个目录的不同写法（Windows 大小写 / 分隔符）不算不一致，否则会白白多复制一次。 */
function sameCwd(a: string, b: string): boolean {
	try {
		const na = resolve(a);
		const nb = resolve(b);
		return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
	} catch {
		return a === b;
	}
}

/**
 * 执行前的材料三件事（契约 §3）：归一 → 投递策略 → 清单文本。
 *
 * - 相对路径按**任务自己的 cwd** 解释（R2）；
 * - 投递形式只由 `planMaterialDelivery()` 决定（R5）；
 * - 取不到 / 超上限 / 搬不过去的项一律记账：日志 + 用户可见 notice（R6/R7），绝不静默；
 * - 没材料时返回空串，调用方拼出的 prompt 与今天逐字节一致（R10）。
 */
async function taskMaterialsManifest(task: SchedulerTask, host: SchedulerDeliveryHost, name: string): Promise<string> {
	const raw = task.materials ?? [];
	if (raw.length === 0) return "";
	const baseCwd = String(task.cwd ?? "").trim();
	const { materials, dropped } = await normalizeMaterials(raw, { cwd: baseCwd });
	if (dropped.length > 0) {
		console.warn(
			`[scheduler] ${task.id}: materials dropped — ${dropped.map((d) => `${d.reason}(${d.value})`).join(", ")}`,
		);
		// duplicate 是幂等写法，不用惊动用户；其余（missing / invalid / over-cap）要让人知道。
		const lost = dropped.filter((d) => d.reason !== "duplicate");
		if (lost.length > 0) {
			const values = lost.map((d) => d.value).join("、");
			host.notice(
				"warning",
				`定时任务「${name}」有 ${lost.length} 项材料本次无法使用（${values}），已跳过；把文件放到任务 cwd 后重新保存任务即可。`,
				`Scheduled task "${name}": ${lost.length} material(s) unusable this run (${values}) and skipped; re-save the task once the files are under its cwd.`,
			);
		}
	}
	// R5：执行侧是满血会话（有 read/bash），所以只会拿到 pointers；图片也一样给路径，不 inline。
	const plan = planMaterialDelivery(materials, { hasFs: true, vision: false });
	const runCwd = String(host.runCwd?.(task) ?? "").trim() || baseCwd;
	let pointers = plan.pointers;
	if (baseCwd && runCwd && !sameCwd(runCwd, baseCwd)) {
		// R7：执行 cwd 与材料基准不一致：先把相对路径的材料搬到执行目录，搬不动的明说。
		const { staged, failed } = await stageMaterials(plan.pointers, runCwd);
		pointers = staged;
		if (failed.length > 0) {
			const values = failed.map((f) => f.ref).join("、");
			console.warn(
				`[scheduler] ${task.id}: materials not staged — ${failed.map((f) => `${f.ref}: ${f.reason}`).join(", ")}`,
			);
			host.notice(
				"warning",
				`定时任务「${name}」的材料搬不到执行目录（${values}），本次执行可能读不到它们。`,
				`Scheduled task "${name}": materials could not be moved into the execution directory (${values}); this run may not be able to read them.`,
			);
		}
	}
	return describeMaterials(pointers);
}

/**
 * 触发一次对话型定时任务。
 *
 * 顺序：有地址 → 投进那条对话；投不进 → 如实告知原因 + 后台执行（绑定不变）；
 * 没地址 → 直接后台执行。
 */
export async function deliverScheduledRun(
	task: SchedulerTask,
	host: SchedulerDeliveryHost,
): Promise<SchedulerExecutorResult> {
	const name = String(task.name ?? "").trim() || task.id;
	const file = String(task.sessionFile ?? "").trim();
	const conversationId = String(task.conversationId ?? "").trim();
	let manifest = "";
	try {
		manifest = await taskMaterialsManifest(task, host, name);
	} catch (err) {
		// 材料层出意外绝不能拦住投递：记账后按「没材料」继续（R10 的不变式）。
		console.warn(`[scheduler] ${task.id}: material preparation failed — ${String((err as Error)?.message ?? err)}`);
	}
	// 清单只追加在末尾：没材料时 prompt 与今天逐字节一致（R10）。
	const prompt = manifest ? `${task.prompt}\n\n${manifest}` : task.prompt;
	const headless = async (why?: string): Promise<SchedulerExecutorResult> => {
		const r = await host.headless(manifest ? { ...task, prompt } : task);
		return {
			ok: r.ok,
			...(r.conversationId ? { conversationId: r.conversationId } : {}),
			...(r.sessionFile ? { sessionFile: r.sessionFile } : {}),
			// 成功但没投回原对话时也记原因：面板会把 error 原样跟在状态后面（「成功 · 已转后台执行：…」）。
			...(r.error ? { error: r.error } : why ? { error: `已转后台执行：${why}` } : {}),
		};
	};

	if (!hasConversationAddress(task)) {
		// 创建时没拿到对话（老任务 / 引擎没有对话上下文）：本来就是无头任务，不是降级。
		return headless();
	}

	const text = `[定时任务 ${name}] ${prompt}`;
	let receipt: SchedulerWakeReceipt;
	try {
		receipt = await host.wake({
			conversationId,
			sessionFile: file,
			cwd: String(task.cwd ?? ""),
			text,
			taskId: task.id,
		});
	} catch (err) {
		receipt = { ok: false, error: String((err as Error)?.message ?? err) };
	}

	if (receipt.ok) {
		if (receipt.resumed) {
			host.notice(
				"info",
				`定时任务「${name}」的原对话当时没打开，已按转录恢复并投递到原对话；报告就在那条对话里（可从历史或「定时任务」面板打开）。`,
				`Scheduled task "${name}": the original conversation was closed, so it was reopened from its transcript and the report was delivered there (openable from History or the Scheduled tasks panel).`,
			);
		}
		return {
			ok: true,
			...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
			...(receipt.sessionFile ? { sessionFile: receipt.sessionFile } : {}),
			// 补录地址只来自「真的投回原对话」的回执：失败转后台的路径不许改绑定（#959/#976）。
			...(receipt.sessionFile || receipt.conversationId
				? {
						backfill: {
							...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
							...(receipt.sessionFile ? { sessionFile: receipt.sessionFile } : {}),
						},
					}
				: {}),
		};
	}

	// 目标不可达：说清原因，然后后台执行。**不改绑**——下次触发仍然先找原对话。
	const why = receipt.error ?? "原对话不可用";
	host.notice(
		"warning",
		`定时任务「${name}」没能投递到原对话（${why}），本次已转后台执行；任务绑定不变，报告可在「定时任务」面板的调度历史里查看。`,
		`Scheduled task "${name}" could not reach its original conversation (${why}); this run went headless instead. The binding is unchanged and the report is in the Scheduled tasks panel history.`,
	);
	return headless(why);
}
