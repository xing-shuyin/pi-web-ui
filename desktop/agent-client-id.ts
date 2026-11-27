import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_CLIENT_ID_FILENAME = "agent-client-id";
export const AGENT_CLIENT_ID_ARG_PREFIX = "--pi-agent-client-id=";

const VALID_CLIENT_ID_RE = /^[a-zA-Z0-9._-]{8,128}$/;

export function isValidAgentClientId(value: string | null | undefined): value is string {
	return typeof value === "string" && VALID_CLIENT_ID_RE.test(value.trim());
}

/**
 * 为桌面端主 Agent 视图持久化一个端侧唯一的 `clientId`（存在 `userData` 下）。
 *
 * 为什么不能用全局写死常量（如 `"desktop"`）：两台电脑连同一远程内核时会撞 `clientId`。
 * 为什么不靠前端 `localStorage`：内置浏览器里新开标签页会共享同一 origin 的 `localStorage`，
 * 会和主 Agent 视图抢同一个会话；放到 `userData` 并仅注入给主 Agent `WebContentsView` 可两全。
 */
export function resolveOrCreateAgentClientId(userDataDir: string): string {
	const filePath = join(userDataDir, AGENT_CLIENT_ID_FILENAME);
	try {
		const existing = readFileSync(filePath, "utf8").trim();
		if (isValidAgentClientId(existing)) return existing;
	} catch {}
	const generated = randomUUID();
	try {
		mkdirSync(userDataDir, { recursive: true });
		writeFileSync(filePath, `${generated}\n`, "utf8");
	} catch {}
	return generated;
}

export function formatAgentClientIdArg(clientId: string): string {
	return `${AGENT_CLIENT_ID_ARG_PREFIX}${clientId}`;
}

export function parseAgentClientIdArg(argv: readonly string[]): string | undefined {
	for (const arg of argv) {
		if (!arg.startsWith(AGENT_CLIENT_ID_ARG_PREFIX)) continue;
		const id = arg.slice(AGENT_CLIENT_ID_ARG_PREFIX.length).trim();
		if (isValidAgentClientId(id)) return id;
	}
	return undefined;
}
