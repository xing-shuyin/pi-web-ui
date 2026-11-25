import { describe, expect, it } from "vitest";
import { buildKernelInfo, classifyKernelInstall, describeKernelInstall } from "../../server/kernel-identity.js";

describe("classifyKernelInstall", () => {
	it("全局 npm 包（三平台路径，兼容 keel 与 pi-web-ui）", () => {
		expect(classifyKernelInstall("C:/Users/c/AppData/Roaming/npm/node_modules/keel")).toBe("global-npm");
		expect(classifyKernelInstall("/usr/local/lib/node_modules/keel")).toBe("global-npm");
		expect(classifyKernelInstall("C:/Users/c/AppData/Roaming/npm/node_modules/pi-web-ui")).toBe("global-npm");
		expect(classifyKernelInstall("/usr/local/lib/node_modules/pi-web-ui")).toBe("global-npm");
		expect(classifyKernelInstall("/opt/homebrew/lib/node_modules/pi-web-ui/")).toBe("global-npm");
		expect(classifyKernelInstall("C:\\Users\\c\\AppData\\Roaming\\npm\\node_modules\\pi-web-ui")).toBe("global-npm");
	});

	it("桌面壳内（app.asar）优先于 node_modules 判定", () => {
		expect(classifyKernelInstall("C:/Program Files/pi-web-ui/resources/app.asar")).toBe("packaged");
		expect(classifyKernelInstall("C:/Program Files/pi-web-ui/resources/app.asar.unpacked")).toBe("packaged");
		expect(classifyKernelInstall("/Applications/pi-web-ui.app/Contents/Resources/app.asar")).toBe("packaged");
	});

	it("源码仓库与 dist 构建产物都是 source", () => {
		expect(classifyKernelInstall("D:/pi-web-ui")).toBe("source");
		expect(classifyKernelInstall("D:/pi-web-ui-kernel")).toBe("source");
		expect(classifyKernelInstall("D:/pi-web-ui/dist")).toBe("source");
	});
});

describe("buildKernelInfo", () => {
	const base = {
		version: "0.121.3",
		packageRoot: "/usr/local/lib/node_modules/pi-web-ui",
		protocol: 60,
		startedAt: 1_000,
		now: 61_000,
		supervisor: null,
		serviceName: null,
		lock: "held" as const,
	};

	it("无托管者 → standalone；有 → service + 服务名", () => {
		expect(buildKernelInfo(base).mode).toBe("standalone");
		const svc = buildKernelInfo({ ...base, supervisor: "systemd", serviceName: "pi-web-ui" });
		expect(svc.mode).toBe("service");
		expect(svc.supervisor).toBe("systemd");
		expect(svc.serviceName).toBe("pi-web-ui");
	});

	it("uptime 由 startedAt/now 推导，且不为负（时钟回拨时夹到 0）", () => {
		expect(buildKernelInfo(base).uptimeMs).toBe(60_000);
		expect(buildKernelInfo({ ...base, now: 999 }).uptimeMs).toBe(0);
	});

	it("不带出 pid / 数据目录 / node 路径（免鉴权端点的信息面）", () => {
		const info = buildKernelInfo(base) as unknown as Record<string, unknown>;
		for (const forbidden of ["pid", "dataDir", "nodePath", "cwd", "packageRoot"]) {
			expect(info).not.toHaveProperty(forbidden);
		}
		expect(Object.keys(info).sort()).toEqual(
			[
				"installKind",
				"lock",
				"minShell",
				"mode",
				"protocol",
				"serviceName",
				"startedAt",
				"supervisor",
				"uptimeMs",
				"version",
			].sort(),
		);
	});

	it("installKind 透传分类结果，lock 透传是否禁用", () => {
		expect(buildKernelInfo(base).installKind).toBe("global-npm");
		expect(buildKernelInfo({ ...base, lock: "disabled" }).lock).toBe("disabled");
	});
});

describe("describeKernelInstall", () => {
	it("三种形态都有中文描述", () => {
		expect(describeKernelInstall("global-npm")).toBe("全局 npm 包");
		expect(describeKernelInstall("packaged")).toBe("桌面安装包内置");
		expect(describeKernelInstall("source")).toBe("源码");
	});
});
