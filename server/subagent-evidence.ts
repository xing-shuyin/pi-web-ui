/**
 * 子代理完成证据单源：子代理自述「做完了」不够，必须给出可核对的证据，
 * 而且证据要拿它自己的转录来对账（不是再问一遍模型）。
 *
 * 三层职责：
 *   · `normalizeEvidenceInput`：把模型传的 evidence 归一化并限量（不可信输入）。
 *   · `collectTranscriptFacts`：从子代理转录里抽「真的改过哪些文件、真的跑过哪些命令」。
 *   · `verifyEvidence`：对账，产出裁决 + 硬矛盾（驳回）/ 软疑点（降级为 partial）。
 *
 * 只做**可证伪**的判断：声称跑过的命令在转录里找不到 → 驳回；声称没改文件但转录有编辑 →
 * 驳回；声称改过的文件找不到写入调用 → 只记疑点（bash 里 sed/mv 也会改文件，不能一票否决）。
 */
import { SUBAGENT_WRITE_TOOL_NAMES } from "./subagent-security-gate.js";

export type SubagentEvidenceVerdict = "pass" | "partial" | "unverified" | "blocked";

export interface SubagentEvidenceInput {
	files?: string[];
	commands?: string[];
	none?: boolean;
	blocked?: string;
}

export interface SubagentEvidence {
	files: string[];
	commands: string[];
	none: boolean;
	blocked?: string;
	verdict: SubagentEvidenceVerdict;
	/** 硬矛盾：证据与转录冲突，完成请求被驳回。 */
	issues: string[];
	/** 软疑点：无法证实但也不能证伪，裁决降级为 partial。 */
	warnings: string[];
	matchedFiles: number;
	matchedCommands: number;
	reportedAt: number;
}

export interface TranscriptCommand {
	command: string;
	failed: boolean;
}

export interface TranscriptFacts {
	editedFiles: string[];
	commands: TranscriptCommand[];
}

export const EVIDENCE_LIMITS = {
	files: 50,
	commands: 20,
	fieldChars: 400,
	issueListed: 5,
	warningListed: 4,
} as const;

const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "shell", "sh", "run_command", "exec_command"]);

const PATH_KEYS = ["path", "file_path", "filePath", "file", "target", "dest", "destination"] as const;
const PATH_LIST_KEYS = ["paths", "files"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function oneLine(value: string, max = EVIDENCE_LIMITS.fieldChars): string {
	const s = value.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function normalizeCommandText(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

export function normalizeEvidencePath(path: string): string {
	const s = path.replace(/\\/g, "/").trim().replace(/^\.\//, "");
	return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

function normalizeList(raw: unknown, limit: number, normalize: (s: string) => string): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const value = normalize(oneLine(item));
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
		if (out.length >= limit) break;
	}
	return out;
}

export type NormalizedEvidence =
	{ ok: true; value: SubagentEvidenceInput } | { ok: false; error: "not_object" | "empty" | "invalid_fields" };

/** 归一化模型传入的 evidence；不做对账，只保证形状与上限。 */
export function normalizeEvidenceInput(raw: unknown): NormalizedEvidence {
	if (raw === undefined || raw === null) return { ok: true, value: {} };
	if (!isRecord(raw)) return { ok: false, error: "not_object" };
	const files = normalizeList(raw.files, EVIDENCE_LIMITS.files, normalizeEvidencePath);
	const commands = normalizeList(raw.commands, EVIDENCE_LIMITS.commands, normalizeCommandText);
	const none = raw.none === true;
	const blocked = typeof raw.blocked === "string" ? oneLine(raw.blocked) : undefined;
	if (Array.isArray(raw.files) && files.length === 0) return { ok: false, error: "invalid_fields" };
	if (Array.isArray(raw.commands) && commands.length === 0) return { ok: false, error: "invalid_fields" };
	if (!files.length && !commands.length && !none && !blocked) return { ok: false, error: "empty" };
	return { ok: true, value: { files, commands, none, blocked } };
}

function argsOf(block: Record<string, unknown>): Record<string, unknown> | undefined {
	const raw = block.args ?? block.arguments;
	if (isRecord(raw)) return raw;
	if (typeof raw === "string" && raw.trim()) {
		try {
			const parsed: unknown = JSON.parse(raw);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function pathsOf(args: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of PATH_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) out.push(value);
	}
	for (const key of PATH_LIST_KEYS) {
		const value = args[key];
		if (!Array.isArray(value)) continue;
		for (const item of value) if (typeof item === "string" && item.trim()) out.push(item);
	}
	return out;
}

function commandOf(args: Record<string, unknown>): string {
	const value = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
	return normalizeCommandText(value);
}

/**
 * 从转录里抽事实。只认三种载体：assistant 的 `toolCall` 块、`bashExecution` 记录、
 * `toolResult`（用于把失败标记贴回对应命令）。
 */
export function collectTranscriptFacts(
	messages: readonly unknown[],
	opts: { writeTools?: ReadonlySet<string> } = {},
): TranscriptFacts {
	const writeTools = opts.writeTools ?? SUBAGENT_WRITE_TOOL_NAMES;
	const edited = new Set<string>();
	const commands: TranscriptCommand[] = [];
	const byCallId = new Map<string, { command?: string }>();

	for (const message of messages) {
		if (!isRecord(message)) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "toolCall") continue;
				const name = typeof block.name === "string" ? block.name : "";
				const callId =
					typeof block.toolCallId === "string" ? block.toolCallId : typeof block.id === "string" ? block.id : "";
				const args = argsOf(block);
				if (!args) continue;
				if (writeTools.has(name)) {
					for (const path of pathsOf(args)) edited.add(normalizeEvidencePath(path));
				}
				if (SHELL_TOOL_NAMES.has(name)) {
					const command = commandOf(args);
					if (!command) continue;
					commands.push({ command, failed: false });
					if (callId) byCallId.set(callId, { command });
				}
			}
			continue;
		}
		if (message.role === "bashExecution") {
			const command = normalizeCommandText(typeof message.command === "string" ? message.command : "");
			if (!command) continue;
			const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
			commands.push({ command, failed: exitCode !== undefined && exitCode !== 0 });
			continue;
		}
		if (message.role === "toolResult" && message.isError === true) {
			const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			const command = callId ? byCallId.get(callId)?.command : undefined;
			if (!command) continue;
			const hit = commands.find((entry) => entry.command === command && !entry.failed);
			if (hit) hit.failed = true;
		}
	}

	return { editedFiles: [...edited], commands };
}

function samePath(a: string, b: string): boolean {
	const x = normalizeEvidencePath(a).toLowerCase();
	const y = normalizeEvidencePath(b).toLowerCase();
	if (!x || !y) return false;
	if (x === y) return true;
	return x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

function commandMatches(claimed: string, executed: string): boolean {
	const a = normalizeCommandText(claimed);
	const b = normalizeCommandText(executed);
	if (!a || !b) return false;
	return a === b || b.includes(a);
}

function listFor(items: string[], limit: number): string {
	if (items.length <= limit) return items.join("; ");
	return `${items.slice(0, limit).join("; ")} (+${items.length - limit})`;
}

/** 对账：返回带裁决与问题清单的证据记录。 */
export function verifyEvidence(
	input: SubagentEvidenceInput,
	facts: TranscriptFacts,
	opts: { now?: number } = {},
): SubagentEvidence {
	const files = input.files ?? [];
	const commands = input.commands ?? [];
	const none = input.none === true;
	const blocked = input.blocked?.trim() || undefined;
	const issues: string[] = [];
	const warnings: string[] = [];

	let matchedFiles = 0;
	for (const file of files) {
		if (facts.editedFiles.some((edited) => samePath(file, edited))) matchedFiles++;
		else warnings.push(`declared file not seen in this run's edits: ${file}`);
	}

	if (none && facts.editedFiles.length > 0) {
		issues.push(
			`declared no file changes, but ${facts.editedFiles.length} file(s) were edited: ${listFor(facts.editedFiles, EVIDENCE_LIMITS.issueListed)}`,
		);
	}

	let matchedCommands = 0;
	for (const claimed of commands) {
		const hit = facts.commands.find((entry) => commandMatches(claimed, entry.command));
		if (!hit) {
			issues.push(`declared command was never run in this session: ${claimed}`);
			continue;
		}
		if (hit.failed) {
			issues.push(`declared command failed in this session: ${claimed}`);
			continue;
		}
		matchedCommands++;
	}

	if (!none && files.length > 0 && facts.editedFiles.length > 0) {
		const undeclared = facts.editedFiles.filter((edited) => !files.some((file) => samePath(file, edited)));
		if (undeclared.length > 0) {
			warnings.push(
				`${undeclared.length} file(s) were edited but not declared: ${listFor(undeclared, EVIDENCE_LIMITS.warningListed)}`,
			);
		}
	}

	let verdict: SubagentEvidenceVerdict;
	if (blocked) verdict = "blocked";
	else if (issues.length > 0) verdict = "unverified";
	else if (warnings.length > 0) verdict = "partial";
	else if (none || files.length > 0 || commands.length > 0) verdict = "pass";
	else verdict = "unverified";

	return {
		files,
		commands,
		none,
		blocked,
		verdict,
		issues: issues.slice(0, EVIDENCE_LIMITS.issueListed),
		warnings: warnings.slice(0, EVIDENCE_LIMITS.warningListed),
		matchedFiles,
		matchedCommands,
		reportedAt: opts.now ?? Date.now(),
	};
}

export function evidenceVerdictLabel(verdict: SubagentEvidenceVerdict, lang: string): string {
	if (lang === "zh") {
		switch (verdict) {
			case "pass":
				return "证据已核对";
			case "partial":
				return "部分证据未核对";
			case "blocked":
				return "自述受阻";
			default:
				return "未提供证据";
		}
	}
	switch (verdict) {
		case "pass":
			return "evidence verified";
		case "partial":
			return "partially verified";
		case "blocked":
			return "reported blocked";
		default:
			return "no evidence";
	}
}

/** 一行人话证据摘要：`证据已核对（2 文件、1 命令）` / `verified (2 files, 1 command)`。 */
export function formatEvidenceSummary(evidence: SubagentEvidence, lang: string): string {
	const zh = lang === "zh";
	const label = evidenceVerdictLabel(evidence.verdict, lang);
	const parts: string[] = [];
	if (evidence.files.length > 0) {
		parts.push(
			zh
				? `${evidence.matchedFiles}/${evidence.files.length} 文件`
				: `${evidence.matchedFiles}/${evidence.files.length} files`,
		);
	}
	if (evidence.commands.length > 0) {
		parts.push(
			zh
				? `${evidence.matchedCommands}/${evidence.commands.length} 命令`
				: `${evidence.matchedCommands}/${evidence.commands.length} commands`,
		);
	}
	if (evidence.none) parts.push(zh ? "声明无文件改动" : "declared no changes");
	if (evidence.blocked) parts.push(zh ? `受阻原因：${evidence.blocked}` : `blocked: ${evidence.blocked}`);
	const head =
		parts.length > 0 ? `${label}${zh ? "（" : " ("}${parts.join(zh ? "、" : ", ")}${zh ? "）" : ")"}` : label;
	const issuePart =
		evidence.issues.length > 0 ? `${zh ? "；矛盾：" : "; issues: "}${evidence.issues.join(zh ? "；" : "; ")}` : "";
	const warnPart =
		evidence.warnings.length > 0
			? `${zh ? "；疑点：" : "; warnings: "}${evidence.warnings.join(zh ? "；" : "; ")}`
			: "";
	return `${head}${issuePart}${warnPart}`;
}
