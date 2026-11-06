import type { UiApprovalCategory } from "./protocol.js";
import {
	DEFAULT_APPROVAL_RULES,
	evaluateApprovalRules,
	extractTargetPath,
	type ApprovalRule,
	type RuleHitDetail,
} from "./approval-rules.js";

export interface DangerousCheckResult {
	dangerous: boolean;
	denied?: boolean;
	allowed?: boolean;
	reason?: string;
	reasonEn?: string;
	category?: UiApprovalCategory;
	hits?: RuleHitDetail[];
}

export interface ApprovalPolicy {
	allowAll: boolean;
	categories: Map<string, UiApprovalCategory>;
}

export function isApprovalPolicyEmpty(policy: ApprovalPolicy | undefined): boolean {
	return !policy || (!policy.allowAll && policy.categories.size === 0);
}

export function isWideScopeOrRootOperation(toolName: string, params: unknown): boolean {
	if (!params || typeof params !== "object") return false;
	const obj = params as Record<string, unknown>;

	if (toolName === "bash") {
		const cmd = String(obj.command ?? "").trim();
		if (/\brm\s+.*(-[a-zA-Z0-9]*[rf]|--recursive)/i.test(cmd)) {
			if (/(?:^|\s)(?:[/~*]|\.\.|[a-zA-Z]:[\\/])(?:\s|$)/.test(cmd)) {
				return true;
			}
		}
		if (/\b(del|rmdir|rd)\s+[/\\-][fsq]/i.test(cmd)) {
			if (/(?:^|\s)(?:[/~*]|\.\.|[a-zA-Z]:[\\/])(?:\s|$)/.test(cmd)) {
				return true;
			}
		}
		if (/\b(mkfs|format\s+[a-zA-Z]:|dd\s+if=)/i.test(cmd)) {
			return true;
		}
		if (/>\s*(?:\/etc\/|\/boot\/|C:\\Windows)/i.test(cmd)) {
			return true;
		}
		if (/\bchmod\s+.*?(?:777|000).*?(?:[/~]|[a-zA-Z]:[\\/])/i.test(cmd)) {
			return true;
		}
	}

	if (toolName === "write" || toolName === "edit" || toolName === "edit_soft" || toolName === "patch") {
		const p = extractTargetPath(params);
		if (
			p.includes("/etc/") ||
			p.includes("/boot/") ||
			p.includes("C:\\Windows") ||
			p.includes(".ssh") ||
			p.includes("id_rsa") ||
			p.includes("id_ed25519")
		) {
			return true;
		}
	}

	return false;
}

export function approvalSuppressionReason(
	policy: ApprovalPolicy | undefined,
	enabled: boolean,
	categoryId?: string,
	toolName?: string,
	params?: unknown,
): "disabled" | "allow-all" | "category" | null {
	if (!enabled) return "disabled";
	if (!policy) return null;
	if (policy.allowAll) return "allow-all";
	if (categoryId && policy.categories.has(categoryId)) {
		if (toolName && params && isWideScopeOrRootOperation(toolName, params)) {
			return null;
		}
		return "category";
	}
	return null;
}

export function pluginApprovalCategory(pluginId: string): UiApprovalCategory {
	return {
		id: `plugin:${pluginId}`,
		label: `插件 ${pluginId} 要求确认`,
		labelEn: `Plugin ${pluginId} requested confirmation`,
	};
}

export interface ToolApprovalResolution {
	decision: "approve" | "deny" | "edit";
	editedParams?: Record<string, unknown> | unknown;
	reason?: string;
}

export function checkDangerousToolCall(
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
	rules?: ApprovalRule[],
): DangerousCheckResult {
	if (!params || typeof params !== "object") {
		return { dangerous: false };
	}

	const res = evaluateApprovalRules(rules ?? DEFAULT_APPROVAL_RULES, toolName, params, cwd, workspaceRoots);

	if (res.action === "deny") {
		return {
			dangerous: true,
			denied: true,
			reason: res.reason,
			reasonEn: res.reasonEn,
			category: res.category,
			hits: res.hits,
		};
	}

	if (res.action === "allow") {
		return {
			dangerous: false,
			allowed: true,
		};
	}

	if (res.action === "ask") {
		return {
			dangerous: true,
			denied: false,
			reason: res.reason,
			reasonEn: res.reasonEn,
			category: res.category,
			hits: res.hits,
		};
	}

	return { dangerous: false };
}

export interface PendingApprovalEntry {
	id: string;
	toolCallId: string;
	toolName: string;
	params: Record<string, unknown> | unknown;
	reason?: string;
	reasonEn?: string;
	category?: UiApprovalCategory;
	hits?: RuleHitDetail[];
	parentTool?: string;
	conversationId?: string;
	conversationTitle?: string;
	resolve: (res: ToolApprovalResolution) => void;
	createdAt: number;
}

export type { ApprovalRule, RuleHitDetail } from "./approval-rules.js";
