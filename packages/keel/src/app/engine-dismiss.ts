import { isPseudoClientId } from "../client-id-utils.js";
import type { ServerMessage } from "../protocol.js";
import type { ClientRuntime } from "./client-runtime.js";

export interface DismissDeps {
	runtimes: Map<string, ClientRuntime>;
	sockets: Map<string, Set<unknown>>;
	deliverTo(clientId: string, msg: ServerMessage): void;
	cleanupOfflineRuntime(ownerId: string, ownerRuntime: ClientRuntime): void;
	notifyExternalRunning(ownerId: string): void;
}

export async function executeDismissConversation(
	deps: DismissDeps,
	clientId: string,
	msg: { id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string },
): Promise<boolean> {
	const requester = deps.runtimes.get(clientId);
	if (requester?.registry.has(msg.id)) {
		await requester.handlers().dismissConversation(msg.id, msg.withFinishedSubagents);
		return true;
	}
	let ownerId: string | undefined;
	let ownerRuntime: ClientRuntime | undefined;
	if (msg.owner) {
		const candidate = deps.runtimes.get(msg.owner);
		if (candidate?.registry.has(msg.id)) {
			ownerId = msg.owner;
			ownerRuntime = candidate;
		}
	}
	if (!ownerRuntime) {
		for (const [cid, rt] of deps.runtimes) {
			if (rt.registry.has(msg.id)) {
				ownerId = cid;
				ownerRuntime = rt;
				break;
			}
		}
	}
	if (!ownerId || !ownerRuntime) {
		deps.deliverTo(clientId, {
			type: "notice",
			level: "warning",
			text: "该对话不存在或已关闭",
			textEn: "This conversation does not exist or is already closed",
		});
		return false;
	}
	const isOffline = !isPseudoClientId(ownerId) && (deps.sockets.get(ownerId)?.size ?? 0) === 0;
	if (isOffline && ownerRuntime.registry.list().length <= 1) {
		deps.cleanupOfflineRuntime(ownerId, ownerRuntime);
	} else {
		await ownerRuntime.handlers().dismissConversation(msg.id, msg.withFinishedSubagents);
	}
	deps.notifyExternalRunning(ownerId);
	return true;
}
