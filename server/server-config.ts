import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ServerFileConfig = {
	port?: number;
	host?: string;
	token?: string;
	allowHosts?: string;
	allowOrigins?: string;
};

const FILE_NAME = "server-config.json";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function configFilePath(dataDir: string): string {
	return join(dataDir, FILE_NAME);
}

export function loadServerFileConfig(dataDir: string): ServerFileConfig {
	try {
		const raw = readFileSync(configFilePath(dataDir), "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const out: ServerFileConfig = {};
		if (typeof parsed.port === "number" && Number.isInteger(parsed.port)) out.port = parsed.port;
		if (typeof parsed.host === "string" && parsed.host.trim()) out.host = parsed.host.trim();
		if (typeof parsed.token === "string") out.token = parsed.token;
		if (typeof parsed.allowHosts === "string") out.allowHosts = parsed.allowHosts;
		if (Array.isArray(parsed.allowHosts))
			out.allowHosts = parsed.allowHosts.filter((s) => typeof s === "string").join(",");
		if (typeof parsed.allowOrigins === "string") out.allowOrigins = parsed.allowOrigins;
		if (Array.isArray(parsed.allowOrigins))
			out.allowOrigins = parsed.allowOrigins.filter((s) => typeof s === "string").join(",");
		return out;
	} catch {
		return {};
	}
}

export function saveServerFileConfig(dataDir: string, cfg: ServerFileConfig): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(configFilePath(dataDir), `${JSON.stringify(cfg, null, "\t")}\n`, "utf8");
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
	if (!remoteAddress) return false;
	const ip = remoteAddress.trim().toLowerCase();
	if (LOOPBACK.has(ip)) return true;
	if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
	if (ip.startsWith("::ffff:127.")) return true;
	return false;
}

export function tokenWarning(token: string): string {
	if (!token) return "";
	if (token.length < 8) return "口令短于 8 字符，局域网暴露时建议更长。";
	return "";
}
