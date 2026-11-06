export const ErrorCode = Object.freeze({
	SUCCESS: 0,
	INTERNAL_ERROR: 1,
	INVALID_INPUT: 2,
	SERVICE_ERROR: 3,
	QUOTA_EXCEEDED: 4,
	RATE_LIMIT_REACHED: 5,
	NO_CONTENT: 6,
	UNSUPPORTED_LANGUAGE: 7,
	VOICE_UNSUPPORTED_LANGUAGE: 8,
	NOT_AVAILABLE: 9,
	RESUME_EXPIRED: 10,
	FORBIDDEN: 11,
	CONTENT_FILTER: 12,
});

const CODE_NAMES = Object.freeze(Object.fromEntries(Object.entries(ErrorCode).map(([name, code]) => [code, name])));

export function codeName(code) {
	if (code === undefined || code === null) return "UNKNOWN";
	return CODE_NAMES[code] ?? `UNKNOWN(${code})`;
}

function isSuccessCode(code) {
	return code === ErrorCode.SUCCESS;
}

const CODE_HINTS = Object.freeze({
	1: "服务端内部错误",
	2: "请求参数不对（会话 id / 消息 id 大概率是错的）",
	3: "服务端业务异常",
	4: "朗读额度用完了（今日限额）",
	5: "请求太频繁，被限流了",
	6: "这条消息没有可朗读的正文",
	7: "当前语言不支持朗读",
	8: "这个音色不支持当前语言",
	9: "服务端未对该账号放行（NOT_AVAILABLE，灰测/地区限制）",
	10: "续传票据过期了",
	11: "被拒绝（FORBIDDEN）",
	12: "内容被安全过滤挡了",
});

export function codeHint(code) {
	return CODE_HINTS[code] ?? null;
}

export class DeepSeekTtsError extends Error {
	constructor(message, { kind = "protocol", code, cause, details } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "DeepSeekTtsError";
		this.kind = kind;
		this.code = code;
		this.codeName = code === undefined ? undefined : codeName(code);
		this.details = details;
	}

	describe() {
		const bits = [this.message];
		if (this.code !== undefined && this.code !== null) {
			bits.push(`code=${this.code}(${this.codeName})`);
		}
		return bits.join(" ");
	}
}

export function usageError(message, details) {
	return new DeepSeekTtsError(message, { kind: "usage", details });
}

export function authError(message, details) {
	return new DeepSeekTtsError(message, { kind: "auth", details });
}

export function transportError(message, details) {
	return new DeepSeekTtsError(message, { kind: "transport", details });
}

export function protocolError(message, code, details) {
	const hint = codeHint(code);
	const full = hint ? `${message} —— ${hint}` : message;
	return new DeepSeekTtsError(full, { kind: "protocol", code, details });
}
