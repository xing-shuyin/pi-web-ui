import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import plugin, {
	buildFrpcToml,
	buildFrpsToml,
	buildRemoteInstallScript,
	detectAsset,
	frpDownloadUrl,
	sanitizeVersion,
	validateProxy,
} from "../../plugins/frp-manager/index.mjs";

describe("frp-manager 插件纯函数", () => {
	it("平台映射：win→zip，其余 tar.gz", () => {
		expect(detectAsset("win32", "x64")).toMatchObject({ os: "windows", ext: "zip" });
		expect(detectAsset("linux", "x64")).toMatchObject({ os: "linux", ext: "tar.gz" });
		expect(detectAsset("darwin", "arm64")).toMatchObject({ os: "darwin", arch: "arm64" });
	});

	it("下载地址拼出官方 release 路径", () => {
		expect(frpDownloadUrl("0.61.1", "linux", "x64")).toBe(
			"https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_linux_amd64.tar.gz",
		);
		expect(frpDownloadUrl("v0.61.1", "win32", "x64")).toContain(".zip");
	});

	it("非法版本号回退默认", () => {
		expect(sanitizeVersion("xxx")).toBe("0.61.1");
		expect(sanitizeVersion("v0.61.1")).toBe("0.61.1");
	});

	it("frpc.toml：禁用的规则不输出，http 走域名", () => {
		const toml = buildFrpcToml({ serverAddr: "1.2.3.4", serverPort: 7000, token: "abc" }, [
			{ name: "web", type: "tcp", localIP: "127.0.0.1", localPort: 3000, remotePort: 6000 },
			{ name: "off", type: "tcp", localIP: "127.0.0.1", localPort: 22, remotePort: 6022, enabled: false },
			{ name: "blog", type: "http", localIP: "127.0.0.1", localPort: 8080, customDomains: "a.com, b.com" },
		]);
		expect(toml).toContain('serverAddr = "1.2.3.4"');
		expect(toml).toContain('auth.token = "abc"');
		expect(toml).toContain('name = "web"');
		expect(toml).not.toContain('name = "off"');
		expect(toml).toContain('customDomains = ["a.com", "b.com"]');
	});

	it("frps.toml：按需输出 http/dashboard 段", () => {
		const full = buildFrpsToml({ bindPort: 7000, token: "t", httpPort: 8080, dashboardPort: 7500 });
		expect(full).toContain("bindPort = 7000");
		expect(full).toContain("vhostHTTPPort = 8080");
		expect(full).toContain("webServer.port = 7500");
		const bare = buildFrpsToml({ bindPort: 7000 });
		expect(bare).not.toContain("vhostHTTPPort");
		expect(bare).not.toContain("webServer");
	});

	it("校验：名称/端口/远程端口/http 域名", () => {
		expect(validateProxy({ name: "web", type: "tcp", localPort: 3000, remotePort: 6000 })).toBe("");
		expect(validateProxy({ name: "坏 名字", type: "tcp", localPort: 3000, remotePort: 6000 })).not.toBe("");
		expect(validateProxy({ name: "web", type: "tcp", localPort: 0, remotePort: 6000 })).not.toBe("");
		expect(validateProxy({ name: "web", type: "tcp", localPort: 3000 })).not.toBe("");
		expect(validateProxy({ name: "h", type: "http", localPort: 80 })).not.toBe("");
		expect(validateProxy({ name: "h", type: "http", localPort: 80, customDomains: "a.com" })).toBe("");
	});

	it("远端脚本：含版本/token/端口/systemd", () => {
		const s = buildRemoteInstallScript({ version: "0.61.1", bindPort: 7000, token: "tok", dashboardPort: 7500 });
		expect(s).toContain("frp_0.61.1_linux_${FARCH}.tar.gz");
		expect(s).toContain('auth.token = "tok"');
		expect(s).toContain("frps.service");
		expect(s).toContain("systemctl enable --now frps");
	});
});

describe("frp-manager 插件 activate", () => {
	it("AI 工具增删改查走通", async () => {
		const host = createMockHost({ dataDir: mkdtempSync(join(tmpdir(), "frp-ut-")) });
		const cleanup = await plugin.activate(host as never);
		try {
			const tools = (
				host.mock as unknown as { agentTools: Array<{ name: string; execute: (a: never) => Promise<string> }> }
			).agentTools;
			expect(tools.map((t) => t.name)).toEqual(["frp"]);
			const exec = tools[0].execute as (a: Record<string, string>) => Promise<string>;
			expect(
				await exec({
					action: "add",
					json: JSON.stringify({ name: "web", type: "tcp", localPort: 3000, remotePort: 6000 }),
				}),
			).toContain("已新增");
			expect(
				await exec({
					action: "add",
					json: JSON.stringify({ name: "web", type: "tcp", localPort: 3001, remotePort: 6001 }),
				}),
			).toContain("已存在");
			expect(await exec({ action: "set_server", json: JSON.stringify({ serverAddr: "1.2.3.4" }) })).toContain(
				"1.2.3.4",
			);
			const list = JSON.parse(await exec({ action: "list" }));
			expect(list).toHaveLength(1);
			expect(await exec({ action: "remove", name: "web" })).toContain("已删除");
			// 无 remoteSsh 服务时远端能力优雅降级（不抛错）
			expect(await exec({ action: "remote_list" })).toMatch(/为空|未就绪/);
			expect(await exec({ action: "remote_use", json: JSON.stringify({ profile: "nope" }) })).toContain("找不到");
			expect(await exec({ action: "remote_deploy" })).toContain("远端操作失败");
		} finally {
			await cleanup?.();
		}
	});
});
