import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CoreScmCommitMessageSinks } from "../packages/keel/src/app/core-engine.js";
import type { ScmCommitMessagePort } from "../packages/keel/src/contracts/scm.js";
import type { ClientStateStore } from "./client-state.js";
import { generateScmCommitMessageForCurrent } from "./scm-commitmsg.js";

export interface CoreScmCommitMessageOptions {
	/** 会话 / 模型目录的根（`auth.json` / `models.json` 在它下面）。 */
	agentDir: string;
	/** 设置存储：提示词口径（`scmCommitMsgPromptMode` / `scmCommitMsgPrompt`）从这里读。 */
	stateStore: ClientStateStore;
}

/**
 * 宿主侧适配器：把 `generateScmCommitMessage`（`server/scm-commitmsg.ts`）按 `ScmCommitMessagePort`
 * 交给内核。
 *
 * 结构直通：端口方法就是老实现 `ClientSession.scmGenCommitMessage` 里那段「取模型 → 校验 → 一次独立推断」，
 * 只少了帧（`scm_data` / `kind: "commitmsg"` 由内核按 `reqId` 发）。git 采集、提示词拼装、
 * 超时、结果清洗全在既有叶子里，这里不重写一行语义。
 *
 * 模型运行时与凭证是宿主知识：懒建一份（`ModelRuntime` 读 `agentDir` 下的 `auth.json` / `models.json`），
 * 内核既不认识它，也拿不到它。选型走 sink 里报的「当前对话正在用的模型」。
 */
export function createCoreScmCommitMessage(
	options: CoreScmCommitMessageOptions & CoreScmCommitMessageSinks,
): ScmCommitMessagePort {
	let runtime: Promise<ModelRuntime> | undefined;
	const runtimeOf = (): Promise<ModelRuntime> =>
		(runtime ??= ModelRuntime.create({
			authPath: join(options.agentDir, "auth.json"),
			modelsPath: join(options.agentDir, "models.json"),
		}));

	return {
		async generateCommitMessage(input) {
			// 提示词口径每次现读：用户在设置里改完立刻生效（不取构造期快照）。
			const settings = options.stateStore.getSettingsSnapshot(options.clientId);
			return generateScmCommitMessageForCurrent({
				cwd: input.cwd,
				model: options.sessionModel(),
				runtime: await runtimeOf(),
				lang: options.getLang(),
				promptMode: settings.scmCommitMsgPromptMode === "replace" ? "replace" : "append",
				customPrompt: settings.scmCommitMsgPrompt ?? "",
			});
		},
	};
}
