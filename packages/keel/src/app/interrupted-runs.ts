import type { InterruptedRunRecord, SettingsStorePort } from "../contracts/settings-store.js";
import type { ClientRuntime } from "./client-runtime.js";

/**
 * 「此刻还在跑、且该被续跑」的对话 → 中断记录（老实现 `ClientSession.streamingSummaries()` 同口径）：
 * 只收正在跑的、不是子代理/子会话的对话——子代理由运行账本自己重启对账，当成普通标签页重开会重跑工具。
 * `sessionFile` 缺省就不带这一个键（续跑链路按它精确认领，空串与缺失在那边不等价）。
 */
export function interruptedRunsOf(runtime: ClientRuntime, at = Date.now()): InterruptedRunRecord[] {
	const out: InterruptedRunRecord[] = [];
	for (const conv of runtime.registry.list()) {
		if (conv.phase !== "running") continue;
		if (conv.meta.kind === "subagent" || conv.meta.parentId) continue;
		out.push({
			title: conv.meta.title,
			cwd: conv.meta.cwd,
			at,
			...(conv.meta.sessionFile ? { sessionFile: conv.meta.sessionFile } : {}),
		});
	}
	return out;
}

/**
 * 中断记账：把「此刻还在跑」的对话写进客户端状态的续跑列表（`client-state.json` 的 `interrupted`），
 * 口径与老实现 `AgentService.recordInterruptedRuns()` 一致（只记正在跑、非子代理/子会话的对话）。
 * 尽力而为：写失败一律吞掉（老实现整段 try/catch），记账失败不该把停机流程拖住。
 */
export function saveInterruptedRuns(stateStore: SettingsStorePort, runtimes: ReadonlyMap<string, ClientRuntime>): void {
	const save = stateStore.saveInterrupted;
	if (!save) return;
	for (const [clientId, runtime] of runtimes) {
		const runs = interruptedRunsOf(runtime);
		if (runs.length === 0) continue;
		try {
			save.call(stateStore, clientId, runs);
		} catch {}
	}
}
