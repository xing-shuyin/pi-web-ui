import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTHORITY_CACHE_TTL_MS,
	authorityCachePath,
	buildAuthorityCache,
	globalKernelEntry,
	pickKernelSource,
	readAuthorityCache,
} from "../../desktop/kernel-authority.js";
import {
	describeNodeRuntime,
	envWithNodeOnPath,
	globalKernelRoot,
	nodeInstallGuide,
	npmGlobalInstallGuide,
	parseNpmPrefix,
	readServiceInstallState,
	serviceArtifactPath,
} from "../../desktop/kernel-env.js";

describe("pickKernelSource（权威链优先级）", () => {
	it("全局 npm > 用户目录运行时 > 包内自带", () => {
		expect(
			pickKernelSource({ globalEntry: "/g/index.js", runtimeEntry: "/r/index.js", bundledEntry: "/b/index.js" }),
		).toEqual({ source: "global-npm", entry: "/g/index.js" });
		expect(pickKernelSource({ globalEntry: null, runtimeEntry: "/r/index.js", bundledEntry: "/b/index.js" })).toEqual({
			source: "userdata-runtime",
			entry: "/r/index.js",
		});
		expect(pickKernelSource({ globalEntry: null, runtimeEntry: null, bundledEntry: "/b/index.js" })).toEqual({
			source: "bundled",
			entry: "/b/index.js",
		});
	});

	it("三档全无 → null（纯壳包 + 机器上没装内核）", () => {
		expect(pickKernelSource({ globalEntry: null, runtimeEntry: null, bundledEntry: null })).toBeNull();
	});

	it("全局包入口按 <root>/dist/server/index.js 推导", () => {
		expect(globalKernelEntry("/usr/lib/node_modules/pi-web-ui").replace(/\\/g, "/")).toBe(
			"/usr/lib/node_modules/pi-web-ui/dist/server/index.js",
		);
	});
});

describe("权威链缓存", () => {
	const now = 1_700_000_000_000;

	it("刚写的缓存能读回", () => {
		expect(readAuthorityCache(buildAuthorityCache("C:/npm", now), now)).toBe("C:/npm");
	});

	it("过期 / 时钟倒流 / 坏 JSON / 空前缀 一律当没有", () => {
		const raw = buildAuthorityCache("C:/npm", now);
		expect(readAuthorityCache(raw, now + AUTHORITY_CACHE_TTL_MS + 1)).toBeNull();
		expect(readAuthorityCache(raw, now - 1)).toBeNull();
		expect(readAuthorityCache("not-json", now)).toBeNull();
		expect(readAuthorityCache(buildAuthorityCache("   ", now), now)).toBeNull();
		expect(readAuthorityCache(null, now)).toBeNull();
	});

	it("缓存文件落在 userData 根目录", () => {
		expect(authorityCachePath("/data").replace(/\\/g, "/")).toBe("/data/kernel-authority.json");
	});
});

describe("kernel-env", () => {
	it("node 版本够不够：≥22 才算 ok", () => {
		expect(describeNodeRuntime({ execPath: "/bin/node", nodeVersion: "v26.13.1" }).ok).toBe(true);
		expect(describeNodeRuntime({ execPath: "/bin/node", nodeVersion: "22.0.0" }).ok).toBe(true);
		expect(describeNodeRuntime({ execPath: "/bin/node", nodeVersion: "v18.20.0" }).ok).toBe(false);
		expect(describeNodeRuntime({ execPath: "/bin/node", nodeVersion: "garbage" }).ok).toBe(false);
	});

	it("npm prefix 输出容忍 CRLF 与警告行", () => {
		expect(parseNpmPrefix("C:\\Users\\c\\AppData\\Roaming\\npm\r\n")).toBe("C:\\Users\\c\\AppData\\Roaming\\npm");
		expect(parseNpmPrefix("npm warn foo\n/usr/local\n")).toBe("/usr/local");
		expect(parseNpmPrefix("\n\n")).toBeNull();
	});

	it("全局包根与平台分隔符一致", () => {
		expect(globalKernelRoot("/usr/local/").replace(/\\/g, "/")).toBe("/usr/local/node_modules/keel-agent");
	});

	it("装 node / 装内核都要求用户在终端执行（GUI 没有 TTY）", () => {
		for (const platform of ["win32", "darwin", "linux"] as const) {
			expect(nodeInstallGuide(platform).needsTerminal).toBe(true);
			expect(nodeInstallGuide(platform).command.length).toBeGreaterThan(0);
		}
		expect(nodeInstallGuide("win32").command).toContain("winget");
		expect(nodeInstallGuide("darwin").command).toContain("brew");
		expect(npmGlobalInstallGuide().command).toBe("npm i -g keel-agent@latest");
	});

	it("服务配置落点：三平台各一处，与 CLI 一致", () => {
		expect(serviceArtifactPath("win32", { APPDATA: "C:/AppData" }, "C:/home").replace(/\\/g, "/")).toBe(
			"C:/AppData/pi-web-ui/pi-web-ui.ps1",
		);
		expect(serviceArtifactPath("darwin", {}, "/Users/c").replace(/\\/g, "/")).toBe(
			"/Users/c/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist",
		);
		expect(serviceArtifactPath("linux", {}, "/home/c")).toBe("/etc/systemd/system/pi-web-ui.service");
	});

	it("装没装：Linux 读不到 /etc 时只能说 unknown（不是 absent）", () => {
		const exists = () => false;
		expect(readServiceInstallState({ platform: "win32", env: { APPDATA: "C:/A" }, home: "C:/h", exists })).toBe(
			"absent",
		);
		expect(readServiceInstallState({ platform: "linux", env: {}, home: "/home/c", exists })).toBe("unknown");
		expect(
			readServiceInstallState({ platform: "linux", env: {}, home: "/home/c", exists: (p) => p.includes("pi-web-ui") }),
		).toBe("installed");
	});
});

describe("envWithNodeOnPath（子进程 PATH 补 node 目录）", () => {
	const node = win32.join(
		"C:",
		"Users",
		"c",
		"AppData",
		"Roaming",
		"fnm",
		"node-versions",
		"v26.13.1",
		"installation",
		"node.exe",
	);
	const nodeDir = win32.join(
		"C:",
		"Users",
		"c",
		"AppData",
		"Roaming",
		"fnm",
		"node-versions",
		"v26.13.1",
		"installation",
	);

	it("把 node 所在目录前置到 PATH，其余环境原样保留", () => {
		const env = envWithNodeOnPath(
			{
				PATH: win32.join("C:", "Windows", "system32"),
				APPDATA: win32.join("C:", "Users", "c", "AppData", "Roaming"),
			} as NodeJS.ProcessEnv,
			node,
			"win32",
		);
		expect(env.PATH).toBe(`${nodeDir};${win32.join("C:", "Windows", "system32")}`);
		expect(env.APPDATA).toBe(win32.join("C:", "Users", "c", "AppData", "Roaming"));
	});

	it("Windows 上清掉 Path/PATH 的所有大小写变体，只留一个（否则子进程可能拿到没改过的那个）", () => {
		const windowsDir = win32.join("C:", "Windows");
		const env = envWithNodeOnPath({ Path: windowsDir, PATH: windowsDir } as NodeJS.ProcessEnv, node, "win32");
		expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
		expect(env.PATH?.startsWith(nodeDir)).toBe(true);
	});

	it("POSIX 用冒号分隔", () => {
		const env = envWithNodeOnPath({ PATH: "/usr/bin" } as NodeJS.ProcessEnv, "/opt/node/bin/node", "linux");
		expect(env.PATH).toBe("/opt/node/bin:/usr/bin");
	});
});
