import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, RemoteSshService } from "../../server/remote-ssh-service.js";

describe("RemoteSshService", () => {
	it("expandHome correctly expands home directory", () => {
		expect(expandHome(undefined)).toBeUndefined();
		expect(expandHome("")).toBe("");
		expect(expandHome("~")).toBe(os.homedir());
		expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
		expect(expandHome("/var/log")).toBe("/var/log");
	});

	it("parseProbeOutput parses full system and tools", () => {
		const svc = new RemoteSshService(os.tmpdir());
		const mockOutput = `
===SYSTEM===
Linux
x86_64
my-ubuntu-server
ubuntu
/home/ubuntu
===GIT===
/usr/bin/git
git version 2.34.1
===NODE===
/usr/bin/node
v20.11.0
===BASH===
/bin/bash
GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)
===PYTHON===
/usr/bin/python3
Python 3.10.12
===PKG===
apt-get
`;

		// @ts-expect-error accessing private method for unit testing
		const parsed = svc.parseProbeOutput(mockOutput);

		expect(parsed.system.os).toBe("Linux");
		expect(parsed.system.arch).toBe("x86_64");
		expect(parsed.system.hostname).toBe("my-ubuntu-server");
		expect(parsed.system.user).toBe("ubuntu");
		expect(parsed.system.homeDir).toBe("/home/ubuntu");

		expect(parsed.tools.git.installed).toBe(true);
		expect(parsed.tools.git.version).toContain("git version 2.34.1");

		expect(parsed.tools.node.installed).toBe(true);
		expect(parsed.tools.node.version).toContain("v20.11.0");

		expect(parsed.tools.bash.installed).toBe(true);
		expect(parsed.tools.bash.path).toBe("/bin/bash");

		expect(parsed.packageManager).toBe("apt-get");
		expect(parsed.suggestedInstall).toEqual([]);
	});

	it("parseProbeOutput detects missing git and bash and suggests installation", () => {
		const svc = new RemoteSshService(os.tmpdir());
		const mockOutput = `
===SYSTEM===
Linux
aarch64
minimal-alpine
root
/root
===GIT===
NONE
===NODE===
NONE
===BASH===
NONE
===PYTHON===
NONE
===PKG===
apk
`;

		// @ts-expect-error accessing private method for unit testing
		const parsed = svc.parseProbeOutput(mockOutput);

		expect(parsed.system.os).toBe("Linux");
		expect(parsed.system.arch).toBe("aarch64");
		expect(parsed.tools.git.installed).toBe(false);
		expect(parsed.tools.node.installed).toBe(false);
		expect(parsed.tools.bash.installed).toBe(false);
		expect(parsed.packageManager).toBe("apk");
		expect(parsed.suggestedInstall).toContain("git");
		expect(parsed.suggestedInstall).toContain("bash");
	});

	it("saves and manages profiles securely without leaking plaintext credentials", async () => {
		const testDataDir = path.join(os.tmpdir(), `pi-web-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(testDataDir, { recursive: true });

		try {
			const svc = new RemoteSshService(testDataDir);

			// 保存 profile，包含明文密码
			await svc.saveProfile("test-server", {
				host: "1.2.3.4",
				port: 2222,
				username: "developer",
				auth: {
					type: "password",
					password: "super-secret-password-12345",
				},
			});

			// 检查 profiles 列表
			const profiles = await svc.listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("test-server");
			expect(profiles[0].host).toBe("1.2.3.4");
			expect(profiles[0].port).toBe(2222);
			expect(profiles[0].username).toBe("developer");
			expect(profiles[0].authType).toBe("password");
			// 密码绝对不能在 Summary 中返回
			expect((profiles[0] as any).password).toBeUndefined();

			// 检查磁盘落盘文件，必须是加密的密文，绝对不能包含明文密码
			const diskRaw = await fs.readFile(path.join(testDataDir, "ssh-profiles.json"), "utf8");
			expect(diskRaw).not.toContain("super-secret-password-12345");
			expect(diskRaw).toContain("encryptedPassword");

			// 删除 profile
			await svc.deleteProfile("test-server");
			const profilesAfter = await svc.listProfiles();
			expect(profilesAfter).toHaveLength(0);
		} finally {
			await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
