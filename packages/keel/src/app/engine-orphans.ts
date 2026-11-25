import type { ClientRuntime } from "./client-runtime.js";
import type { FrameSender } from "./core-engine.js";
import { pickAdoptableOrphan, type OrphanCandidate } from "../orphan-manager.js";
import { isOrphanAdoptionExcludedClientId } from "../client-id-utils.js";

/**
 * 寻找可认领的孤儿子进程（所有活连接断开、且留有 streaming 或已列出会话的客户端）。
 * 选号规则唯一单源在 `orphan-manager.ts` 的 `pickAdoptableOrphan()`。
 */
export function findAdoptableOrphan(
	runtimes: ReadonlyMap<string, ClientRuntime>,
	sockets: ReadonlyMap<string, Set<FrameSender>>,
	excludeClientId: string,
): { oldId: string; runtime: ClientRuntime } | null {
	const cands: OrphanCandidate[] = [];
	for (const [id, runtime] of runtimes) {
		if (id === excludeClientId) continue;
		const pseudo = isOrphanAdoptionExcludedClientId(id);
		const live = (sockets.get(id)?.size ?? 0) > 0;
		let streaming = 0;
		let adoptable = false;
		let activity = 0;
		if (!pseudo && !live) {
			for (const conv of runtime.registry.list()) {
				if (conv.phase === "running") streaming++;
				if (conv.meta.kind !== "subagent") {
					if (conv.meta.sessionFile || conv.phase === "running" || conv.meta.title !== "新对话") {
						adoptable = true;
					}
				}
				activity = Math.max(activity, conv.meta.lastActiveAt || 0);
			}
		}
		cands.push({ id, live, pseudo, streaming, adoptable, activity });
	}
	const picked = pickAdoptableOrphan(cands);
	if (!picked) return null;
	const orphanRuntime = runtimes.get(picked);
	return orphanRuntime ? { oldId: picked, runtime: orphanRuntime } : null;
}
