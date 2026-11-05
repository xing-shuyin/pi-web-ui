/**
 * 打开历史会话前的转录预处理：链修复（compaction-markers）+ 悬空 toolCall 修复（dangling-tools）
 * 合并为一次异步读盘。
 *
 * 原流程对同一个文件做两次同步 readFileSync，并对每一行完整 JSON.parse（悬空检查无缓存），
 * 大转录（10MB+）打开时会阻塞事件循环、卡住所有客户端的 WebSocket。现在：
 * - 两项检查各自的健康指纹（mtimeMs:size）都命中 → 不读盘；
 * - 否则只用 fs.promises.readFile 读一次，两项检查共用文本；悬空检查按需解析（见
 *   healDanglingToolCallsInText），健康长转录只完整解析末尾几行；
 * - 修复结束后按最终文件状态刷新两份指纹。
 *
 * 语义保持与原 repairTranscriptFileBeforeOpen 一致：链修复改写了文件时本次不做悬空修复
 * （下次打开时指纹不匹配会再查）；链修复失败（读/写失败）时整体放弃。
 */
import { promises as fsPromises, statSync } from "node:fs";
import {
	healthyRepairResult,
	isTranscriptHealthyCached,
	rememberHealthyTranscriptSig,
	repairSessionFileFromText,
	type SessionFileRepair,
} from "./compaction-markers.js";
import {
	forgetHealthyDangling,
	healDanglingToolCallsInText,
	isDanglingHealthyCached,
	rememberHealthyDangling,
	type DanglingCause,
} from "./dangling-tools.js";

export interface PreparedTranscript {
	/** 链修复结果；null = 读/写失败（与 repairSessionFile 返回 null 同义）。 */
	repair: SessionFileRepair | null;
	/** 追加的合成 toolResult 条数（0 = 无；-1 = 写入失败）。 */
	healed: number;
	/** 是否真的读了盘（两项指纹都命中时为 false）。 */
	read: boolean;
}

function sigOf(st: { mtimeMs: number; size: number }): string {
	return `${st.mtimeMs}:${st.size}`;
}

export async function prepareTranscriptForOpen(
	filePath: string,
	cause: DanglingCause = "generic",
): Promise<PreparedTranscript> {
	let sig: string;
	try {
		sig = sigOf(await fsPromises.stat(filePath));
	} catch {
		return { repair: null, healed: 0, read: false };
	}
	const repairHealthy = isTranscriptHealthyCached(filePath, sig);
	const danglingHealthy = isDanglingHealthyCached(filePath, sig);
	if (repairHealthy && danglingHealthy) {
		return { repair: healthyRepairResult(filePath), healed: 0, read: false };
	}

	let raw: string;
	try {
		raw = await fsPromises.readFile(filePath, "utf8");
	} catch {
		return { repair: null, healed: 0, read: false };
	}

	const repair = repairHealthy ? healthyRepairResult(filePath) : repairSessionFileFromText(filePath, raw);
	if (!repair) return { repair: null, healed: 0, read: true };
	if (repair.changed) {
		// 文件已被改写：悬空检查留到下次打开（与原流程一致），旧指纹作废。
		forgetHealthyDangling(filePath);
		return { repair, healed: 0, read: true };
	}

	let healed = 0;
	if (!danglingHealthy) {
		try {
			healed = healDanglingToolCallsInText(filePath, raw, cause);
		} catch {
			healed = 0;
		}
	}

	// 按最终文件状态刷新指纹：追加合成结果后 size/mtime 已变，两项检查对新内容均为健康。
	if (healed >= 0) {
		try {
			const finalSig = healed > 0 ? sigOf(statSync(filePath)) : sig;
			rememberHealthyDangling(filePath, finalSig);
			rememberHealthyTranscriptSig(filePath, finalSig);
		} catch {
			/* best effort */
		}
	} else {
		forgetHealthyDangling(filePath);
	}
	return { repair, healed, read: true };
}
