import { describe, expect, it } from "vitest";
import { detectLaunchOrigin, toServiceInfo, winServiceDir } from "../../server/launch-origin.js";

function fakeFs(files: Record<string, string>) {
	const norm = (path: string) => path.replace(/\\/g, "/");
	const table = new Map(Object.entries(files).map(([path, body]) => [norm(path), body]));
	return {
		listDir: (dir: string) => {
			const prefix = norm(dir).replace(/\/$/, "") + "/";
			return [...table.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length))
				.filter((name) => !name.includes("/"));
		},
		readFile: (path: string) => table.get(norm(path)) ?? null,
	};
}

const WIN_DIR = "C:\\Users\\t\\AppData\\Roaming\\pi-web-ui";
const PID_FILE = `${WIN_DIR}\\pi-web-ui.pid`;
const PS1_FILE = `${WIN_DIR}\\pi-web-ui.ps1`;
const WATCHDOG = "try {\r\n  while ($true) {\r\n    & node server.js\r\n    Start-Sleep 10\r\n  }";
const FOREGROUND_PS1 = "$PID | Out-File $pidFile\r\n& node server.js";

describe("detectLaunchOrigin", () => {
	it("前台 / dev：没有 supervisor 痕迹时返回 null", () => {
		expect(detectLaunchOrigin({ env: {}, platform: "linux", ppid: 42 })).toEqual({ supervisor: null });
		expect(detectLaunchOrigin({ env: {}, platform: "darwin", ppid: 42 })).toEqual({ supervisor: null });
		expect(
			detectLaunchOrigin({ env: {}, platform: "win32", ppid: 42, listDir: () => [], readFile: () => null }),
		).toEqual({ supervisor: null });
	});

	it("PI_WEB_LAUNCHED_BY=service 优先，并按平台推导 supervisor", () => {
		const env = { PI_WEB_LAUNCHED_BY: "service", PI_WEB_SERVICE_NAME: "work" };
		expect(detectLaunchOrigin({ env, platform: "linux" })).toEqual({ supervisor: "systemd", name: "work" });
		expect(detectLaunchOrigin({ env, platform: "darwin" })).toEqual({ supervisor: "launchd", name: "work" });
		expect(detectLaunchOrigin({ env, platform: "win32" })).toEqual({ supervisor: "windows-watchdog", name: "work" });
	});

	it("PI_WEB_LAUNCHED_BY=service 没带服务名时用默认名", () => {
		expect(detectLaunchOrigin({ env: { PI_WEB_LAUNCHED_BY: "service" }, platform: "linux" })).toEqual({
			supervisor: "systemd",
			name: "pi-web-ui",
		});
	});

	it("macOS：launchd 设的 XPC_SERVICE_NAME 认出我们生成的 label", () => {
		expect(detectLaunchOrigin({ env: { XPC_SERVICE_NAME: "com.xingshuyin.pi-web-ui" }, platform: "darwin" })).toEqual({
			supervisor: "launchd",
			name: "pi-web-ui",
		});
		expect(detectLaunchOrigin({ env: { XPC_SERVICE_NAME: "com.team.server" }, platform: "darwin" })).toEqual({
			supervisor: "launchd",
			name: "team",
		});
	});

	it("macOS：别人的 launchd job（非我们的 label）不算", () => {
		expect(detectLaunchOrigin({ env: { XPC_SERVICE_NAME: "com.apple.something" }, platform: "darwin" })).toEqual({
			supervisor: null,
		});
	});

	it("Linux：systemd 的 INVOCATION_ID + cgroup 里的 unit 名", () => {
		expect(detectLinux({ INVOCATION_ID: "abc" }, "0::/system.slice/pi-web-ui.service")).toEqual({
			supervisor: "systemd",
			name: "pi-web-ui",
		});
		expect(detectLinux({ INVOCATION_ID: "abc" }, "0::/system.slice/pi-web-ui-work.service")).toEqual({
			supervisor: "systemd",
			name: "pi-web-ui-work",
		});
	});

	it("Linux：没有 INVOCATION_ID（终端直起）不算，cgroup 认不出时回落默认名", () => {
		expect(detectLinux({}, "0::/user.slice/session-1.scope")).toEqual({ supervisor: null });
		expect(detectLinux({ INVOCATION_ID: "abc" }, "0::/user.slice/session-1.scope")).toEqual({
			supervisor: "systemd",
			name: "pi-web-ui",
		});
	});

	it("Windows：PID 文件里的 PID === ppid 且 ps1 有 watchdog 循环 → 服务启动", () => {
		const fs = fakeFs({ [PID_FILE]: "777\r\n", [PS1_FILE]: WATCHDOG });
		expect(detectLaunchOrigin({ env: {}, platform: "win32", ppid: 777, winServiceDir: WIN_DIR, ...fs })).toEqual({
			supervisor: "windows-watchdog",
			name: "pi-web-ui",
		});
	});

	it("Windows：PID 不匹配（前台跑的另一个进程）不算", () => {
		const fs = fakeFs({ [PID_FILE]: "777", [PS1_FILE]: WATCHDOG });
		expect(detectLaunchOrigin({ env: {}, platform: "win32", ppid: 1234, winServiceDir: WIN_DIR, ...fs })).toEqual({
			supervisor: null,
		});
	});

	it("Windows：快捷方式的前台实例（ps1 无 watchdog）不算——退出不会回来", () => {
		const fs = fakeFs({ [PID_FILE]: "777", [PS1_FILE]: FOREGROUND_PS1 });
		expect(detectLaunchOrigin({ env: {}, platform: "win32", ppid: 777, winServiceDir: WIN_DIR, ...fs })).toEqual({
			supervisor: null,
		});
	});

	it("Windows：--name 自定义服务名（<name>.pid / <name>.ps1）", () => {
		const fs = fakeFs({ [`${WIN_DIR}\\work.pid`]: "777", [`${WIN_DIR}\\work.ps1`]: WATCHDOG });
		expect(detectLaunchOrigin({ env: {}, platform: "win32", ppid: 777, winServiceDir: WIN_DIR, ...fs })).toEqual({
			supervisor: "windows-watchdog",
			name: "work",
		});
	});

	it("winServiceDir 走 %APPDATA%（CLI 的 winServiceDir 同源）", () => {
		expect(winServiceDir({ APPDATA: "C:\\Users\\t\\AppData\\Roaming" }).replace(/\\/g, "/")).toBe(
			"C:/Users/t/AppData/Roaming/pi-web-ui",
		);
	});

	it("toServiceInfo：无 supervisor 时 null，有则带默认名", () => {
		expect(toServiceInfo({ supervisor: null })).toBeNull();
		expect(toServiceInfo({ supervisor: "systemd" })).toEqual({ supervisor: "systemd", name: "pi-web-ui" });
		expect(toServiceInfo({ supervisor: "launchd", name: "team" })).toEqual({ supervisor: "launchd", name: "team" });
	});
});

function detectLinux(env: NodeJS.ProcessEnv, cgroup: string) {
	return detectLaunchOrigin({ env, platform: "linux", readCgroup: () => cgroup });
}
