/**
 * patch-extension-runner — 会话退役后不再拿「死掉的 ExtensionRunner」跑每轮钩子（#958）。
 *
 * 背景：SDK 的 `AgentSession.dispose()` 只给 runner 打 `staleMessage` 标记（`invalidate()`），
 * 但 `sdk.js` 里的 `extensionRunnerRef.current` 仍指向那个 runner，而 `transformContext`
 * 只判 `if (!runner)`。于是「已 dispose 的会话被再喂一轮」时，每一轮都会：
 *   1. `emitContext()` 对整份 transcript 做一次 `structuredClone`（白烧 CPU / 内存不回收）；
 *   2. 逐个扩展调用 handler，每个 handler 一碰 `ctx.*` 就抛 `stale`，于是每轮每扩展一条带完整堆栈的报错
 *      （实测单会话 3,659 条、日志 9.7 MB）；
 *   3. `emitToolCall()` 没有 per-handler try/catch，stale 抛错还会直接炸工具调用。
 *
 * 正确修法在上游（#958 的建议 1、2），但 SDK 是外置 peer 依赖、用户随时可能换成更新的副本，
 * 等上游发版不可控。所以这里沿用本仓库既有的做法（`patch-bash-process.ts` / `patch-executable-lookup.ts`）：
 * 在 Node 模块加载钩子里**只改写内存中的 SDK 源码**，不写 node_modules，未识别的上游结构告警而不静默假定已修复。
 *
 * 三处改写：
 *   - `core/extensions/runner.js#emitContext`：先判 `staleMessage` → 直接返回原 messages（不 clone、不遍历）；
 *   - `core/extensions/runner.js#emitToolCall`：先判 `staleMessage` → 直接 `{ block: true }`
 *     （退役会话既不执行工具、也不让审批/沙箱门槛被静默跳过，不抛错）；
 *   - `core/agent-session.js#dispose`：顺手清掉 `_extensionRunnerRef.current`，让 `sdk.js` 的
 *     `if (!runner) return messages` 真正生效（上游修好后本补丁自动退化为 `already`）。
 */
import { registerHooks } from "node:module";

export const SENTINEL = "// pi-web-ui #958: retired extension runner guard v1";

export type ExtensionRunnerPatchStatus = "patched" | "already" | "unsupported";

export const EMIT_CONTEXT_HEAD = `    async emitContext(messages) {\n        const ctx = this.createContext();\n        let currentMessages = structuredClone(messages);\n`;

export const EMIT_CONTEXT_GUARDED = `    async emitContext(messages) {\n        // #958: a retired session must not clone the transcript or walk extensions.\n        if (this.staleMessage) return messages;\n        const ctx = this.createContext();\n        let currentMessages = structuredClone(messages);\n`;

export const EMIT_TOOL_CALL_HEAD = `    async emitToolCall(event) {\n        const ctx = this.createContext();\n        let result;\n`;

export const EMIT_TOOL_CALL_GUARDED = `    async emitToolCall(event) {\n        // #958: a retired session must never run tools with its gates silently skipped; block instead of throwing.\n        if (this.staleMessage) return { block: true, reason: "This session was retired; tool calls are blocked." };\n        const ctx = this.createContext();\n        let result;\n`;

export const DISPOSE_HEAD = `        this._disconnectFromAgent();\n        this._eventListeners = [];\n`;

export const DISPOSE_GUARDED = `        // #958: the runner reference must not outlive dispose(), or every later turn reuses it.\n        if (this._extensionRunnerRef) this._extensionRunnerRef.current = undefined;\n        this._disconnectFromAgent();\n        this._eventListeners = [];\n`;

/** 上游自己修好之后的特征（此时不再改写，也不再告警）。 */
const UPSTREAM_CONTEXT_GUARD = "if (this.staleMessage) return messages;";
const UPSTREAM_REF_CLEAR = "_extensionRunnerRef.current = undefined";

function occurrences(source: string, needle: string): number {
	return source.split(needle).length - 1;
}

export function patchExtensionRunnerSource(source: string): { code: string; status: ExtensionRunnerPatchStatus } {
	if (source.includes(SENTINEL)) return { code: source, status: "already" };
	if (source.includes(UPSTREAM_CONTEXT_GUARD)) return { code: source, status: "already" };
	if (occurrences(source, EMIT_CONTEXT_HEAD) !== 1 || occurrences(source, EMIT_TOOL_CALL_HEAD) !== 1) {
		return { code: source, status: "unsupported" };
	}
	const code = source
		.replace(EMIT_CONTEXT_HEAD, EMIT_CONTEXT_GUARDED)
		.replace(EMIT_TOOL_CALL_HEAD, EMIT_TOOL_CALL_GUARDED);
	return { code: `${code}\n${SENTINEL}\n`, status: "patched" };
}

export function patchAgentSessionDisposeSource(source: string): {
	code: string;
	status: ExtensionRunnerPatchStatus;
} {
	if (source.includes(SENTINEL) || source.includes(UPSTREAM_REF_CLEAR)) return { code: source, status: "already" };
	if (occurrences(source, DISPOSE_HEAD) !== 1) return { code: source, status: "unsupported" };
	return { code: `${source.replace(DISPOSE_HEAD, DISPOSE_GUARDED)}\n${SENTINEL}\n`, status: "patched" };
}

export type ExtensionRunnerPatchTarget = "extension-runner" | "agent-session";

/** 只认 pi-coding-agent 的 dist 产物；其它 url 一律不碰。 */
export function extensionRunnerPatchTarget(url: string): ExtensionRunnerPatchTarget | null {
	const path = url.replaceAll("\\", "/");
	if (!path.includes("/@earendil-works/pi-coding-agent/dist/core/")) return null;
	if (path.endsWith("/core/extensions/runner.js")) return "extension-runner";
	if (path.endsWith("/core/agent-session.js")) return "agent-session";
	return null;
}

export function applyExtensionRunnerPatch(
	source: string,
	target: ExtensionRunnerPatchTarget,
): { code: string; status: ExtensionRunnerPatchStatus } {
	return target === "extension-runner" ? patchExtensionRunnerSource(source) : patchAgentSessionDisposeSource(source);
}

export function registerExtensionRunnerPatch(): void {
	registerHooks({
		load(url, context, nextLoad) {
			const target = extensionRunnerPatchTarget(url);
			if (!target) return nextLoad(url, context);
			const loaded = nextLoad(url, context);
			if (loaded.source == null) return loaded;
			const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
			const result = applyExtensionRunnerPatch(source, target);
			if (result.status === "unsupported") {
				// 不静默假定已修复：stale 复读会以「每轮每扩展一条」的速率外溢，必须让人看见。
				console.warn(`[extension-runner] #958 stale-session guard NOT applied (unrecognized SDK source): ${url}`);
				return loaded;
			}
			return result.status === "patched" ? { ...loaded, source: result.code } : loaded;
		},
	});
}
