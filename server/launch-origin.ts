import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceSupervisor, UiServiceInfo } from "./protocol.js";

export const DEFAULT_SERVICE_NAME = "pi-web-ui";
const LAUNCHD_LABEL_DEFAULT = "com.xingshuyin.pi-web-ui";
const WIN_SERVICE_DIR_NAME = "pi-web-ui";

export interface LaunchOrigin {
	supervisor: ServiceSupervisor | null;
	name?: string;
}

export interface LaunchOriginInput {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	ppid?: number;
	winServiceDir?: string;
	listDir?: (dir: string) => string[];
	readFile?: (path: string) => string | null;
	readCgroup?: () => string | null;
}

function defaultListDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function defaultReadFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function winServiceDir(env: NodeJS.ProcessEnv = process.env): string {
	const appData = env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
	return join(appData, WIN_SERVICE_DIR_NAME);
}

function nameFromLaunchdLabel(label: string): string | null {
	if (label === LAUNCHD_LABEL_DEFAULT) return DEFAULT_SERVICE_NAME;
	const m = /^com\.(.+)\.server$/.exec(label);
	return m?.[1] ?? null;
}

function nameFromCgroup(content: string | null): string | undefined {
	const m = /([A-Za-z0-9_.@-]+)\.service/.exec(content ?? "");
	return m?.[1];
}

function supervisorForPlatform(platform: NodeJS.Platform): ServiceSupervisor {
	if (platform === "win32") return "windows-watchdog";
	if (platform === "darwin") return "launchd";
	return "systemd";
}

function detectWindows(input: LaunchOriginInput, env: NodeJS.ProcessEnv): LaunchOrigin {
	const dir = input.winServiceDir ?? winServiceDir(env);
	const listDir = input.listDir ?? defaultListDir;
	const readFile = input.readFile ?? defaultReadFile;
	const ppid = input.ppid ?? process.ppid;

	for (const file of listDir(dir)) {
		if (!file.endsWith(".pid")) continue;
		const raw = readFile(join(dir, file));
		if (raw === null) continue;
		if (Number(raw.trim()) !== ppid) continue;
		const name = file.slice(0, -".pid".length);
		const ps1 = readFile(join(dir, `${name}.ps1`));
		if (ps1 && ps1.includes("while ($true)")) return { supervisor: "windows-watchdog", name };
	}
	return { supervisor: null };
}

export function detectLaunchOrigin(input: LaunchOriginInput = {}): LaunchOrigin {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const serviceName = env.PI_WEB_SERVICE_NAME?.trim() || undefined;

	if ((env.PI_WEB_LAUNCHED_BY ?? "").trim().toLowerCase() === "service") {
		return { supervisor: supervisorForPlatform(platform), name: serviceName ?? DEFAULT_SERVICE_NAME };
	}

	if (platform === "darwin") {
		const label = env.XPC_SERVICE_NAME?.trim();
		if (!label) return { supervisor: null };
		const name = nameFromLaunchdLabel(label);
		return name ? { supervisor: "launchd", name } : { supervisor: null };
	}

	if (platform === "linux") {
		if (!env.INVOCATION_ID) return { supervisor: null };
		const readCgroup = input.readCgroup ?? defaultReadCgroup;
		return { supervisor: "systemd", name: serviceName ?? nameFromCgroup(readCgroup()) ?? DEFAULT_SERVICE_NAME };
	}

	if (platform === "win32") return detectWindows(input, env);

	return { supervisor: null };
}

function defaultReadCgroup(): string | null {
	return defaultReadFile("/proc/self/cgroup");
}

let cached: LaunchOrigin | null = null;

export function launchOrigin(): LaunchOrigin {
	cached ??= detectLaunchOrigin();
	return cached;
}

export function toServiceInfo(origin: LaunchOrigin): UiServiceInfo | null {
	if (!origin.supervisor) return null;
	return { name: origin.name ?? DEFAULT_SERVICE_NAME, supervisor: origin.supervisor };
}
