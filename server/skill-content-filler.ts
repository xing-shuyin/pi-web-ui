/**
 * skill-content-filler — 技能全文注入（{{skills}} 全文模式）内容填充器。
 *
 * 负责读取名单里技能的文件正文。
 * 单文件上限（默认 8KB）与总量预算（默认 32KB）都由调用方传入，缺省即历史硬编码值
 * （设置项 skillsMaxFileBytes / skillsFullTextMaxBytes，见 issue #819）；
 * 失败/超限/不在名单回落名录（无 content）。
 * 名单为空时零开销：原样返回，不碰磁盘。
 *
 * 预算口径是 **UTF-8 字节**：注入的是文本，模型按 token 付费，而字节数才是文件大小
 * 与上下文占用的共同尺度。以前按 `raw.length`（JavaScript 字符数）扣预算，同样的
 * 中文技能会被低估约 3 倍，总量可以冲出上限。
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { readFileSync, statSync } from "node:fs";
import { decodeText } from "./text-sniff.js";
import {
	DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES,
	DEFAULT_SKILLS_MAX_FILE_BYTES,
	normalizeSkillList,
	normalizeSkillsFullTextMaxBytes,
	normalizeSkillsMaxFileBytes,
} from "./client-state.js";

export interface SkillContentLimits {
	/** 单文件正文上限（字节）。缺省/非法回退 8192；0 = 不设单文件上限。 */
	maxFileBytes?: number;
	/** 全文注入总量预算（UTF-8 字节）。缺省/非法回退 32768；0 = 不设总量上限。 */
	maxTotalBytes?: number;
}

export function fillSkillContents(
	skills: { name: string; description: string; filePath: string }[],
	skillsFullTextConfig: string[] | undefined,
	limits: SkillContentLimits = {},
): { name: string; description: string; filePath: string; content?: string }[] {
	const wanted = new Set(normalizeSkillList(skillsFullTextConfig));
	if (wanted.size === 0) return skills;
	const maxFile =
		limits.maxFileBytes === undefined
			? DEFAULT_SKILLS_MAX_FILE_BYTES
			: normalizeSkillsMaxFileBytes(limits.maxFileBytes);
	const maxTotal =
		limits.maxTotalBytes === undefined
			? DEFAULT_SKILLS_FULL_TEXT_MAX_BYTES
			: normalizeSkillsFullTextMaxBytes(limits.maxTotalBytes);
	// 0 = 显式不设限：用 Infinity 让下面的预算判断保持单一路径。
	let budget = maxTotal > 0 ? maxTotal : Number.POSITIVE_INFINITY;
	return skills.map((s) => {
		if (!wanted.has(s.name) || !s.filePath || budget <= 0) return s;
		try {
			const st = statSync(s.filePath);
			if (!st.isFile() || st.size <= 0) return s;
			if (maxFile > 0 && st.size > maxFile) return s;
			const room = Math.min(st.size, budget);
			const slice = readFileSync(s.filePath).subarray(0, room);
			// 按预算截断时末尾可能是半个多字节字符，解码成 U+FFFD —— 丢掉它，别把乱码塞进提示词。
			const text = decodeText(slice);
			const raw = (room < st.size ? text.replace(/\uFFFD+$/u, "") : text).trim();
			if (!raw) return s;
			budget -= Buffer.byteLength(raw, "utf8");
			return { ...s, content: raw };
		} catch {
			return s;
		}
	});
}
