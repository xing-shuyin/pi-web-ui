import type { ClientMessage, ServerMessage } from "./protocol.js";

/**
 * 请求型 WS 消息的「唯一回包点」（issue #980）。
 *
 * 背景：拒绝路径（策略拒绝 / 字段缺失 / 无法处理）过去只发一条 `notice`，而客户端等在
 * `*_result` 上 → 永久 loading，用户只看到一条会自己消失的 toast。这里把「该请求的失败回包
 * 长什么样」收进一张注册表：一条请求型消息的失败回包只有这一处展开，调用方只描述「为什么拒绝」。
 *
 * 三条约定：
 * 1. 注册表按 `ClientMessage["type"]` 为键，值只描述**协议里真实存在的**结果形状（不猜命名）；
 * 2. 结果包永远按该请求自己的关联字段回（`reqId` / `requestId`，且类型要跟协议一致：`reqId` 有的是
 *    number、有的是 string）；缺关联字段时只发 notice —— 一条对不上账的 result 只会制造幽灵回包；
 * 3. 注册表覆盖由 `tests/unit/ws-refusal-coverage.test.ts` 从 `server/protocol.ts` 推导后断言：
 *    新增一个带关联 id 的请求却忘了登记 → 测试红。
 */

/** 拒绝原因。`text` 是用户可见提示；`textEn` 缺省回落 `text`（notice 永远带 textEn 字段）。 */
export interface RefusalReason {
	readonly text: string;
	readonly textEn?: string;
	/** 机读失败原因，写进结果包的 error；缺省回落 `text`。 */
	readonly error?: string;
}

/** 请求型消息的最小形状：注册表只关心 type、关联 id，以及构造回包要用到的字段。 */
export interface RefusalRequest {
	readonly type: string;
	readonly reqId?: unknown;
	readonly requestId?: unknown;
	readonly [field: string]: unknown;
}

export type RequestReply =
	| {
			readonly correlation: "reqId";
			readonly idKind: "number";
			readonly reply: (msg: RefusalRequest, reason: RefusalReason, reqId: number) => ServerMessage;
	  }
	| {
			readonly correlation: "reqId";
			readonly idKind: "string";
			readonly reply: (msg: RefusalRequest, reason: RefusalReason, reqId: string) => ServerMessage;
	  }
	| {
			readonly correlation: "requestId";
			readonly idKind: "string";
			readonly reply: (msg: RefusalRequest, reason: RefusalReason, requestId: string) => ServerMessage;
	  };

function failureText(reason: RefusalReason): string {
	return reason.error ?? reason.text;
}

function textField(msg: RefusalRequest, field: string): string {
	const value = msg[field];
	return typeof value === "string" ? value : "";
}

function firstString(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const [first] = value;
	return typeof first === "string" ? first : "";
}

export const REQUEST_REPLIES: Partial<Record<ClientMessage["type"], RequestReply>> = {
	// —— 全局搜索（#980 复现路径：PI_WEB_TABS=chat 时两个请求都被拒）——
	search_files: {
		correlation: "reqId",
		idKind: "number",
		// `search_files_result` 协议里没有 error 字段，失败原因只能靠随行 notice。
		reply: (_msg, _reason, reqId) => ({ type: "search_files_result", reqId, ok: false, results: [] }),
	},
	search_sessions: {
		correlation: "reqId",
		idKind: "number",
		reply: (msg, _reason, reqId) => ({
			type: "session_search_results",
			reqId,
			query: textField(msg, "query"),
			ok: false,
			results: [],
		}),
	},

	// —— Git / SCM：五条请求共用 `scm_data`，用 kind 区分 ——
	scm_status: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({
			type: "scm_data",
			reqId,
			kind: "status",
			ok: false,
			error: failureText(reason),
		}),
	},
	scm_history: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({
			type: "scm_data",
			reqId,
			kind: "history",
			ok: false,
			error: failureText(reason),
		}),
	},
	scm_filediff: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({
			type: "scm_data",
			reqId,
			kind: "filediff",
			ok: false,
			error: failureText(reason),
		}),
	},
	scm_commit: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({
			type: "scm_data",
			reqId,
			kind: "commit",
			ok: false,
			error: failureText(reason),
		}),
	},
	scm_commitmsg: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({
			type: "scm_data",
			reqId,
			kind: "commitmsg",
			ok: false,
			error: failureText(reason),
		}),
	},

	// —— 会话切换 ——
	new_chat: {
		correlation: "requestId",
		idKind: "string",
		// `new_chat_result` 没有 error 字段（协议现状），拒绝原因只能靠随行 notice。
		reply: (_msg, _reason, requestId) => ({ type: "new_chat_result", requestId, ok: false }),
	},
	new_cli_chat: {
		correlation: "requestId",
		idKind: "string",
		reply: (_msg, _reason, requestId) => ({ type: "new_chat_result", requestId, ok: false }),
	},

	// —— 终端 CLI 会话（terminal tab 被拒时的回包）——
	terminal_cli_paste: {
		correlation: "requestId",
		idKind: "string",
		reply: (msg, reason, requestId) => ({
			type: "terminal_cli_paste_result",
			requestId,
			terminalId: textField(msg, "terminalId"),
			ok: false,
			error: failureText(reason),
		}),
	},
	terminal_cli_control: {
		correlation: "requestId",
		idKind: "string",
		reply: (msg, reason, requestId) => ({
			type: "terminal_cli_control_result",
			requestId,
			terminalId: textField(msg, "terminalId"),
			conversationId: textField(msg, "conversationId"),
			ok: false,
			error: failureText(reason),
		}),
	},

	// —— 扩展清单 ——
	extension_inventory: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({
			type: "extension_inventory_data",
			reqId,
			ok: false,
			entries: [],
			error: failureText(reason),
		}),
	},

	// —— 模型管理 ——
	fetch_models: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({ type: "fetch_models_result", reqId, ok: false, error: failureText(reason) }),
	},
	test_model_connection: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({
			type: "test_model_connection_result",
			reqId,
			ok: false,
			error: failureText(reason),
		}),
	},
	refresh_provider_models: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({ type: "refresh_provider_result", reqId, ok: false, error: failureText(reason) }),
	},
	refresh_builtin_models: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({ type: "refresh_builtin_result", reqId, ok: false, error: failureText(reason) }),
	},
	append_builtin_model: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({ type: "append_builtin_result", reqId, ok: false, error: failureText(reason) }),
	},
	clone_provider: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({ type: "clone_provider_result", reqId, ok: false, error: failureText(reason) }),
	},
	enrich_models: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({ type: "enrich_models_result", reqId, ok: false, error: failureText(reason) }),
	},
	abort_enrich_models: {
		correlation: "reqId",
		idKind: "number",
		reply: (_msg, reason, reqId) => ({ type: "enrich_models_result", reqId, ok: false, error: failureText(reason) }),
	},

	// —— MCP OAuth：四条请求共用 `mcp_oauth_result`，失败以 status 表达 ——
	mcp_oauth_start: {
		correlation: "reqId",
		idKind: "string",
		reply: (msg, reason, reqId) => ({
			type: "mcp_oauth_result",
			reqId,
			status: "error",
			...(textField(msg, "id") ? { id: textField(msg, "id") } : {}),
			error: failureText(reason),
		}),
	},
	mcp_oauth_finish: {
		correlation: "reqId",
		idKind: "string",
		reply: (msg, reason, reqId) => ({
			type: "mcp_oauth_result",
			reqId,
			status: "error",
			...(textField(msg, "id") ? { id: textField(msg, "id") } : {}),
			error: failureText(reason),
		}),
	},
	mcp_oauth_status: {
		correlation: "reqId",
		idKind: "string",
		reply: (msg, reason, reqId) => ({
			type: "mcp_oauth_result",
			reqId,
			status: "error",
			...(textField(msg, "id") ? { id: textField(msg, "id") } : {}),
			error: failureText(reason),
		}),
	},
	mcp_oauth_cancel: {
		correlation: "reqId",
		idKind: "string",
		reply: (_msg, reason, reqId) => ({
			type: "mcp_oauth_result",
			reqId,
			status: "error",
			error: failureText(reason),
		}),
	},

	// —— 画布：失败通道是 `canvas_error`（与真实 save/load 失败同一条）——
	canvas_load: {
		correlation: "requestId",
		idKind: "string",
		reply: (msg, reason, requestId) => ({
			type: "canvas_error",
			code: "execution_error",
			message: failureText(reason),
			graphId: textField(msg, "id"),
			requestId,
		}),
	},
	canvas_save: {
		correlation: "requestId",
		idKind: "string",
		reply: (_msg, reason, requestId) => ({
			type: "canvas_error",
			code: "execution_error",
			message: failureText(reason),
			requestId,
		}),
	},

	// —— 预设 ——
	preset_export: {
		correlation: "requestId",
		idKind: "string",
		reply: (_msg, reason, requestId) => ({
			type: "preset_export_result",
			requestId,
			ok: false,
			error: failureText(reason),
		}),
	},
	preset_import: {
		correlation: "requestId",
		idKind: "string",
		reply: (msg, reason, requestId) => ({
			type: "preset_import_result",
			requestId,
			ok: false,
			dryRun: msg.dryRun === true,
			error: failureText(reason),
		}),
	},
	preset_import_url: {
		correlation: "requestId",
		idKind: "string",
		reply: (msg, reason, requestId) => ({
			type: "preset_import_result",
			requestId,
			ok: false,
			dryRun: msg.dryRun === true,
			error: failureText(reason),
		}),
	},
	preset_catalog: {
		correlation: "requestId",
		idKind: "string",
		reply: (_msg, reason, requestId) => ({
			type: "preset_catalog_result",
			requestId,
			ok: false,
			entries: [],
			source: "",
			cached: false,
			fetchedAt: 0,
			error: failureText(reason),
		}),
	},
	preset_share: {
		correlation: "requestId",
		idKind: "string",
		reply: (_msg, reason, requestId) => ({
			type: "preset_share_result",
			requestId,
			ok: false,
			error: failureText(reason),
		}),
	},

	// —— 插件 ——
	plugin_install_inspect: {
		correlation: "requestId",
		idKind: "string",
		reply: (msg, reason, requestId) => ({
			type: "plugin_install_inspect_result",
			requestId,
			source: textField(msg, "source"),
			kind: "invalid",
			suggestedId: "",
			installed: false,
			problem: "unknown",
			detail: failureText(reason),
		}),
	},
	plugin_catalog_sync: {
		correlation: "requestId",
		idKind: "string",
		reply: (_msg, reason, requestId) => ({
			type: "plugin_catalog_sync_result",
			requestId,
			ok: false,
			error: failureText(reason),
		}),
	},

	// —— 沙盒 ——
	diff_sandbox: {
		correlation: "requestId",
		idKind: "string",
		reply: (msg, reason, requestId) => ({
			type: "sandbox_diff",
			diff: {
				requestId,
				sandboxId: "",
				path: textField(msg, "path"),
				added: [],
				modified: [],
				deleted: [],
				unchangedCount: 0,
				error: failureText(reason),
			},
		}),
	},

	// —— 远程 SSH ——
	remote_ssh_probe: {
		correlation: "reqId",
		idKind: "string",
		reply: (_msg, reason, reqId) => ({ type: "remote_ssh_probe_result", reqId, ok: false, error: failureText(reason) }),
	},
	remote_ssh_trust_host: {
		correlation: "reqId",
		idKind: "string",
		reply: (_msg, reason, reqId) => ({
			type: "remote_ssh_trust_host_result",
			reqId,
			ok: false,
			error: failureText(reason),
		}),
	},
	remote_ssh_list_dir: {
		correlation: "reqId",
		idKind: "string",
		reply: (msg, reason, reqId) => ({
			type: "remote_ssh_list_dir_result",
			reqId,
			ok: false,
			connectionId: textField(msg, "connectionId"),
			path: textField(msg, "path"),
			items: [],
			error: failureText(reason),
		}),
	},
	remote_ssh_install_tools: {
		correlation: "reqId",
		idKind: "string",
		reply: (msg, reason, reqId) => ({
			type: "remote_ssh_install_result",
			reqId,
			ok: false,
			connectionId: textField(msg, "connectionId"),
			tool: firstString(msg.tools),
			error: failureText(reason),
		}),
	},
	remote_ssh_list_profiles: {
		correlation: "reqId",
		idKind: "string",
		reply: (_msg, reason, reqId) => ({
			type: "remote_ssh_profiles_result",
			reqId,
			profiles: [],
			error: failureText(reason),
		}),
	},
};

/** 查注册表：只认自有键（未知类型不许命中原型链，如 `toString`）。 */
export function requestReplyFor(type: string): RequestReply | undefined {
	if (!Object.hasOwn(REQUEST_REPLIES, type)) return undefined;
	return REQUEST_REPLIES[type as ClientMessage["type"]];
}

/**
 * 拒绝一条请求型消息：固定「notice + 该请求自己的失败回包」两件套。
 *
 * - `notice` 只是附加提示，不能替代结果包；`textEn` 缺省回落 `text`，线上 notice 永远带 textEn。
 * - 注册表里没有该类型（非请求型）或请求没带关联 id 时只发 notice：结果包必须能对账，
 *   发一条关联 id 为空的 result 等于制造幽灵回包。
 * - 返回实际发出的消息（按发送顺序），便于调用方与测试断言。
 */
export function refuse(
	msg: RefusalRequest,
	reason: RefusalReason,
	send: (message: ServerMessage) => void,
): ServerMessage[] {
	const sent: ServerMessage[] = [];
	const push = (message: ServerMessage): void => {
		sent.push(message);
		send(message);
	};
	push({ type: "notice", level: "error", text: reason.text, textEn: reason.textEn ?? reason.text });

	const entry = requestReplyFor(msg.type);
	if (!entry) return sent;
	const value = entry.correlation === "reqId" ? msg.reqId : msg.requestId;
	if (entry.idKind === "number") {
		if (typeof value !== "number" || !Number.isSafeInteger(value)) return sent;
		push(entry.reply(msg, reason, value));
	} else {
		if (typeof value !== "string" || value.length === 0) return sent;
		push(entry.reply(msg, reason, value));
	}
	return sent;
}
