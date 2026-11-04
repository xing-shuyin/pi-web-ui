import { describe, expect, it } from "vitest";
import { buildMainUrl, formatStartupBannerLines } from "../../server/startup-banner.js";

describe("startup-banner: 主入口 URL 与横幅格式化", () => {
	it("无 token 时生成标准 localhost URL", () => {
		expect(buildMainUrl(8787, "127.0.0.1")).toBe("http://localhost:8787");
		expect(buildMainUrl(8787, "0.0.0.0")).toBe("http://localhost:8787");
		expect(buildMainUrl(8787, "localhost")).toBe("http://localhost:8787");
	});

	it("配置 token 时主链接自动携带 ?token= 查询参数", () => {
		expect(buildMainUrl(8787, "127.0.0.1", "s3cret")).toBe("http://localhost:8787/?token=s3cret");
		expect(buildMainUrl(8787, "0.0.0.0", "token123")).toBe("http://localhost:8787/?token=token123");
	});

	it("特殊字符 token 会被正确转义（issue #261 对齐）", () => {
		const specialToken = "base64token=+/==";
		const expectedUrl = `http://localhost:8787/?token=${encodeURIComponent(specialToken)}`;
		expect(buildMainUrl(8787, "127.0.0.1", specialToken)).toBe(expectedUrl);
	});

	it("非回环绑定地址展示指定 host", () => {
		expect(buildMainUrl(9000, "192.168.1.50", "abc")).toBe("http://192.168.1.50:9000/?token=abc");
	});

	it("formatStartupBannerLines：无 token 时不输出 token 行", () => {
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

	it("formatStartupBannerLines：有 token 时输出带 token 链接与 token 详情行", () => {
		const lines = formatStartupBannerLines({
			port: 8787,
			host: "127.0.0.1",
			token: "my-auth-secret",
			cwd: "/work/my-project",
			sessionDir: "/home/user/.pi/agent/sessions",
			version: "1.5.0",
		});
		expect(lines).toContain("    http://localhost:8787/?token=my-auth-secret");
		expect(lines).toContain("    token       : my-auth-secret");
		expect(lines).toContain("    setup       : http://127.0.0.1:8787/setup （仅本机：配 token/监听/白名单）");
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
