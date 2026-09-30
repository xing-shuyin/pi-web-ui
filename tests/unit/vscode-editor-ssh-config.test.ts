import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import plugin, {
	expandSshInclude,
	loadSshConfigBlocks,
	parseSshConfig,
	parseSshConfigBlocks,
	resolveSshAlias,
	sshBlockMatches,
	sshPatternMatches,
} from "../../plugins/vscode-editor/index.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

describe("vscode-editor ssh pattern & block matching", () => {
	it("sshPatternMatches 支持 * 和 ? 通配符与 ! 取反", () => {
		expect(sshPatternMatches("*", "any-host")).toBe(true);
		expect(sshPatternMatches("app-??", "app-01")).toBe(true);
		expect(sshPatternMatches("app-??", "app-001")).toBe(false);
		expect(sshPatternMatches("!test-*", "test-srv")).toBe(false);
		expect(sshPatternMatches("!test-*", "prod-srv")).toBe(true);
	});

	it("sshBlockMatches 顺序判定且 ! 优先拒绝", () => {
		expect(sshBlockMatches(["prod-*", "!prod-db"], "prod-web")).toBe(true);
		expect(sshBlockMatches(["prod-*", "!prod-db"], "prod-db")).toBe(false);
	});
});

describe("vscode-editor ssh config loading & include resolution", () => {
	it("当 config 文件不存在时 loadSshConfigBlocks 返回空数组而不崩溃", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vsc-ssh-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const missingConfig = join(dir, "non-existent-config");

		const blocks = await loadSshConfigBlocks({ configFile: missingConfig });
		expect(blocks).toEqual([]);
	});

	it("成功解析基础 Host 块配置", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vsc-ssh-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const configFile = join(dir, "config");

		const content = `
Host srv-a
  HostName srv-a.internal.net
  User admin
  Port 2222
  IdentityFile ~/.ssh/id_rsa
`;
		writeFileSync(configFile, content, "utf8");

		const blocks = await loadSshConfigBlocks({ configFile });
		expect(blocks.length).toBe(1);
		expect(blocks[0].patterns).toEqual(["srv-a"]);
		expect(blocks[0].hostname).toBe("srv-a.internal.net");
		expect(blocks[0].user).toBe("admin");
		expect(blocks[0].port).toBe("2222");
		expect(blocks[0].identityfiles).toEqual(["~/.ssh/id_rsa"]);
	});

	it("支持 Include 指令并按 OpenSSH 顺序就地递归展开", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vsc-ssh-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const confDir = join(dir, "conf.d");
		mkdirSync(confDir, { recursive: true });

		const mainConfig = join(dir, "config");
		const subConfig1 = join(confDir, "10-work.conf");
		const subConfig2 = join(confDir, "20-gpu.conf");

		writeFileSync(
			mainConfig,
			`
Host jump
  HostName jump.lan
  User gateway

Include conf.d/*.conf

Host fallback
  HostName 10.0.0.1
`,
			"utf8",
		);

		writeFileSync(
			subConfig1,
			`
Host ea-cpu
  HostName localhost
  User lishengjie1
  ProxyCommand wsCli -a cpu -t token1
`,
			"utf8",
		);

		writeFileSync(
			subConfig2,
			`
Host ea-gpu
  HostName localhost
  User lishengjie1
  ProxyCommand wsCli -a gpu -t token2
`,
			"utf8",
		);

		const blocks = await loadSshConfigBlocks({ configFile: mainConfig });
		const patterns = blocks.flatMap((b) => b.patterns);
		// 顺序就地插入：jump -> ea-cpu -> ea-gpu -> fallback
		expect(patterns).toEqual(["jump", "ea-cpu", "ea-gpu", "fallback"]);
	});

	it("Include 循环引用保护：递归深度与已读文件限制防止死循环", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vsc-ssh-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const fileA = join(dir, "configA");
		const fileB = join(dir, "configB");

		// A 包含 B，B 包含 A
		writeFileSync(
			fileA,
			`
Host host-a
  HostName host-a.lan
Include configB
`,
			"utf8",
		);

		writeFileSync(
			fileB,
			`
Host host-b
  HostName host-b.lan
Include configA
`,
			"utf8",
		);

		// 不应死循环挂起，且两个文件各只被读入一次
		const blocks = await loadSshConfigBlocks({ configFile: fileA });
		const patterns = blocks.flatMap((b) => b.patterns);
		expect(patterns).toEqual(["host-a", "host-b"]);
	});

	it("expandSshInclude 正确展开 ~ 与 glob 通配符", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vsc-ssh-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const subDir = join(dir, "conf");
		mkdirSync(subDir, { recursive: true });

		writeFileSync(join(subDir, "a.conf"), "Host a\n", "utf8");
		writeFileSync(join(subDir, "b.conf"), "Host b\n", "utf8");
		writeFileSync(join(subDir, "c.txt"), "ignored\n", "utf8");

		const configFile = join(dir, "config");
		const expanded = await expandSshInclude("conf/*.conf", { configFile });
		expect(expanded.map((p: string) => p.replace(/\\/g, "/"))).toEqual([
			join(subDir, "a.conf").replace(/\\/g, "/"),
			join(subDir, "b.conf").replace(/\\/g, "/"),
		]);
	});
});

describe("vscode-editor issue #429: ssh config 自动加载全链路恢复", () => {
	it("正确解析 issue #429 报告的 ProxyCommand 配置", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vsc-ssh-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const configFile = join(dir, "config");

		const sampleConfig = `
Host ea-cpu
  HostName localhost
  User lishengjie1
  ProxyCommand wsCli -a <host> -t <token>

Host ea-gpu
  HostName localhost
  User lishengjie1
  ProxyCommand wsCli -a <host> -t <token>
`;
		writeFileSync(configFile, sampleConfig, "utf8");

		const blocks = await loadSshConfigBlocks({ configFile });
		expect(blocks).toHaveLength(2);

		const effCpu = resolveSshAlias("ea-cpu", blocks);
		expect(effCpu.hostname).toBe("localhost");
		expect(effCpu.user).toBe("lishengjie1");
		expect(effCpu.proxycommand).toBe("wsCli -a <host> -t <token>");

		const effGpu = resolveSshAlias("ea-gpu", blocks);
		expect(effGpu.hostname).toBe("localhost");
		expect(effGpu.user).toBe("lishengjie1");
		expect(effGpu.proxycommand).toBe("wsCli -a <host> -t <token>");
	});

	it("插件端到端链路：sshconfig_list 正确返回主机列表，不再报 ReferenceError 或伪报错", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "pi-vsc-home-"));
		const sshDir = join(homeDir, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

		// 模拟 ~/.ssh/config
		const sshConfigFile = join(sshDir, "config");
		writeFileSync(
			sshConfigFile,
			`
Host ea-cpu
  HostName localhost
  User lishengjie1
  ProxyCommand wsCli -a cpu -t token-cpu

Host ea-gpu
  HostName localhost
  User lishengjie1
  ProxyCommand wsCli -a gpu -t token-gpu
`,
			"utf8",
		);

		// 通过修改 process.env.HOME / USERPROFILE 或注入 mock
		const prevHome = process.env.HOME;
		const prevUserProfile = process.env.USERPROFILE;
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		cleanups.push(() => {
			if (prevHome !== undefined) process.env.HOME = prevHome;
			else delete process.env.HOME;
			if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
			else delete process.env.USERPROFILE;
		});

		const host = createMockHost({ cwd: homeDir, dataDir: homeDir } as any);
		await plugin.activate(host);

		const sent: any[] = [];
		(host as any).sendTo = (_cid: string, payload: any) => {
			sent.push(payload);
		};

		await (host as any).mock.emitAsync("onMessage", { action: "sshconfig_list", reqId: "r1" }, "c1");

		expect(sent).toHaveLength(1);
		const res = sent[0];
		expect(res.ok).toBe(true);
		expect(res.reqId).toBe("r1");
		expect(res.hosts).toBeDefined();
		expect(res.hosts.length).toBe(2);

		const cpu = res.hosts.find((h: any) => h.alias === "ea-cpu");
		expect(cpu).toBeDefined();
		expect(cpu.host).toBe("localhost");
		expect(cpu.username).toBe("lishengjie1");
		expect(cpu.proxyCommand).toBe("wsCli -a cpu -t token-cpu");

		const gpu = res.hosts.find((h: any) => h.alias === "ea-gpu");
		expect(gpu).toBeDefined();
		expect(gpu.host).toBe("localhost");
		expect(gpu.username).toBe("lishengjie1");
		expect(gpu.proxyCommand).toBe("wsCli -a gpu -t token-gpu");

		// 测试 state action 自动带上 configHosts
		sent.length = 0;
		await (host as any).mock.emitAsync("onMessage", { action: "state", reqId: "r2" }, "c1");
		expect(sent).toHaveLength(1);
		expect(sent[0].ok).toBe(true);
		expect(sent[0].state.configHosts.map((h: any) => h.alias)).toEqual(["ea-cpu", "ea-gpu"]);
	});

	it("当 ~/.ssh/config 为空时，sshconfig_list 给出明确报错", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "pi-vsc-home-empty-"));
		cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

		const prevHome = process.env.HOME;
		const prevUserProfile = process.env.USERPROFILE;
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		cleanups.push(() => {
			if (prevHome !== undefined) process.env.HOME = prevHome;
			else delete process.env.HOME;
			if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
			else delete process.env.USERPROFILE;
		});

		const host = createMockHost({ cwd: homeDir, dataDir: homeDir } as any);
		await plugin.activate(host);

		const sent: any[] = [];
		(host as any).sendTo = (_cid: string, payload: any) => {
			sent.push(payload);
		};

		await (host as any).mock.emitAsync("onMessage", { action: "sshconfig_list", reqId: "r3" }, "c1");

		expect(sent).toHaveLength(1);
		expect(sent[0].ok).toBe(false);
		expect(sent[0].error).toContain("~/.ssh/config 里没有可导入的主机");
	});

	it("当读取发生错误时记录 warn 日志并向上层抛出真实原因", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "pi-vsc-home-err-"));
		const sshDir = join(homeDir, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

		// 将 config 建为目录，触发 readFile EISDIR 错误
		mkdirSync(join(sshDir, "config"), { recursive: true });

		const prevHome = process.env.HOME;
		const prevUserProfile = process.env.USERPROFILE;
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		cleanups.push(() => {
			if (prevHome !== undefined) process.env.HOME = prevHome;
			else delete process.env.HOME;
			if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
			else delete process.env.USERPROFILE;
		});

		const host = createMockHost({ cwd: homeDir, dataDir: homeDir } as any);
		const logs: any[] = [];
		const origLog = host.log;
		host.log = (...args: any[]) => {
			logs.push(args);
			origLog?.(...args);
		};

		await plugin.activate(host);

		const sent: any[] = [];
		(host as any).sendTo = (_cid: string, payload: any) => {
			sent.push(payload);
		};

		await (host as any).mock.emitAsync("onMessage", { action: "sshconfig_list", reqId: "r4" }, "c1");

		expect(sent).toHaveLength(1);
		expect(sent[0].ok).toBe(false);
		expect(sent[0].error).toContain("读取 ~/.ssh/config 失败");
		expect(logs.some((l) => l[0] === "warn" && String(l[1]).includes("刷新 ~/.ssh/config 缓存失败"))).toBe(true);
	});
});
