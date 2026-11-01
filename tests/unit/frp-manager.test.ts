import { describe, expect, it } from "vitest";
import {
	DEFAULT_FRP_VERSION,
	DEFAULT_REMOTE_PORT,
	DEFAULT_SERVER_PORT,
	generateFrpcToml,
	generateFrpsToml,
	generateRandomToken,
	generateRemoteBashScript,
	getLocalPlatformArch,
	getRemotePlatformArch,
	parseFrpArgs,
} from "../../bin/frp-manager.mjs";

describe("FRP Manager Architecture and Platform Mapping", () => {
	it("maps local Windows platforms correctly", () => {
		const win64 = getLocalPlatformArch("win32", "x64");
		expect(win64.os).toBe("windows");
		expect(win64.arch).toBe("amd64");
		expect(win64.isZip).toBe(true);
		expect(win64.binName).toBe("frpc.exe");
		expect(win64.archiveName("0.61.1")).toBe("frp_0.61.1_windows_amd64.zip");

		const winArm = getLocalPlatformArch("win32", "arm64");
		expect(winArm.osArch).toBe("windows_arm64");
		expect(winArm.isZip).toBe(true);
		expect(winArm.binName).toBe("frpc.exe");
	});

	it("maps local macOS platforms correctly", () => {
		const macArm = getLocalPlatformArch("darwin", "arm64");
		expect(macArm.os).toBe("darwin");
		expect(macArm.arch).toBe("arm64");
		expect(macArm.isZip).toBe(false);
		expect(macArm.binName).toBe("frpc");
		expect(macArm.archiveName("0.61.1")).toBe("frp_0.61.1_darwin_arm64.tar.gz");

		const macIntel = getLocalPlatformArch("darwin", "x64");
		expect(macIntel.osArch).toBe("darwin_amd64");
		expect(macIntel.isZip).toBe(false);
		expect(macIntel.binName).toBe("frpc");
	});

	it("maps local Linux platforms correctly", () => {
		const linux64 = getLocalPlatformArch("linux", "x64");
		expect(linux64.os).toBe("linux");
		expect(linux64.arch).toBe("amd64");
		expect(linux64.binName).toBe("frpc");
		expect(linux64.archiveName("0.61.1")).toBe("frp_0.61.1_linux_amd64.tar.gz");

		const linuxArm = getLocalPlatformArch("linux", "arm64");
		expect(linuxArm.osArch).toBe("linux_arm64");
		expect(linuxArm.binName).toBe("frpc");
	});

	it("maps remote Linux architectures correctly", () => {
		expect(getRemotePlatformArch("x86_64").osArch).toBe("linux_amd64");
		expect(getRemotePlatformArch("amd64").osArch).toBe("linux_amd64");
		expect(getRemotePlatformArch("aarch64").osArch).toBe("linux_arm64");
		expect(getRemotePlatformArch("arm64").osArch).toBe("linux_arm64");
		expect(getRemotePlatformArch("armv7l").osArch).toBe("linux_arm");
		expect(getRemotePlatformArch("i686").osArch).toBe("linux_386");
		expect(getRemotePlatformArch("x86_64").binName).toBe("frps");
	});
});

describe("FRP Configuration Generation", () => {
	it("generates random token of 32 hex chars", () => {
		const token = generateRandomToken();
		expect(token).toMatch(/^[0-9a-f]{32}$/);
	});

	it("generates valid frps.toml", () => {
		const toml = generateFrpsToml({
			bindPort: 7000,
			token: "test-secret-token",
		});
		expect(toml).toContain("bindPort = 7000");
		expect(toml).toContain('auth.method = "token"');
		expect(toml).toContain('auth.token = "test-secret-token"');
	});

	it("generates valid frpc.toml with default and custom ports", () => {
		const toml = generateFrpcToml({
			serverAddr: "47.100.1.1",
			serverPort: 7000,
			token: "my-token-123",
			localPort: 8787,
			remotePort: 8787,
			proxyName: "pi-web-ui",
		});
		expect(toml).toContain('serverAddr = "47.100.1.1"');
		expect(toml).toContain("serverPort = 7000");
		expect(toml).toContain('auth.token = "my-token-123"');
		expect(toml).toContain('name = "pi-web-ui"');
		expect(toml).toContain('type = "tcp"');
		expect(toml).toContain('localIP = "127.0.0.1"');
		expect(toml).toContain("localPort = 8787");
		expect(toml).toContain("remotePort = 8787");
	});

	it("generates standalone remote bash deployment script", () => {
		const script = generateRemoteBashScript({
			version: DEFAULT_FRP_VERSION,
			bindPort: DEFAULT_SERVER_PORT,
			remotePort: 9999,
			token: "script-token",
		});
		expect(script).toContain("#!/usr/bin/env bash");
		expect(script).toContain('FRP_VERSION="0.61.1"');
		expect(script).toContain("BIND_PORT=7000");
		expect(script).toContain("REMOTE_PORT=9999");
		expect(script).toContain('TOKEN="script-token"');
		expect(script).toContain("/usr/local/bin/frps");
		expect(script).toContain("/etc/systemd/system/frps.service");
		expect(script).toContain("systemctl restart frps");
	});
});

describe("FRP CLI Arguments Parsing", () => {
	it("parses deploy options correctly", () => {
		const { opts, positionals } = parseFrpArgs([
			"deploy",
			"--server",
			"example.com",
			"-sp",
			"7001",
			"-rp",
			"8080",
			"-lp",
			"8787",
			"-t",
			"secret",
			"-u",
			"ubuntu",
			"-p",
			"2222",
			"-i",
			"/path/to/key",
			"--local-only",
		]);

		expect(positionals).toEqual(["deploy"]);
		expect(opts.server).toBe("example.com");
		expect(opts.serverPort).toBe(7001);
		expect(opts.remotePort).toBe(8080);
		expect(opts.localPort).toBe(8787);
		expect(opts.token).toBe("secret");
		expect(opts.sshUser).toBe("ubuntu");
		expect(opts.sshPort).toBe(2222);
		expect(opts.sshKey).toBe("/path/to/key");
		expect(opts.localOnly).toBe(true);
	});

	it("handles shorthand and flag syntax with equal signs", () => {
		const { opts } = parseFrpArgs([
			"--server=1.2.3.4",
			"--server-port=7005",
			"--remote-port=9090",
			"--local-port=8788",
			"--token=tok123",
		]);

		expect(opts.server).toBe("1.2.3.4");
		expect(opts.serverPort).toBe(7005);
		expect(opts.remotePort).toBe(9090);
		expect(opts.localPort).toBe(8788);
		expect(opts.token).toBe("tok123");
	});
});
