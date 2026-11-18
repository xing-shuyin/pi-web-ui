import { DeviceGroupRequestError } from "./components/DeviceGroupSection";

/**
 * 确认/取消草案失败时讲人话。
 *
 * 本地草案接口（`bot-drafts/*`）是唯一会下发 `detail` 的路径（见 `server/device-center/local.ts` 的
 * `draftDetail`）：有 detail 就照原样展示；没有就按 `code` 给一句可操作的原因；最后才落到兜底文案。
 * 这样界面上不会再只看到 `Device group request failed (409)` 这种没法行动的提示。
 *
 * 草案失败后服务端仍保留草案（可重试），所以这里的文案要能直接指向"下一步做什么"。
 */
export type BotDraftActionFailure = "needs-approval" | "cwd-invalid" | "busy" | "missing" | "failed";

const CODE_KIND: Record<string, BotDraftActionFailure> = {
	DRAFT_NEEDS_APPROVAL: "needs-approval",
	BOT_CWD_INVALID: "cwd-invalid",
	WORKSPACE_INVALID: "cwd-invalid",
	BOT_BUSY: "busy",
	DRAFT_MISSING: "missing",
};

export function botDraftActionFailureKind(error: unknown): BotDraftActionFailure {
	if (!(error instanceof DeviceGroupRequestError)) return "failed";
	return CODE_KIND[error.code] ?? "failed";
}

export function botDraftActionErrorText(error: unknown, words: Record<BotDraftActionFailure, string>): string {
	if (error instanceof DeviceGroupRequestError) {
		if (error.detail) return error.detail;
		const kind = botDraftActionFailureKind(error);
		if (kind !== "failed") return words[kind];
		return error.code ? `${words.failed}（${error.code}）` : words.failed;
	}
	const message = error instanceof Error ? error.message.trim() : "";
	return message ? `${words.failed}：${message}` : words.failed;
}
