/**
 * SCM 提交信息生成面（宿主能力）。
 *
 * 老实现 `ClientSession.scmGenCommitMessage`（`server/agent-service.ts`）就是两件事：
 * 1. 采集改动 —— `generateScmCommitMessage`（`server/scm-commitmsg.ts`）内部走 `scmCommitContext`
 *    （git 状态 / 最近提交主题 / 暂存与工作区 diff），不是仓库、工作区干净都在那里判定；
 * 2. **独立于对话的一次模型推断** —— `runtime.completeSimple(model, {systemPrompt, messages}, …)`，
 *    不是一轮 agent turn（不进转录、不做工具调用、不碰会话）。
 *
 * 两件都归宿主：
 * - 模型选型与凭证（`auth.json` / `models.json`、`ModelRuntime`）只有宿主有；
 * - 提示词口径（设置项 `scmCommitMsgPromptMode` / `scmCommitMsgPrompt`）也只有宿主有。
 *
 * 内核只做两件事：把当前对话的 cwd 递进来、把结果拼成一帧 `scm_data`（`kind: "commitmsg"`）发出去。
 * 宿主侧适配器：`server/core-scm-adapter.ts`（结构直通 `server/scm-commitmsg.ts`）。
 */

/** 生成结果：失败也是回执（老实现从不 reject，前端只认这一帧）。 */
export type ScmCommitMessageResult = { ok: true; text: string } | { ok: false; error: string };

export interface ScmCommitMessageInput {
	/** 采集改动的工作目录（当前对话的 cwd）。 */
	cwd: string;
}

export interface ScmCommitMessagePort {
	/**
	 * 按 `cwd` 采集改动并让模型写一条提交信息（一句话主题行）。
	 *
	 * 失败一律 `{ ok: false, error }`：没有可用模型、工作区干净、路径不是 git 仓库、模型空回、超时
	 * 都是这条路径（老实现同一个口径，文案在宿主）。
	 * 出帧：**内核**（`scm_data` / `kind: "commitmsg"`）—— 回执的形状是协议，不该由宿主拼两份。
	 */
	generateCommitMessage(input: ScmCommitMessageInput): Promise<ScmCommitMessageResult>;
}
