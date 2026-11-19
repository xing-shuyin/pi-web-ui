import { promises as fsPromises } from "node:fs";
import {
	healthyRepairResult,
	isTranscriptHealthyCached,
	rememberHealthyTranscriptSig,
	repairSessionFileFromText,
	type SessionFileRepair,
} from "./compaction-markers.js";
import {
	appendDanglingResults,
	forgetHealthyDangling,
	healDanglingToolCallsInText,
	isDanglingHealthyCached,
	probeTailDangling,
	rememberHealthyDangling,
	type DanglingCause,
} from "./dangling-tools.js";
import { scanTranscriptForRepair } from "./transcript-scan.js";

export interface PreparedTranscript {
	repair: SessionFileRepair | null;
	healed: number;
	/** 本次是否遍历了整份文件内容（流式扫描也算；只有指纹命中才算没读） */
	read: boolean;
	/** 走了哪条路：`fast` = 元数据扫描 + 尾部检查；`full` = 整份 readFile（文件不存在时不出现） */
	path?: "fast" | "full";
}

function sigOf(st: { mtimeMs: number; size: number }): string {
	return `${st.mtimeMs}:${st.size}`;
}

/**
 * 打开前修复（链修复 + 悬空工具调用补齐）。
 *
 * 冷路径不再 `readFile` 整份转录（issue #945：74 MB 会话读两遍 ≈ 0.8s CPU / +268MB 堆）：
 *
 * 1. 元数据流式扫描 `scanTranscriptForRepair`：只留 `(id, parentId, markerKind)`，证明「修复必然不动文件」；
 * 2. 尾部窗口 `probeTailDangling`：悬空工具调用本来只需文件尾部；
 * 3. 任何一步判定不了（有分支重排 / 重复 id / 压缩标记 / 父链走出窗口）才回退整份 `readFile`，语义与旧流程一致。
 */
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
		return { repair: healthyRepairResult(filePath), healed: 0, read: false, path: "fast" };
	}

	const repairClean = repairHealthy || (await scanTranscriptForRepair(filePath)).clean;
	if (repairClean) {
		const probe = danglingHealthy ? { lastId: null, dangling: [] } : await probeTailDangling(filePath);
		if (probe) {
			let healed = 0;
			if (probe.dangling.length > 0 && probe.lastId) {
				try {
					healed = appendDanglingResults(filePath, probe.lastId, probe.dangling, cause);
				} catch {
					healed = 0;
				}
			}
			if (healed >= 0) {
				// 扫描期间文件可能被追加过：指纹一律取扫描之后的实际状态
				const finalSig = await statSig(filePath, sig);
				rememberHealthyDangling(filePath, finalSig);
				rememberHealthyTranscriptSig(filePath, finalSig);
			} else {
				forgetHealthyDangling(filePath);
			}
			return { repair: healthyRepairResult(filePath), healed, read: true, path: "fast" };
		}
	}

	return repairWholeFile(filePath, repairHealthy, danglingHealthy, sig, cause);
}

async function statSig(filePath: string, fallback: string): Promise<string> {
	try {
		return sigOf(await fsPromises.stat(filePath));
	} catch {
		return fallback;
	}
}

/** 整份读取的保守路径：判定不了就照旧读全文（语法与结果都与旧流程相同）。 */
async function repairWholeFile(
	filePath: string,
	repairHealthy: boolean,
	danglingHealthy: boolean,
	sig: string,
	cause: DanglingCause,
): Promise<PreparedTranscript> {
	let raw: string;
	try {
		raw = await fsPromises.readFile(filePath, "utf8");
	} catch {
		return { repair: null, healed: 0, read: false };
	}

	const repair = repairHealthy ? healthyRepairResult(filePath) : repairSessionFileFromText(filePath, raw);
	if (!repair) return { repair: null, healed: 0, read: true, path: "full" };
	if (repair.changed) {
		forgetHealthyDangling(filePath);
		return { repair, healed: 0, read: true, path: "full" };
	}

	let healed = 0;
	if (!danglingHealthy) {
		try {
			healed = healDanglingToolCallsInText(filePath, raw, cause);
		} catch {
			healed = 0;
		}
	}

	if (healed >= 0) {
		const finalSig = healed > 0 ? await statSig(filePath, sig) : sig;
		rememberHealthyDangling(filePath, finalSig);
		rememberHealthyTranscriptSig(filePath, finalSig);
	} else {
		forgetHealthyDangling(filePath);
	}
	return { repair, healed, read: true, path: "full" };
}
