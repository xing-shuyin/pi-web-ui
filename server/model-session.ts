import { createHash, randomUUID } from "node:crypto";

/**
 * Provider session id for calls that bypass `AgentSession`.
 *
 * The SDK only fills `options.sessionId` inside the agent loop; direct `ModelRuntime` callers
 * must supply it themselves. Relay gateways (opencode / opencode-go) reject requests without the
 * derived `x-opencode-session` routing header with `400 MissingSessionID`.
 *
 * Pass a stable seed for multi-turn conversations so follow-ups keep the same route and prompt
 * cache; omit it for one-shot calls.
 */
export function modelSessionId(seed?: string): string {
	if (!seed) return `pi-web-${randomUUID()}`;
	return `pi-web-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}
