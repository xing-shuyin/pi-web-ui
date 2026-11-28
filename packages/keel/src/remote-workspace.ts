import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 远程工作区 URI 的解析结果（`ssh://user@host:port/path`）。 */
export interface ParsedRemoteUri {
	username: string;
	host: string;
	port: number;
	remotePath: string;
	hostKey: string;
}

export function isRemoteWorkspaceUri(uri?: string | null): boolean {
	return Boolean(uri && uri.trim().startsWith("ssh://"));
}

export function parseRemoteWorkspaceUri(uri: string): ParsedRemoteUri | null {
	if (!isRemoteWorkspaceUri(uri)) return null;
	const trimmed = uri.trim();
	const m = /^ssh:\/\/([^@]+)@([^:/]+)(?::(\d+))?(\/.*)?$/.exec(trimmed);
	if (!m) return null;
	const username = m[1];
	const host = m[2];
	const port = m[3] ? parseInt(m[3], 10) || 22 : 22;
	const rawPath = m[4] ? m[4].replace(/\\/g, "/") : "/";
	const remotePath = path.posix.normalize(rawPath).replace(/\/+$/, "") || "/";
	return {
		username,
		host,
		port,
		remotePath,
		hostKey: `${username}@${host}:${port}`,
	};
}

export function formatRemoteWorkspaceUri(username: string, host: string, port: number, remotePath: string): string {
	const cleanPath = path.posix.normalize((remotePath || "/").replace(/\\/g, "/"));
	const normPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
	return `ssh://${username}@${host}:${port || 22}${normPath !== "/" ? normPath.replace(/\/+$/, "") : "/"}`;
}

export function resolveRemoteWorkspacePath(remoteRoot: string, rawPath: string): { abs: string; rel: string } | null {
	const root = path.posix.normalize(remoteRoot.replace(/\\/g, "/")).replace(/\/+$/, "") || "/";
	let cleaned = (rawPath || "").replace(/\\/g, "/").trim();
	if (isRemoteWorkspaceUri(cleaned)) {
		const parsed = parseRemoteWorkspaceUri(cleaned);
		if (parsed) {
			cleaned = parsed.remotePath;
		}
	}
	if (!cleaned || cleaned === ".") {
		return { abs: root, rel: "" };
	}
	const abs = cleaned.startsWith("/") ? path.posix.normalize(cleaned) : path.posix.resolve(root, cleaned);
	const rel = path.posix.relative(root, abs);
	if (rel.startsWith("..") || rel.includes("/..") || path.posix.isAbsolute(rel)) {
		return null;
	}
	return { abs, rel: rel === "." ? "" : rel };
}

const REMOTE_URI_MARKER_FILE = ".pi-remote-uri";

export function resolveWorkspaceSessionDir(dataDir: string | undefined, cwdOrUri: string): string {
	const trimmed = (cwdOrUri || "").trim();
	if (!isRemoteWorkspaceUri(trimmed)) {
		return trimmed;
	}
	const safeDataDir = dataDir || process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), ".keel");
	const parsed = parseRemoteWorkspaceUri(trimmed);
	const hash = createHash("sha1").update(trimmed).digest("hex").slice(0, 10);
	const baseName = parsed
		? `${parsed.username}_${parsed.host}_${parsed.port}_${parsed.remotePath.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "")}`.slice(
				0,
				72,
			)
		: trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72);
	const dir = path.resolve(safeDataDir, "remote-workspaces", `${baseName}_${hash}`);
	try {
		mkdirSync(dir, { recursive: true });
		const markerPath = path.join(dir, REMOTE_URI_MARKER_FILE);
		if (!existsSync(markerPath)) {
			writeFileSync(markerPath, trimmed, "utf8");
		}
	} catch {}
	return dir;
}

export function restoreWorkspaceUriFromSessionDir(dir: string): string {
	if (!dir || isRemoteWorkspaceUri(dir)) return dir;
	try {
		const markerPath = path.join(dir, REMOTE_URI_MARKER_FILE);
		if (existsSync(markerPath)) {
			const uri = readFileSync(markerPath, "utf8").trim();
			if (isRemoteWorkspaceUri(uri)) return uri;
		}
	} catch {}
	return dir;
}
