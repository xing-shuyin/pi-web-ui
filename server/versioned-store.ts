import { writeFileSync } from "node:fs";

export type VersionedInspection<T> =
	{ status: "missing" } | { status: "ok"; value: T } | { status: "unsupported"; reason: string };

/**
 * 判断带版本号的 JSON 文件能不能用。三态而不是 boolean：调用方必须能区分
 * 「文件不存在（可以按默认值建库）」和「文件存在但我不认识（绝不能按默认值写回）」。
 * 版本号不认识时按默认值写回，等于把更新版本或旧版本的用户数据直接删掉。
 */
export function inspectVersionedJson<T>(
	text: string | undefined,
	versionKey: string,
	expectedVersion: number,
): VersionedInspection<T> {
	if (text === undefined || text.trim() === "") return { status: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: "unsupported", reason: "不是合法 JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { status: "unsupported", reason: "顶层不是对象" };
	}
	const found = (parsed as Record<string, unknown>)[versionKey];
	if (found !== expectedVersion) {
		return { status: "unsupported", reason: `版本不认识（读到 ${String(found)}，期望 ${expectedVersion}）` };
	}
	return { status: "ok", value: parsed as T };
}

/** 把认不出的文件另存一份再降级，返回备份路径；备份失败返回 undefined（原文件仍在原处）。 */
export function preserveFileSync(filePath: string, text: string, tag: string): string | undefined {
	const backup = `${filePath}.${tag}-${Date.now()}`;
	try {
		writeFileSync(backup, text, "utf8");
		return backup;
	} catch {
		return undefined;
	}
}
