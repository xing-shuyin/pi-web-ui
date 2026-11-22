import { describe, expect, it } from "vitest";
import { buildMainUrl, formatStartupBannerLines } from "../../server/startup-banner.js";

describe("startup-banner: 主入口 URL 与横幅格式化", () => {
	it("回环/通配绑定统一展示 localhost URL", () => {
		expect(buildMainUrl(8787, "127.0.0.1")).toBe("http://localhost:8787");
		expect(buildMainUrl(8787, "0.0.0.0")).toBe("http://localhost:8787");
		expect(buildMainUrl(8787, "localhost")).toBe("http://localhost:8787");
	});

	// issue #969：横幅与主链接不得携带口令本体（stdout 会进日志/CI/截图）。
	it("主链接永不携带 ?token=（任何绑定地址）", () => {
		expect(buildMainUrl(8787, "127.0.0.1")).not.toContain("token=");
		expect(buildMainUrl(9000, "192.168.1.50")).toBe("http://192.168.1.50:9000");
		expect(buildMainUrl(8787, "0.0.0.0")).not.toContain("token=");
	});

	it("非回环绑定地址展示指定 host", () => {
		expect(buildMainUrl(9000, "192.168.1.50")).toBe("http://192.168.1.50:9000");
	});

	it("formatStartupBannerLines：无口令时不输出 token 行", () => {
		const lines = formatStartupBannerLines({
			port: 8787,
			host: "127.0.0.1",
			cwd: "/work/my-project",
			sessionDir: "/home/user/.pi/agent/sessions",
			version: "1.5.0",
		});
		expect(lines).toContain("    http://localhost:8787");
		expect(lines).toContain("    workspace   : /work/my-project");
		expect(lines).toContain("    bind        : 127.0.0.1:8787");
		expect(lines.some((l) => l.includes("token       :"))).toBe(false);
	});

	it("formatStartupBannerLines：只输出口令来源描述，不输出口令本体", () => {
		const lines = formatStartupBannerLines({
			port: 8787,
			host: "127.0.0.1",
			tokenSource: "file /home/user/.pi-web/server-config.json",
			cwd: "/work/my-project",
			sessionDir: "/home/user/.pi/agent/sessions",
			version: "1.5.0",
		});
		const text = lines.join("\n");
		expect(text).toContain("    token       : file /home/user/.pi-web/server-config.json");
		expect(text).toContain("    http://localhost:8787");
		expect(text).not.toContain("token=");
		expect(text).toContain("    setup       : http://127.0.0.1:8787/setup （仅本机：配 token/监听/白名单）");
	});

	it("formatStartupBannerLines：sdkNote 存在时打印提示", () => {
		const lines = formatStartupBannerLines({
			port: 8787,
			host: "127.0.0.1",
			cwd: "/work",
			sessionDir: "/sessions",
			version: "1.5.0",
			sdkNote: "custom sdk note",
		});
		expect(lines).toContain("    pi SDK note : custom sdk note");
	});
});
