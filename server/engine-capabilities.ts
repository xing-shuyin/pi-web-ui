import type { AgentEngineCapabilities } from "./protocol.js";

export const DEFAULT_PI_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: true,
	sandboxes: true,
	workspaceRoots: true,
	conversationRef: true,
	pageRef: true,
	presentFiles: true,
	planMode: true,
	delegateMode: true,
	subagents: true,
	toolPromptOverride: true,
	lazyTools: true,
	softCap: true,
	treeFork: true,
	messageEdit: true,
	steer: true,
	ephemeralChat: true,
});

export const DEFAULT_DSH_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: false,
	sandboxes: false,
	workspaceRoots: false,
	conversationRef: false,
	pageRef: false,
	presentFiles: false,
	planMode: false,
	delegateMode: false,
	subagents: false,
	toolPromptOverride: false,
	lazyTools: false,
	softCap: false,
	treeFork: false,
	messageEdit: false,
	steer: false,
	ephemeralChat: false,
});

export const DEFAULT_UNIVERSAL_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: false,
	sandboxes: false,
	workspaceRoots: false,
	conversationRef: false,
	pageRef: false,
	presentFiles: false,
	planMode: false,
	delegateMode: false,
	subagents: true,
	toolPromptOverride: false,
	lazyTools: false,
	softCap: false,
	treeFork: false,
	messageEdit: false,
	steer: false,
	ephemeralChat: true,
});

export const DEFAULT_DURABLE_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: false,
	sandboxes: false,
	workspaceRoots: true,
	conversationRef: true,
	pageRef: true,
	presentFiles: true,
	planMode: false,
	delegateMode: false,
	subagents: true,
	toolPromptOverride: false,
	lazyTools: false,
	softCap: false,
	treeFork: true,
	messageEdit: true,
	steer: true,
	ephemeralChat: true,
});

export function resolveEngineCapabilities(
	caps?: Partial<AgentEngineCapabilities> | null,
	base: AgentEngineCapabilities = DEFAULT_UNIVERSAL_CAPABILITIES,
): AgentEngineCapabilities {
	return {
		...base,
		...caps,
	};
}
