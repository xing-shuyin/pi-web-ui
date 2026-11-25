import type { TransportPort } from "../../contracts/ports.js";
import { SCM_COMMITMSG_UNWIRED, type ScmCommitMessagePort, type ScmCommitMessageResult } from "../../contracts/scm.js";
import type { ServerMessage } from "../../protocol.js";

export interface ScmHandlersOptions {
	/** 缺省 = 未接：回一帧 `ok: false`（文案 `SCM_COMMITMSG_UNWIRED`），不抛。 */
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
 * **三条失败路径都给帧**：端口自己抛错、端口没注入、宿主回 `ok: false`（没模型 / 干净工作区 / 超时）——
 * 前端永远等得到回执；不发帧只允许一种情况：`isClosed()`（通道都关了）。
 */
export function createScmHandlers(options: ScmHandlersOptions): ScmHandlers {
	/**
	 * 解析端口：宿主没接（含装配漏了那一行）也**不抛**——`scm_commitmsg` 的契约是「必回一帧」，
	 * 抛给分发层只会被记一行日志，前端那边就是一帧都没有（`scm_data` 永不到）。
	 */
	const port = (what: string): ScmCommitMessagePort | undefined => {
		const target = options.scm?.();
		if (!target) console.warn(`[core] ${what}: ${SCM_COMMITMSG_UNWIRED}`);
		return target;
	};
	const send = (msg: ServerMessage): void => {
		if (options.transport.isClosed()) return;
		options.transport.send(msg);
	};
	const generate = async (reqId: number): Promise<void> => {
		let result: ScmCommitMessageResult;
		const target = port("scmGenCommitMessage");
		if (!target) {
			result = { ok: false, error: SCM_COMMITMSG_UNWIRED };
		} else {
			try {
				result = await target.generateCommitMessage({ cwd: options.cwd() });
			} catch (error) {
				result = { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		send({ type: "scm_data", reqId, kind: "commitmsg", ...result });
	};

	return {
		// 不管端口在不在，这个方法都只 resolve、不 reject（分发层 `void` 调用，reject = 无声）。
		scmGenCommitMessage(reqId: number): Promise<void> {
			return generate(reqId);
		},
	};
}
