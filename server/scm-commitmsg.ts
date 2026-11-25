import { isNotRepoError, scmCommitContext, type ScmCommitContext } from "./scm.js";
import { pick, type ServerLang } from "./i18n.js";
import { modelSessionId } from "./model-session.js";

export const SCM_COMMITMSG_TIMEOUT_MS = 60_000;

export const MAX_COMMITMSG_LEN = 200;

/**
 * 一次独立推断需要宿主模型运行时的那两支（结构类型，不引 SDK）：
 * `completeSimple` 做推断，`getModel` 用于按 provider/id 选型（core 适配器走这一支）。
 */
export interface ScmCommitRuntime {
	completeSimple: (
		model: any,
		context: any,
		options?: any,
	) => Promise<{
		stopReason: string;
		errorMessage?: string;
		content: Array<{ type: string; text?: string }>;
	}>;
	getModel?: (provider: string, id: string) => unknown;
}

/** 「先选模型」的错：老实现 `agent-service.ts` 里那句（core 侧同一句话，不另写一套文案）。 */
export function noScmCommitModelMessage(lang: ServerLang): string {
	return pick(
		lang,
		"当前没有可用模型——先在顶栏选择一个模型再生成",
		"No model available — pick one in the top bar first",
		"scm.commitmsg.no.model",
	);
}

/**
 * 宿主侧「选型 + 一次独立推断」：core 适配器（`server/core-scm-adapter.ts`）只用这一个入口，
 * 免得把「按 provider/id 取模型 → 校验 → 调用」在宿主里再抄一遍。
 *
 * 老实现直接拿 `conv.session?.model`（就是同一个 SDK 模型对象）；core 的会话模型在 keel 里，
 * 宿主只知道 provider/id，所以这里按 id 从**宿主自己的**模型运行时里取——凭证与目录都归它。
 *
 * `runtime` 是 thunk：**先选型、后建运行时**。没模型时不该去碰 SDK（建不出来/目录坏了都不影响
 * 「先在顶栏选择模型」这条回执），也免得把一个失败的建实例挂在缓存上。
 */
export async function generateScmCommitMessageForCurrent(opts: {
	cwd: string;
	/** 当前对话正在用的模型（没选过 = undefined → 「先在顶栏选择模型」）。 */
	model: { provider: string; id: string } | undefined;
	/** 懒取宿主模型运行时（只有真要推断时才调）。 */
	runtime: () => Promise<ScmCommitRuntime>;
	lang: ServerLang;
	promptMode?: "append" | "replace";
	customPrompt?: string;
	timeoutMs?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	const { cwd, model, runtime, lang, promptMode, customPrompt, timeoutMs } = opts;
	if (!model) return { ok: false, error: noScmCommitModelMessage(lang) };
	const resolvedRuntime = await runtime();
	const resolved = resolvedRuntime.getModel?.(model.provider, model.id);
	if (!resolved) return { ok: false, error: noScmCommitModelMessage(lang) };
	return generateScmCommitMessage({
		cwd,
		model: resolved,
		runtime: resolvedRuntime,
		lang,
		...(promptMode ? { promptMode } : {}),
		...(customPrompt ? { customPrompt } : {}),
		...(timeoutMs ? { timeoutMs } : {}),
	});
}

const MAX_FILE_LINES = 200;

export const COMMITMSG_SYSTEM_PROMPT = `You write git commit messages. You receive the pending changes of a repository and output exactly one commit message: a single subject line.

Rules:
1. Match the style, format and language of the repository's recent commit subjects when provided — conventional commits ("type(scope): summary"), prefixes, punctuation, language: copy what the repo actually does.
2. Describe what the change does at a glance (the user-facing effect), not a file-by-file listing.
3. The staged diff is the subject of the commit. Describe staged changes when any exist; otherwise describe the unstaged and untracked changes shown.
4. One line. No quotes, no markdown, no code fences, no "Commit message:" label, no explanation. Under 72 characters when the repository's language allows it (CJK text may naturally be shorter).
5. Never invent scope names, issue numbers or details not visible in the provided material.
6. If the repository has no commits yet, write the message in the language stated in the request.

Output ONLY the subject line.`;

export function buildCommitMsgPrompt(mode: "append" | "replace", custom: string): string {
	const text = custom?.trim() ?? "";
	if (mode === "replace" && text) return text;
	if (text) return `${COMMITMSG_SYSTEM_PROMPT}\n\n${text}`;
	return COMMITMSG_SYSTEM_PROMPT;
}

function formatNumStat(stat: Record<string, [number, number]>): string[] {
	return Object.keys(stat)
		.sort()
		.map((p) => `+${stat[p][0]}/-${stat[p][1]} ${p}`);
}

export function buildCommitMsgInput(ctx: ScmCommitContext, fallbackLang: "zh" | "en"): string | null {
	const parts: string[] = [];

	if (ctx.subjects.length > 0) {
		parts.push("Recent commit subjects (newest first — style reference):");
		parts.push(...ctx.subjects.map((s) => `- ${s}`));
	} else {
		parts.push(
			fallbackLang === "zh"
				? "（仓库还没有任何提交；请用中文写这条提交信息）"
				: "(The repository has no commits yet; write this commit message in English.)",
		);
	}

	if (ctx.files.length > 0) {
		const shown = ctx.files.slice(0, MAX_FILE_LINES);
		const more = ctx.files.length - shown.length;
		parts.push("Changed files (porcelain status):");
		parts.push(...shown.map((f) => `${f.x}${f.y} ${f.path}`));
		if (more > 0) parts.push(`… (+${more} more files)`);
	}

	if (ctx.stagedPatch.trim()) {
		parts.push("Staged diff (these changes are the commit's subject):");
		if (Object.keys(ctx.stagedStat).length > 0) {
			parts.push(...formatNumStat(ctx.stagedStat));
		}
		parts.push(ctx.stagedPatch);
	}

	if (ctx.worktreePatch.trim()) {
		parts.push("Unstaged diff (worktree only):");
		if (Object.keys(ctx.worktreeStat).length > 0) {
			parts.push(...formatNumStat(ctx.worktreeStat));
		}
		parts.push(ctx.worktreePatch);
	}

	const untracked = ctx.files.filter((f) => f.x === "?" && f.y === "?");
	if (untracked.length > 0 && !ctx.stagedPatch.trim()) {
		parts.push(
			`Untracked files (new, content not shown): ${untracked
				.map((f) => f.path)
				.join(", ")
				.slice(0, 2000)}`,
		);
	}

	if (!ctx.stagedPatch.trim() && !ctx.worktreePatch.trim() && untracked.length === 0) return null;
	return parts.join("\n");
}

export function sanitizeCommitMessage(raw: string): string {
	let text = raw.trim();
	const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
	if (fence) text = fence[1].trim();
	text = text.replace(/^(commit(\s+message)?|subject|提交信息|提交消息|提交说明)\s*[:：]\s*/i, "");
	const firstLine =
		text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";
	let out = firstLine.replace(/\s+/g, " ").trim();
	if (out.length >= 2) {
		const a = out[0];
		const b = out[out.length - 1];
		if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === "`" && b === "`")) {
			out = out.slice(1, -1).trim();
		}
	}
	if (out.length > MAX_COMMITMSG_LEN) out = `${out.slice(0, MAX_COMMITMSG_LEN - 1).trimEnd()}…`;
	return out;
}

export async function generateScmCommitMessage(opts: {
	cwd: string;
	model: any;
	runtime: ScmCommitRuntime;
	lang: ServerLang;
	promptMode?: "append" | "replace";
	customPrompt?: string;
	timeoutMs?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	const {
		cwd,
		model,
		runtime,
		lang,
		promptMode = "append",
		customPrompt = "",
		timeoutMs = SCM_COMMITMSG_TIMEOUT_MS,
	} = opts;

	try {
		const ctx = await scmCommitContext(cwd, () => lang);
		const input = buildCommitMsgInput(ctx, lang === "zh" ? "zh" : "en");
		if (!input) {
			return {
				ok: false,
				error: pick(
					lang,
					"没有可描述的更改（工作区干净）",
					"Nothing to describe (working tree clean)",
					"scm.commitmsg.no.changes",
				),
			};
		}

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		const systemPrompt = buildCommitMsgPrompt(promptMode, customPrompt);

		let msg: Awaited<ReturnType<typeof runtime.completeSimple>>;
		try {
			msg = await runtime.completeSimple(
				model,
				{
					systemPrompt,
					messages: [
						{
							role: "user",
							timestamp: Date.now(),
							content: [{ type: "text", text: input }],
						},
					],
				},
				{ signal: ac.signal, maxTokens: 400, sessionId: modelSessionId() },
			);
		} finally {
			clearTimeout(timer);
		}

		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			return {
				ok: false,
				error:
					msg.errorMessage ||
					pick(
						lang,
						`模型异常终止（${msg.stopReason}）`,
						`Model terminated abnormally (${msg.stopReason})`,
						"scm.commitmsg.model.terminated",
						{ stopReason: msg.stopReason },
					),
			};
		}

		const raw = msg.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { text?: string }).text ?? "")
			.join("\n");
		const text = sanitizeCommitMessage(raw);
		if (!text) {
			return {
				ok: false,
				error: pick(
					lang,
					"模型返回了空的提交信息",
					"The model returned an empty commit message",
					"scm.commitmsg.empty",
				),
			};
		}

		return { ok: true, text };
	} catch (err) {
		if (isNotRepoError(err)) {
			return {
				ok: false,
				error: pick(
					lang,
					"当前目录不是 Git 仓库",
					"Current directory is not a Git repository",
					"scm.commitmsg.not.repo",
				),
			};
		}
		if (err instanceof Error && /abort/i.test(`${err.name} ${err.message}`)) {
			const secs = Math.round(timeoutMs / 1000);
			return {
				ok: false,
				error: pick(
					lang,
					`生成提交信息超时（${secs} 秒）`,
					`Commit-message generation timed out (${secs}s)`,
					"scm.commitmsg.timeout",
					{ secs },
				),
			};
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
