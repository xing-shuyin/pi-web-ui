// ---------------------------------------------------------------------------
// subagent-notify.ts — 子代理终态自动通知与结构化交付契约（issue #713）
// ---------------------------------------------------------------------------
// 负责：
// 1. extractSubagentConclusion: 提炼子代理输出的核心结论（保留首尾重点，折叠冗余日志）
// 2. formatSubagentsCompletionNotice: 将批处理/防抖收敛的一组终态子代理格式化为
//    高信噪比、低 Token 占用的父对话唤醒汇报
// ---------------------------------------------------------------------------

import type { Conversation } from "./agent-service.js";
import { pick, type ServerLang } from "./i18n.js";
import { subagentRunOutcome } from "./subagent-helpers.js";

/**
 * 从子代理的长文本输出中提取核心结论：
 * - 输出较短（<= 20 行）时原样返回；
 * - 输出较长时保留前 3 行任务概况与后 15 行最终总结/结论，中间过程性输出自适应折叠；
 * - 空输出给出可读占位符。
 */
export function extractSubagentConclusion(output: string, lang: ServerLang = "en"): string {
	const trimmed = (output ?? "").trim();
	if (!trimmed) {
		return lang === "zh" ? "（无输出结果）" : "(no output produced)";
	}
	const lines = trimmed.split("\n");
	if (lines.length <= 20) {
		return trimmed;
	}
	const head = lines.slice(0, 3).join("\n");
	const tail = lines.slice(-15).join("\n");
	const omitted = lines.length - 18;
	const omitMarker =
		lang === "zh"
			? `… [中间省略 ${omitted} 行过程日志，完整转录可通过 get_result 查看] …`
			: `… [${omitted} lines omitted, full transcript available via get_result] …`;
	return `${head}\n${omitMarker}\n${tail}`;
}

/** 短 id（前 8 字符） */
function shortId(id: string): string {
	return id.slice(0, 8);
}

/**
 * 格式化聚合的一组终态子代理为父对话的入站通知。
 * 多个子代理同时完成时合成一条结构化汇报，避免碎片化打断父对话。
 */
export function formatSubagentsCompletionNotice(
	subagents: Conversation[],
	lang: ServerLang = "en",
	fallbackOriginalParentId?: string,
): string {
	if (subagents.length === 0) return "";

	const count = subagents.length;
	const fallbackNote = fallbackOriginalParentId
		? pick(
				lang,
				`（原父对话 ${shortId(fallbackOriginalParentId)} 已不在，转至当前活跃对话继续）\n`,
				`(Original parent chat ${shortId(fallbackOriginalParentId)} is gone; redirected here)\n`,
				"subagents.notify.fallback",
				{ parentId: shortId(fallbackOriginalParentId) },
			)
		: "";

	const titleHeader = pick(
		lang,
		`[子代理执行完成通知] 共有 ${count} 个子代理已完成：`,
		`[Subagent Completion Notice] ${count} subagent(s) completed:`,
		"subagents.notify.header",
		{ count },
	);

	const items = subagents.map((conv) => {
		const sId = shortId(conv.id);
		const type = conv.subagentType ?? "general";
		const roleModel = conv.session.model
			? `${conv.session.model.provider}/${conv.session.model.id}`
			: conv.subagentTemplate?.model || "default";
		const thinking = conv.session.thinkingLevel ?? conv.subagentThinking ?? "default";
		const metaTag = `${type} · ${roleModel}:${thinking}`;

		const outcome = subagentRunOutcome(conv);
		let statusLabel: string;
		if (outcome.error) {
			statusLabel = pick(
				lang,
				`❌ 运行失败（${outcome.error}）`,
				`❌ Failed (${outcome.error})`,
				"subagents.notify.status.failed",
				{ error: outcome.error },
			);
		} else if (outcome.canceled) {
			statusLabel = pick(lang, "⚠️ 已中止", "⚠️ Canceled", "subagents.notify.status.canceled");
		} else {
			statusLabel = pick(lang, "✅ 正常完成", "✅ Done", "subagents.notify.status.done");
		}

		const rawOutput = conv.session.getLastAssistantText() ?? "";
		const conclusion = extractSubagentConclusion(rawOutput, lang);
		const indentedConclusion = conclusion
			.split("\n")
			.map((l) => `  > ${l}`)
			.join("\n");

		const taskLine = conv.title ? `  - ${pick(lang, "目标", "Goal", "subagents.notify.goal")}: ${conv.title}\n` : "";

		let wtLine = "";
		if (conv.subagentWorktree) {
			const wt = conv.subagentWorktree;
			if (wt.cleanedUp) {
				wtLine = `  - ${pick(lang, "工作树隔离", "Worktree isolation", "subagents.notify.worktree")}: ${pick(lang, "无文件修改，临时工作树已自动清理", "No changes made; temporary worktree cleaned up", "subagents.notify.worktree.cleaned")}\n`;
			} else {
				wtLine =
					`  - ${pick(lang, "工作树隔离", "Worktree isolation", "subagents.notify.worktree")}: ` +
					pick(
						lang,
						`已保留分支 ${wt.branch}（${wt.uncommittedCount ?? 0} 处未提交修改，${wt.aheadCount ?? 0} 个新提交）`,
						`Preserved branch ${wt.branch} (${wt.uncommittedCount ?? 0} uncommitted, ${wt.aheadCount ?? 0} commits ahead)`,
						"subagents.notify.worktree.preserved",
						{ branch: wt.branch, uncommitted: wt.uncommittedCount ?? 0, ahead: wt.aheadCount ?? 0 },
					) +
					`\n  - ${pick(lang, "工作树路径", "Worktree path", "subagents.notify.worktree.path")}: ${wt.worktreePath}\n`;
			}
		}

		return `- **${sId}**（${metaTag}）— ${statusLabel}\n${taskLine}${wtLine}  - ${pick(lang, "产出摘要", "Summary", "subagents.notify.summary")}:\n${indentedConclusion}`;
	});

	const footer = pick(
		lang,
		'\n如需调取子代理完整对话转录与工具执行详情，可调用 subagent(action="get_result", runId="<id>")。',
		'\nFor full transcripts or detailed tool logs, call subagent(action="get_result", runId="<id>").',
		"subagents.notify.footer",
	);

	return `${fallbackNote}${titleHeader}\n\n${items.join("\n\n")}${footer}`;
}
