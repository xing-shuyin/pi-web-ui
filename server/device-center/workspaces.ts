import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, posix, relative, resolve, sep } from "node:path";

export class DeviceWorkspaceError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}
function invalid(message: string): never {
	throw new DeviceWorkspaceError(400, "WORKSPACE_INVALID", message);
}
function contains(root: string, target: string): boolean {
	const rel = relative(root, target);
	return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * 直连设备的 SSH 工作区（局域网/公网均可）：`ssh://user@host[:port]/path`。
 * 代理执行走 SSH 通道，Bot 本体仍保存在本机（与 SSH 项目同一模式）。
 */
const SSH_WORKSPACE_URI = /^ssh:\/\/([^@/\s]+)@([^:/\s]+)(?::(\d+))?(\/.*)?$/;

export function normalizeSshWorkspaceUri(input: string): string | null {
	const match = SSH_WORKSPACE_URI.exec(input.trim());
	if (!match) return null;
	const [, username, host, portText, rawPath] = match;
	const port = portText ? Number.parseInt(portText, 10) : 22;
	if (!username || !host || !Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
	const cleaned = (rawPath || "/").replace(/\\/g, "/");
	const normalized = posix.normalize(cleaned.startsWith("/") ? cleaned : `/${cleaned}`).replace(/\/+$/, "") || "/";
	return `ssh://${username}@${host}:${port}${normalized}`;
}

export function isSshWorkspaceUri(input: unknown): input is string {
	return typeof input === "string" && input.trim().startsWith("ssh://");
}

export async function validateDeviceProject(input: string, dataDir: string): Promise<string> {
	// SSH 智能体：直连设备的工作区，保存本地、执行走 SSH 代理（无需配对 Hub）。
	if (isSshWorkspaceUri(input)) {
		const normalized = normalizeSshWorkspaceUri(input);
		if (!normalized) invalid("Select a valid SSH workspace like ssh://user@host:22/path");
		return normalized as string;
	}
	if (typeof input !== "string" || !input || !isAbsolute(input)) invalid("Select an absolute project directory");
	try {
		const selected = resolve(input);
		for (let current = selected; ; current = dirname(current)) {
			const stat = await lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				invalid("Project path must contain directories without symbolic links");
			if (dirname(current) === current) break;
		}
		const [root, home, dataRoot] = await Promise.all([
			realpath(selected),
			realpath(homedir()).catch(() => resolve(homedir())),
			// 数据目录还没建起来是常态（首启 / 测试夹具）：它不可能「包含」项目，
			// 用字面路径参与判定，别让 ENOENT 把合法的项目判成不可用。
			realpath(dataDir).catch(() => resolve(dataDir)),
		]);
		if (root === parse(root).root || relative(home, root) === "") invalid("Home and volume roots cannot be projects");
		if (contains(root, dataRoot)) invalid("Device data directory must be outside the project");
		return root;
	} catch (error) {
		if (error instanceof DeviceWorkspaceError) throw error;
		invalid("Project directory is unavailable");
	}
}
