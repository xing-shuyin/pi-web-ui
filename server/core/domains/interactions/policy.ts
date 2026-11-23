import { evaluateApprovalRules, type ApprovalRule } from "../../../approval-rules.js";

export interface AutoApproveRequest {
	rule: ApprovalRule;
	toolName: string;
	args: unknown;
	/** 当前这次调用的审批类目 id；给了就要求规则的类目一致（同类才自动放行）。 */
	category?: string;
	cwd?: string;
	workspaceRoots?: readonly string[];
}

/**
 * 这条 allow 规则能否顶替一次人工审批。规则匹配本身不在这里实现：
 * 一律交给 `approval-rules.ts` 的 `evaluateApprovalRules`（含 `outside_workspace`、`glob`、复合命令等口径）。
 * deny 优先于 allow 仍是整表语义，调用方要按 `evaluateApprovalRules(全部规则, …)` 的结果决定，别拿本函数越过 deny。
 */
export function shouldAutoApprove(request: AutoApproveRequest): boolean {
	const evaluation = evaluateApprovalRules(
		[request.rule],
		request.toolName,
		request.args,
		request.cwd ?? "",
		request.workspaceRoots ? [...request.workspaceRoots] : [],
	);
	if (evaluation.action !== "allow") return false;
	if (request.category === undefined) return true;
	return evaluation.category?.id === request.category;
}
