/**
 * 前端 HTTP 单源：URL 拼接（`appUrl` + 口令）、JSON 请求体、失败回执解读。
 *
 * 为什么要有它：`/api/*` 的调用一度在每个组件里现写一遍 `fetch(withToken(appUrl(...)))` ——
 * 同一段「拼 URL → 判 `res.ok` → 取 `error` 字段」重复了几十次，于是各家失败文案自成一个格式
 * （`500` / `HTTP 500` / `Request failed (500)`），改一处超时或口令逻辑要改几十处。
 *
 * 用法：
 * ```ts
 * const room = await requestJson<Room>(`/api/device-center/rooms/${id}`, { signal });
 * await requestJson(`/api/device-center/rooms/${id}/enable`, { body: { enabled: true } });
 * ```
 *
 * 领域错误用 `errorFor` 映射，调用方拿到的仍是自己的错误类型（`instanceof` 照旧可用）：
 * ```ts
 * await requestJson(path, { body, errorFor: (f) => new GroupRequestError(f.status, f.error, f.code) });
 * ```
 */
import { clearAuthToken, withToken } from "./auth-token";
import { appUrl } from "./base-url";

/** 服务端失败回执的统一形状（`/api/*` 出错时返回 `{ error, code?, detail?, message? }`）。 */
export interface ApiFailure {
	status: number;
	/** 服务端自己给的原因（`error`，其次 `message`）；没给就是空串，调用方可以换成自己的文案。 */
	serverError: string;
	/** 可直接展示的原因：`serverError`，缺失时回落 `HTTP <status>`。 */
	error: string;
	code: string;
	detail: string;
	/** 原始回执，供调用方读非标准字段。 */
	body: unknown;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "",
		readonly detail = "",
		readonly body: unknown = null,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export interface ApiRequestInit extends Omit<RequestInit, "body"> {
	/** JSON 请求体：传了即 `POST`（`method` 可覆盖），并自动补 `Content-Type`。 */
	body?: unknown;
	/** 把失败回执映射成领域错误；不传则抛 `ApiError`。 */
	errorFor?: (failure: ApiFailure) => Error;
}

/** 带口令的应用内绝对 URL（同源相对根）。 */
export function apiUrl(path: string): string {
	return withToken(appUrl(path));
}

/** 发请求但不解读结果：给需要 `blob`/`text`/流或自定义失败处理的调用方。 */
export function apiFetch(path: string, init: ApiRequestInit = {}): Promise<Response> {
	const { body, errorFor: _errorFor, headers, ...rest } = init;
	const options: RequestInit = { ...rest };
	if (headers) options.headers = headers;
	if (body !== undefined) {
		options.method = rest.method ?? "POST";
		options.headers = { "Content-Type": "application/json", ...headers };
		options.body = JSON.stringify(body);
	}
	// 没任何 option 时就发裸 URL：浏览器默认的 credentials 已经是同源。
	if (Object.keys(options).length === 0) return fetch(apiUrl(path));
	return fetch(apiUrl(path), { credentials: "same-origin", ...options });
}

/** 解析失败回执；回执不是 JSON 时按 `HTTP <status>` 兜底。 */
export async function readApiFailure(response: Response): Promise<ApiFailure> {
	const body: unknown = await response.json().catch(() => null);
	const record = (body ?? {}) as Record<string, unknown>;
	const text = (key: string) => (typeof record[key] === "string" && record[key] ? (record[key] as string) : "");
	const serverError = text("error") || text("message");
	return {
		status: response.status,
		serverError,
		error: serverError || `HTTP ${response.status}`,
		code: text("code"),
		detail: text("detail"),
		body,
	};
}

/** `2xx` 的 JSON 回执；空 body 视为 `{}`。失败抛 `ApiError` 或 `errorFor` 映射的错误。 */
export async function requestJson<T = unknown>(path: string, init: ApiRequestInit = {}): Promise<T> {
	const response = await apiFetch(path, init);
	if (!response.ok) {
		const failure = await readApiFailure(response);
		if (init.errorFor) throw init.errorFor(failure);
		throw new ApiError(failure.status, failure.error, failure.code, failure.detail, failure.body);
	}
	return (await response.json().catch(() => ({}))) as T;
}

export async function logoutAuthSession(): Promise<void> {
	try {
		await requestJson("/__pi/session/logout", { method: "POST" });
	} finally {
		clearAuthToken();
	}
}

export async function revokeAuthSessions(body: {
	all?: boolean;
	id?: string;
}): Promise<{ revoked?: number | boolean }> {
	const result = await requestJson<{ ok: boolean; revoked?: number | boolean }>("/__pi/session/revoke", { body });
	if (body.all) clearAuthToken();
	return result;
}
