import { DELEGATION_SYSTEM_PROMPT } from "./delegate-mode.js";
import { buildPlanModePrompt } from "./plan-mode.js";
import { buildRemoteWorkspacePersona } from "./remote-ssh-service.js";

/**
 * 平台 / 模式约束：沙盒隔离、远程工作区、计划模式、审查者模式。
 *
 * 这些是**运行态**约束（不是用户内容），必须每个请求都到模型面前，且只到一次。
 * 生产只在本文件，落点只有一处（persona hook 出口，主会话与回退路径共用）。
 *
 * 历史事故（与 issue #999 同一病根）：它们原本只塞进 loader 的 append 段，而主会话
 * 一旦走组合模板（出厂就一直在走），append 段整体被替换掉 → 模型不知道自己处在
 * 计划模式，沙盒 / 远程工作区的约束也一起消失，只剩工具闸门在拒绝调用。
 */

export interface SandboxConstraint {
	name: string;
	path: string;
	sourcePath?: string;
}

export interface PlatformConstraintInput {
	/** 当前执行身份是否在沙盒里（`undefined` = 不在沙盒）。 */
	sandbox?: SandboxConstraint;
	/** 远程 SSH 工作区 URI（本地项目为 `undefined`）。 */
	remoteCwd?: string;
	planMode?: boolean;
	delegateMode?: boolean;
	/** 计划模式提示词跟随设置（append = 官方段 + 自定义，replace = 只用自定义）。 */
	planPrompt?: { mode: "append" | "replace"; custom: string };
}

function sandboxText(sandbox: SandboxConstraint): string {
	return (
		`[Sandbox Isolation Mode] You are operating inside an isolated sandbox workspace "${sandbox.name}" at "${sandbox.path}".` +
		(sandbox.sourcePath
			? ` This sandbox is an isolated copy of "${sandbox.sourcePath}". NEVER read from or modify "${sandbox.sourcePath}" directly; make all changes exclusively within the current sandbox directory "${sandbox.path}".`
			: ` Keep all file operations strictly inside "${sandbox.path}".`) +
		" Only restricted local file editing is supported. Shell commands, scripts, terminals, evaluation, and unknown tools are unavailable without an OS isolation backend."
	);
}

/** 顺序固定：沙盒 → 远程 → 计划 / 审查者（计划模式优先，审查者模式不再叠加）。 */
export function buildPlatformConstraints(input: PlatformConstraintInput): string[] {
	const out: string[] = [];
	if (input.sandbox) out.push(sandboxText(input.sandbox));
	if (input.remoteCwd) out.push(buildRemoteWorkspacePersona(input.remoteCwd));
	if (input.planMode) {
		const plan = input.planPrompt ?? { mode: "append" as const, custom: "" };
		out.push(buildPlanModePrompt(plan.mode, plan.custom));
	} else if (input.delegateMode) {
		out.push(DELEGATION_SYSTEM_PROMPT);
	}
	return out;
}

/** 把约束接到组装结果末尾：空列表是零改动（不能给等值文本制造 diff）。 */
export function appendConstraints(text: string, constraints: readonly string[]): string {
	const parts = constraints.map((c) => c.trim()).filter(Boolean);
	if (parts.length === 0) return text;
	return `${text.trimEnd()}\n\n${parts.join("\n\n")}`;
}
