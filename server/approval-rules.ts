import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { DEFAULT_APPROVAL_RULES } from "./approval-default-rules.js";
import { LEGACY_TERMINAL_TOOL_NAMES } from "./tool-manager.js";
import { conversationToolAllowed } from "./conversation-tool-names.js";

export { DEFAULT_APPROVAL_RULES };
import type { UiApprovalCategory } from "./protocol.js";

export const SHELL_COMPOUND_OPERATOR_RE = /(?:[;&|`\n]|\$\()/;

export function hasShellCompoundOperator(command: string): boolean {
	return SHELL_COMPOUND_OPERATOR_RE.test(command);
}

export type ApprovalRuleAction = "ask" | "deny" | "allow";

export type ApprovalRuleField = "command" | "path" | "params";

export type ApprovalRuleMatchKind = "regex" | "glob" | "contains" | "prefix" | "outside_workspace";

export function isPathInsideRoot(target: string, root: string): boolean {
	const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
	const rel = relative(fold(resolve(root)), fold(resolve(target)));
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}

export interface ApprovalRule {
	id: string;
	enabled: boolean;
	tools: string[];
	field: ApprovalRuleField;
	match: ApprovalRuleMatchKind;
	value: string;
	action: ApprovalRuleAction;
	label: string;
	labelEn?: string;
	reason?: string;
	reasonEn?: string;
	categoryId?: string;
	builtin?: boolean;
}

export interface RuleEvaluationResult {
	action: "ask" | "deny" | "allow" | "none";
	matchedRule?: ApprovalRule;
	reason?: string;
	reasonEn?: string;
	category?: UiApprovalCategory;
	hits?: RuleHitDetail[];
}

export interface RuleHitDetail {
	ruleId: string;
	label: string;
	labelEn?: string;
	field: ApprovalRuleField;
	index: number;
	length: number;
	text: string;
}

export function globToRegex(pattern: string): RegExp {
	const src = String(pattern ?? "")
		.trim()
		.replace(/\\/g, "/");
	let re = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "*") {
			if (src[i + 1] === "*") {
				if (src[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/, (m) => `\\${m}`);
		}
	}
	return new RegExp(`^${re}$`, "i");
}

export function extractTargetPath(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const obj = params as Record<string, unknown>;
	for (const key of ["path", "file_path", "file"]) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

export function extractRuleFieldValue(field: ApprovalRuleField, toolName: string, params: unknown): string {
	if (!params || typeof params !== "object") {
		return typeof params === "string" ? params : "";
	}
	const obj = params as Record<string, unknown>;
	if (field === "command") {
		return String(obj.command ?? "");
	}
	if (field === "path") {
		return extractTargetPath(params);
	}
	if (field === "params") {
		try {
			return JSON.stringify(params);
		} catch {
			return String(params);
		}
	}
	return "";
}

function legacyTerminalRuleCall(rule: ApprovalRule, toolName: string, params: unknown) {
	if (toolName.trim().toLowerCase() !== "terminal" || !params || typeof params !== "object") return null;
	const { action, ...legacyParams } = params as Record<string, unknown>;
	const legacyName = `terminal_${String(action ?? "")}`;
	const names = rule.tools.map((name) => name.trim().toLowerCase());
	if (names.includes("terminal") || names.includes("*")) return null;
	if (!(LEGACY_TERMINAL_TOOL_NAMES as readonly string[]).includes(legacyName) || !names.includes(legacyName))
		return null;
	return { toolName: legacyName, params: legacyParams };
}

export function matchApprovalRuleDetails(
	rule: ApprovalRule,
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): { index: number; length: number; text: string }[] {
	const legacy = legacyTerminalRuleCall(rule, toolName, params);
	if (legacy) return matchApprovalRuleDetails(rule, legacy.toolName, legacy.params, cwd, workspaceRoots);
	if (!rule.enabled) return [];
	const targetTools = rule.tools.map((t) => t.trim().toLowerCase());
	const toolMatches =
		targetTools.includes("*") || conversationToolAllowed(new Set(targetTools), toolName.trim().toLowerCase());
	if (!toolMatches) return [];
	if (rule.match === "regex") {
		const fieldValue = extractRuleFieldValue(rule.field, toolName, params);
		if (!fieldValue) return [];
		if (rule.action === "allow" && rule.field === "command" && hasShellCompoundOperator(fieldValue)) {
			const single = matchApprovalRuleDetail(rule, toolName, params, cwd, workspaceRoots);
			return single ? [single] : [];
		}
		let re: RegExp;
		try {
			re = new RegExp(rule.value, "gi");
		} catch {
			return [];
		}
		const out: { index: number; length: number; text: string }[] = [];
		for (let m = re.exec(fieldValue); m; m = re.exec(fieldValue)) {
			if (m[0].length === 0) {
				re.lastIndex++;
				continue;
			}
			out.push({ index: m.index, length: m[0].length, text: m[0] });
		}
		return out;
	}
	const single = matchApprovalRuleDetail(rule, toolName, params, cwd, workspaceRoots);
	return single ? [single] : [];
}

export function matchApprovalRuleDetail(
	rule: ApprovalRule,
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): { index: number; length: number; text: string } | null {
	const legacy = legacyTerminalRuleCall(rule, toolName, params);
	if (legacy) return matchApprovalRuleDetail(rule, legacy.toolName, legacy.params, cwd, workspaceRoots);
	if (!rule.enabled) return null;

	const targetTools = rule.tools.map((t) => t.trim().toLowerCase());
	const toolMatches =
		targetTools.includes("*") || conversationToolAllowed(new Set(targetTools), toolName.trim().toLowerCase());
	if (!toolMatches) return null;

	if (rule.match === "outside_workspace") {
		const targetPath = extractRuleFieldValue("path", toolName, params);
		if (!targetPath) return null;
		const abs = resolve(cwd, targetPath);
		const allRoots = [resolve(cwd), ...workspaceRoots.map((r) => resolve(r))];
		const inside = allRoots.some((r) => isPathInsideRoot(abs, r));
		if (!inside) {
			return { index: 0, length: targetPath.length, text: targetPath };
		}
		return null;
	}

	const fieldValue = extractRuleFieldValue(rule.field, toolName, params);
	if (!fieldValue) return null;

	let matched: { index: number; length: number; text: string } | null = null;
	switch (rule.match) {
		case "regex": {
			try {
				const re = new RegExp(rule.value, "i");
				const m = re.exec(fieldValue);
				if (m) {
					matched = {
						index: m.index,
						length: m[0].length,
						text: m[0],
					};
				}
			} catch {
				return null;
			}
			break;
		}
		case "glob": {
			try {
				const re = globToRegex(rule.value);
				const normalized = fieldValue.replace(/\\/g, "/");
				if (re.test(normalized)) {
					matched = { index: 0, length: fieldValue.length, text: fieldValue };
				}
			} catch {
				return null;
			}
			break;
		}
		case "contains": {
			const idx = fieldValue.toLowerCase().indexOf(rule.value.toLowerCase());
			if (idx >= 0) {
				matched = {
					index: idx,
					length: rule.value.length,
					text: fieldValue.slice(idx, idx + rule.value.length),
				};
			}
			break;
		}
		case "prefix": {
			if (fieldValue.toLowerCase().startsWith(rule.value.toLowerCase())) {
				matched = {
					index: 0,
					length: rule.value.length,
					text: fieldValue.slice(0, rule.value.length),
				};
			}
			break;
		}
		default:
			return null;
	}

	if (!matched) return null;

	if (
		rule.action === "allow" &&
		rule.field === "command" &&
		hasShellCompoundOperator(fieldValue) &&
		matched.text.trim().length < fieldValue.trim().length
	) {
		return null;
	}

	return matched;
}

export function matchApprovalRule(
	rule: ApprovalRule,
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): boolean {
	return matchApprovalRuleDetail(rule, toolName, params, cwd, workspaceRoots) !== null;
}

export function evaluateApprovalRules(
	rules: ApprovalRule[],
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): RuleEvaluationResult {
	let primary: {
		action: "ask" | "deny" | "allow";
		matchedRule: ApprovalRule;
		reason?: string;
		reasonEn?: string;
		category?: UiApprovalCategory;
	} | null = null;

	const hits: RuleHitDetail[] = [];

	for (const rule of rules) {
		for (const detail of matchApprovalRuleDetails(rule, toolName, params, cwd, workspaceRoots)) {
			if (
				!primary ||
				(primary.action === "allow" &&
					legacyTerminalRuleCall(primary.matchedRule, toolName, params) &&
					!legacyTerminalRuleCall(rule, toolName, params) &&
					rule.action !== "allow")
			) {
				primary = {
					action: rule.action,
					matchedRule: rule,
					reason: rule.reason || rule.label,
					reasonEn: rule.reasonEn || rule.labelEn || rule.label,
					category: {
						id: rule.categoryId || rule.id,
						label: rule.label,
						labelEn: rule.labelEn || rule.label,
					},
				};
			}
			if (hits.length < 10) {
				const safeText = detail.text.length > 200 ? `${detail.text.slice(0, 200)}…` : detail.text;
				hits.push({
					ruleId: rule.id,
					label: rule.label,
					labelEn: rule.labelEn || rule.label,
					field: rule.field,
					index: detail.index,
					length: detail.length,
					text: safeText,
				});
			}
		}
	}

	if (primary) {
		return {
			...primary,
			hits: hits.length > 0 ? hits : undefined,
		};
	}

	return { action: "none" };
}

export function checkBashCommandDanger(
	command: string,
	rules: ApprovalRule[] = DEFAULT_APPROVAL_RULES,
): RuleHitDetail[] {
	if (!command || typeof command !== "string") return [];
	const res = evaluateApprovalRules(rules, "bash", { command }, "");
	return res.hits ?? [];
}

export function normalizeApprovalRule(raw: unknown): ApprovalRule | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const id = typeof o.id === "string" ? o.id.trim() : "";
	if (!id || id.length > 120) return null;

	const label = typeof o.label === "string" ? o.label.trim() : "";
	if (!label || label.length > 120) return null;

	const labelEn = typeof o.labelEn === "string" && o.labelEn.trim() ? o.labelEn.trim() : undefined;
	const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : undefined;
	const reasonEn = typeof o.reasonEn === "string" && o.reasonEn.trim() ? o.reasonEn.trim() : undefined;

	const action: ApprovalRuleAction = o.action === "deny" ? "deny" : o.action === "allow" ? "allow" : "ask";
	const field: ApprovalRuleField = o.field === "path" ? "path" : o.field === "params" ? "params" : "command";

	const match: ApprovalRuleMatchKind =
		o.match === "glob"
			? "glob"
			: o.match === "contains"
				? "contains"
				: o.match === "prefix"
					? "prefix"
					: o.match === "outside_workspace"
						? "outside_workspace"
						: "regex";

	const value = typeof o.value === "string" ? o.value : "";
	if (match === "regex") {
		try {
			new RegExp(value);
		} catch {
			return null;
		}
	}

	const tools: string[] = Array.isArray(o.tools)
		? o.tools
				.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
				.map((t) => t.trim().toLowerCase())
		: ["*"];

	return {
		id,
		enabled: o.enabled !== false,
		tools: tools.length > 0 ? tools : ["*"],
		field,
		match,
		value,
		action,
		label,
		...(labelEn ? { labelEn } : {}),
		...(reason ? { reason } : {}),
		...(reasonEn ? { reasonEn } : {}),
		...(typeof o.categoryId === "string" && o.categoryId.trim() ? { categoryId: o.categoryId.trim() } : {}),
		builtin: o.builtin === true,
	};
}

export class ApprovalRulesStore {
	private rules: ApprovalRule[] | null = null;
	private lastMtime = 0;

	constructor(private readonly filePath: string) {}

	private seededPath(): string {
		return /\.json$/i.test(this.filePath)
			? this.filePath.replace(/\.json$/i, ".seeded.json")
			: `${this.filePath}.seeded.json`;
	}

	private loadSeeded(): Set<string> {
		const out = new Set<string>();
		try {
			const parsed = JSON.parse(readFileSync(this.seededPath(), "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (typeof item === "string" && item) out.add(item);
				}
			}
		} catch {}
		return out;
	}

	private saveSeeded(names: Set<string>): void {
		try {
			writeJsonAtomicSync(this.seededPath(), [...names].sort());
		} catch {}
	}

	private load(): ApprovalRule[] {
		let currentMtime = 0;
		try {
			if (existsSync(this.filePath)) {
				currentMtime = statSync(this.filePath).mtimeMs;
			}
		} catch {
			currentMtime = 0;
		}

		if (this.rules && currentMtime > 0 && currentMtime === this.lastMtime) {
			return this.rules;
		}

		let list: ApprovalRule[] = [];
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				list = parsed.map(normalizeApprovalRule).filter((r): r is ApprovalRule => r !== null);
			}
		} catch {
			list = DEFAULT_APPROVAL_RULES.map((r) => ({ ...r, tools: [...r.tools] }));
		}

		const seeded = this.loadSeeded();
		const existingIds = new Set(list.map((r) => r.id));
		let grown = false;

		for (const def of DEFAULT_APPROVAL_RULES) {
			if (!existingIds.has(def.id) && !seeded.has(def.id)) {
				list.push({ ...def, tools: [...def.tools] });
				existingIds.add(def.id);
				grown = true;
			}
			seeded.add(def.id);
		}

		if (grown || seeded.size > 0) {
			this.saveSeeded(seeded);
		}

		this.rules = list;
		this.lastMtime = currentMtime;
		return this.rules;
	}

	private persist(): void {
		try {
			writeJsonAtomicSync(this.filePath, this.rules ?? []);
			try {
				this.lastMtime = statSync(this.filePath).mtimeMs;
			} catch {}
		} catch {}
	}

	list(): ApprovalRule[] {
		return this.load().map((r) => ({ ...r, tools: [...r.tools] }));
	}

	upsert(input: unknown): string | null {
		const rule = normalizeApprovalRule(input);
		if (!rule) return "规则格式非法（缺少名称、工具列表或正则格式错误）";

		const list = this.load();
		const idx = list.findIndex((r) => r.id === rule.id);
		if (idx >= 0) {
			if (list[idx].builtin) {
				rule.builtin = true;
			}
			list[idx] = rule;
		} else {
			list.push(rule);
		}
		this.persist();
		return null;
	}

	saveAll(inputs: unknown[]): string | null {
		if (!Array.isArray(inputs)) return "规则列表必须是数组";
		const normalized: ApprovalRule[] = [];
		const ids = new Set<string>();

		for (const raw of inputs) {
			const r = normalizeApprovalRule(raw);
			if (!r) return "存在格式非法的规则项";
			if (ids.has(r.id)) return `规则 id 冲突: ${r.id}`;
			ids.add(r.id);
			normalized.push(r);
		}

		for (const def of DEFAULT_APPROVAL_RULES) {
			if (!ids.has(def.id)) {
				normalized.push({ ...def, tools: [...def.tools] });
				ids.add(def.id);
			} else {
				const i = normalized.findIndex((r) => r.id === def.id);
				normalized[i].builtin = true;
			}
		}

		this.rules = normalized;
		this.persist();
		return null;
	}

	remove(id: string): boolean {
		const list = this.load();
		const idx = list.findIndex((r) => r.id === id);
		if (idx < 0) return false;
		if (list[idx].builtin) return false;

		list.splice(idx, 1);
		this.persist();
		return true;
	}

	resetBuiltin(id: string): boolean {
		const def = DEFAULT_APPROVAL_RULES.find((r) => r.id === id);
		if (!def) return false;

		const list = this.load();
		const idx = list.findIndex((r) => r.id === id);
		if (idx >= 0) {
			list[idx] = { ...def, tools: [...def.tools] };
		} else {
			list.push({ ...def, tools: [...def.tools] });
		}
		this.persist();
		return true;
	}
}
