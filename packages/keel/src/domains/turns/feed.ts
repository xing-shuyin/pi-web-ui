import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { promptSession, steerSession } from "../../session-turns.js";
import type { TurnCapableSession } from "../../contracts/session.js";

/**
 * 新树里唯一碰 SDK 喂轮入口的地方：`server/session-turns.ts` 仍是唯一出口（#958），
 * 这里只把窄面收回到 SDK 类型，让其它域不必依赖 SDK。
 */
export function feedTurn(session: TurnCapableSession, text: string, deliverAs?: "steer" | "followUp"): Promise<void> {
	return promptSession(session as unknown as AgentSession, text, deliverAs ? { deliverAs } : {});
}

export function feedSteer(session: TurnCapableSession, text: string): Promise<void> {
	return steerSession(session as unknown as AgentSession, text);
}
