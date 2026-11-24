import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { ScmCommitMessagePort, ScmCommitMessageResult } from "../../contracts/scm.js";
import type { ServerMessage } from "../../protocol.js";

export interface ScmHandlersOptions {
	/** 缺省 = 未接：`scmGenCommitMessage` 调到时同步抛 `CoreEngineNotReadyError`。 */
	scm?: () => ScmCommitMessagePort | undefined;
	transport: TransportPort;
	/** 采集改动的工作目录（当前对话的 cwd，与 `scmQuery` 同一口径）。 */
	cwd: () => string;
}

/** SCM 提交信息面的 1 个 handler：签名与 `DispatchSession` 的同名成员一致。 */
export interface ScmHandlers {
	scmGenCommitMessage(reqId: number): Promise<void>;
}

/**
 * 内核这一段只有「转发 + 发帧」：git 采集、模型选型、凭证、提示词口径、清洗与超时全在宿主端口
 * （`server/scm-commitmsg.ts`，宿主适配器 `server/core-scm-adapter.ts`）。
 *
 * 帧形状与 `scmQuery` 那四支同一支 `scm_data`（`kind: "commitmsg"`）：老实现就是
 * `send({ type: "scm_data", reqId, kind: "commitmsg", ok, …extra })`，回执只有一个出口。
 * 端口自己抛错也不让前端空等：照样回一帧 `ok: false`（老实现 `fail()` 分支同口径）。
 */
export function createScmHandlers(options: ScmHandlersOptions): ScmHandlers {
	const port = (what: string): ScmCommitMessagePort => {
		const target = options.scm?.();
		if (!target) throw new CoreEngineNotReadyError(what);
		return target;
	};
	const send = (msg: ServerMessage): void => {
		if (options.transport.isClosed()) return;
		options.transport.send(msg);
	};
	const generate = async (target: ScmCommitMessagePort, reqId: number): Promise<void> => {
		const cwd = options.cwd();
		let result: ScmCommitMessageResult;
		try {
			result = await target.generateCommitMessage({ cwd });
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		send({ type: "scm_data", reqId, kind: "commitmsg", ...result });
	};

	return {
		// 同步方法体：端口解析在**调用时**发生（未注入 → 同步抛，不变 rejected promise）。
		scmGenCommitMessage(reqId: number): Promise<void> {
			return generate(port("scmGenCommitMessage"), reqId);
		},
	};
}
