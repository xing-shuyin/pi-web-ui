import { describe, expect, it } from "vitest";
import { parseSshConfig, scanLocalSshConfig } from "../../plugins/remote-workbench/client/lib/ssh-config.mjs";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("remote-workbench ssh-config parser", () => {
	it("正确解析标准 OpenSSH config 语法", () => {
		const sample = `
# Global defaults
Host *
    ServerAliveInterval 60

Host dev-server
    HostName 10.0.0.12
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host aliyun-prod
    HostName 198.51.100.10
    User root
`;
		const hosts = parseSshConfig(sample);
		expect(hosts).toHaveLength(2);

		expect(hosts[0].alias).toBe("dev-server");
		expect(hosts[0].host).toBe("10.0.0.12");
		expect(hosts[0].username).toBe("deploy");
		expect(hosts[0].port).toBe(2222);
		expect(hosts[0].privateKeyPath).toBe("~/.ssh/id_ed25519");

		expect(hosts[1].alias).toBe("aliyun-prod");
		expect(hosts[1].host).toBe("198.51.100.10");
		expect(hosts[1].username).toBe("root");
		expect(hosts[1].port).toBe(22);
	});

	it("忽略包含通配符的块", () => {
		const sample = `
Host *.internal
    User ubuntu

Host ??.example.com
    Port 22
`;
		const hosts = parseSshConfig(sample);
		expect(hosts).toHaveLength(0);
	});

	it("applies first-value precedence, wildcard inheritance, negation and all literal aliases", () => {
		const hosts = parseSshConfig(
			`Host prod backup\n User deploy\nHost * !backup\n Port 2222\nHost *\n User fallback\n Port 2200`,
			{ username: "local" },
		);
		expect(hosts.map((h) => [h.alias, h.username, h.port])).toEqual([
			["prod", "deploy", 2222],
			["backup", "deploy", 2200],
		]);
	});

	it("preserves quoted paths and ignores comments, including spaced assignment syntax", () => {
		const [host] = parseSshConfig(
			`Host sample\n HostName = 10.0.0.1 # comment\n User=root\n IdentityFile "~/.ssh/key with spaces#hash"`,
		);
		expect(host.host).toBe("10.0.0.1");
		expect(host.username).toBe("root");
		expect(host.privateKeyPath).toBe("~/.ssh/key with spaces#hash");
		expect(host.importable).toBe(true);
	});

	it("preserves Windows path separators and explicit root with later defaults", () => {
		const [host] = parseSshConfig('Host win\n User root\n IdentityFile "C:\\Users\\dev\\key"\nHost *\n User fallback');
		expect(host.privateKeyPath).toBe("C:\\Users\\dev\\key");
		expect(host.username).toBe("root");
	});

	it("reports unsupported routing and conditional settings instead of silently changing connection semantics", () => {
		const [host] = parseSshConfig(`Host private\n ProxyJump bastion\n Port 99999\nMatch user deploy\n User privileged`);
		expect(host.importable).toBe(false);
		expect(host.warnings.join(" ")).toContain("proxyjump");
		expect(host.warnings.join(" ")).toContain("Match");
		expect(host.warnings.join(" ")).toContain("Invalid port");
	});

	it("expands Include files lexically and reports include cycles without recursion", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-config-"));
		try {
			await mkdir(path.join(dir, "config.d"));
			await writeFile(path.join(dir, "config"), "Include config.d/*\nHost *\n Port 2222");
			await writeFile(path.join(dir, "config.d", "a"), 'Host dev other\n IdentityFile "~/.ssh/key with spaces"');
			let result = await scanLocalSshConfig(path.join(dir, "config"));
			expect(result.list.map((h) => h.alias)).toEqual(["dev", "other"]);
			expect(result.list[0].port).toBe(2222);
			await writeFile(path.join(dir, "config.d", "b"), "Include config\nHost cyclic");
			result = await scanLocalSshConfig(path.join(dir, "config"));
			expect(result.warnings.join(" ")).toContain("cycle");
			expect(result.list.every((h) => !h.importable)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
