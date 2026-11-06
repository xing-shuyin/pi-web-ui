import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

export function checkPluginCwd(cwd: string): { ok: boolean; abs?: string; error?: string } {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "工作目录为空" };
	let abs: string;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `工作目录非法：${trimmed}` };
	}
	try {
		if (!statSync(abs).isDirectory()) throw new Error("not-a-dir");
	} catch {
		return { ok: false, error: `目标项目不存在或不是目录：${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return { ok: false, error: `拒绝在系统目录执行：${abs}（请在插件设置里指定项目工作目录）` };
		}
	}
	return { ok: true, abs };
}

export function isDeviceTaskClientId(id: string): boolean {
	return id.startsWith("device-task-");
}

export function isOrphanAdoptionExcludedClientId(id: string): boolean {
	return isDeviceTaskClientId(id) || isPseudoClientId(id);
}

export function isPseudoClientId(id: string): boolean {
	return (
		id.startsWith("plugin:") || id.startsWith("scheduler:") || id.startsWith("canvas:") || id.startsWith("canvas-")
	);
}
