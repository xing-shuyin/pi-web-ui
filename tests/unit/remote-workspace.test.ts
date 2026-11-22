import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { ClientStateStore, normalizePathKey } from "../../server/client-state.js";
import {
	buildRemoteWorkspacePersona,
	createRemoteSdkOperations,
	formatCwdForPrompt,
	mapResolvedPathToRemote,
	resolveRemoteWorkspacePath,
	resolveWorkspaceSessionDir,
	restoreWorkspaceUriFromSessionDir,
	setGlobalRemoteSshService,
	type RemoteSshService,
} from "../../server/remote-ssh-service.js";
import { IMAGE_SNIFF_BYTES } from "../../server/text-sniff.js";
import { isInsideWorkspaceRoots } from "../../server/tool-guards.js";
import {
	formatRemoteWorkspaceUri,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
} from "../../web/src/remote-ssh-client.js";

describe("Remote Workspace & SSH URI", () => {
	it("formats and parses remote workspace URIs accurately", () => {
		const uri = formatRemoteWorkspaceUri("ubuntu", "192.168.1.100", 22, "/data/projects/my-web-app");
		expect(uri).toBe("ssh://ubuntu@192.168.1.100:22/data/projects/my-web-app");
		expect(isRemoteWorkspaceUri(uri)).toBe(true);
		expect(isRemoteWorkspaceUri("/home/user/local-project")).toBe(false);

		const parsed = parseRemoteWorkspaceUri(uri);
		expect(parsed).not.toBeNull();
		expect(parsed?.username).toBe("ubuntu");
		expect(parsed?.host).toBe("192.168.1.100");
		expect(parsed?.port).toBe(22);
		expect(parsed?.remotePath).toBe("/data/projects/my-web-app");
	});

	it("normalizePathKey preserves remote ssh:// URIs without corrupting them into local paths", () => {
		const remoteUri = "ssh://root@10.0.0.1:2222/var/www/site";
		expect(normalizePathKey(remoteUri)).toBe(remoteUri);
	});

	it("ClientStateStore retains remote workspace in recent projects without being purged by fs.access", async () => {
		const testDir = path.join(
			os.tmpdir(),
			`pi-web-client-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });

		try {
			const store = new ClientStateStore(path.join(testDir, "client-state.json"));
			const clientId = "client_test_remote";
			const remoteUri = "ssh://developer@192.168.50.2:22/home/developer/app";

			store.remember(clientId, remoteUri);

			const state = store.get(clientId);
			expect(state.lastCwd).toBe(remoteUri);

			const projects = await store.getRecentProjects(clientId);
			expect(projects.length).toBeGreaterThanOrEqual(1);
			expect(projects[0].path).toBe(remoteUri);
		} finally {
			await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("maps remote workspace session directories and resolves remote paths safely", async () => {
		const testDir = path.join(
			os.tmpdir(),
			`pi-web-remote-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });
		try {
			const remoteUri = "ssh://root@198.51.100.10:22/project/game-share";
			const localSessionDir = resolveWorkspaceSessionDir(testDir, remoteUri);
			expect(localSessionDir).not.toBe(remoteUri);
			expect(restoreWorkspaceUriFromSessionDir(localSessionDir)).toBe(remoteUri);

			const localSubFile = path.join(localSessionDir, "src", "main.ts");
			expect(mapResolvedPathToRemote(localSubFile, localSessionDir, remoteUri)).toBe("/project/game-share/src/main.ts");
			expect(mapResolvedPathToRemote("/project/game-share/package.json", localSessionDir, remoteUri)).toBe(
				"/project/game-share/package.json",
			);

			expect(resolveRemoteWorkspacePath("/project/game-share", "src/index.ts")).toEqual({
				abs: "/project/game-share/src/index.ts",
				rel: "src/index.ts",
			});
			expect(resolveRemoteWorkspacePath("/project/game-share", "../../etc/passwd")).toBeNull();
			expect(isInsideWorkspaceRoots("src/index.ts", localSessionDir)).toBe(true);
			expect(isInsideWorkspaceRoots("/project/game-share/README.md", localSessionDir)).toBe(true);
			expect(isInsideWorkspaceRoots("/etc/passwd", localSessionDir)).toBe(false);

			const ops = createRemoteSdkOperations(localSessionDir);
			expect(ops).not.toBeNull();
			expect(ops?.remoteUri).toBe(remoteUri);

			expect(formatCwdForPrompt(localSessionDir)).toBe(
				"/project/game-share (remote SSH: ssh://root@198.51.100.10:22/project/game-share)",
			);
			const persona = buildRemoteWorkspacePersona(remoteUri);
			expect(persona).toContain("REMOTE SSH workspace");
			expect(persona).toContain("root@198.51.100.10:22");
			expect(persona).toContain("/project/game-share");
		} finally {
			await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("remote read ops 先按扩展名判图片，只有无名文件才读文件头嗅探", async () => {
		const testDir = path.join(
			os.tmpdir(),
			`pi-web-remote-image-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });
		try {
			const remoteUri = "ssh://root@198.51.100.10:22/project/game-share";
			const localSessionDir = resolveWorkspaceSessionDir(testDir, remoteUri);
			const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			const reads: Array<{ remoteAbs: string; maxBytes?: number }> = [];
			const mockSvc = {
				sftpReadFile: async (_uri: string, remoteAbs: string, maxBytes?: number) => {
					reads.push({ remoteAbs, maxBytes });
					if (remoteAbs.endsWith("/broken")) throw new Error("EACCES: permission denied");
					if (remoteAbs.endsWith("/empty-dump")) return { data: Buffer.alloc(0), size: 0 };
					return { data: pngHead, size: 64_000 };
				},
			};
			setGlobalRemoteSshService(mockSvc as unknown as RemoteSshService);
			try {
				const ops = createRemoteSdkOperations(localSessionDir);
				expect(ops).not.toBeNull();
				const at = (...seg: string[]) => path.join(localSessionDir, ...seg);

				expect(await ops!.read.detectImageMimeType(at("assets", "fig.png"))).toBe("image/png");
				expect(await ops!.read.detectImageMimeType(at("assets", "shot.JPG"))).toBe("image/jpeg");
				expect(await ops!.read.detectImageMimeType(at("readme.md"))).toBeNull();
				expect(await ops!.read.detectImageMimeType(at("assets", "vector.svg"))).toBeNull();
				expect(reads, "命名清楚的图片/文本不该为探测多付 SFTP 往返").toHaveLength(0);

				// 没扩展名的构建产物才读文件头（上限与 SDK 本地探测对齐）
				expect(await ops!.read.detectImageMimeType(at("dist", "snapshot"))).toBe("image/png");
				expect(reads).toEqual([{ remoteAbs: "/project/game-share/dist/snapshot", maxBytes: IMAGE_SNIFF_BYTES }]);

				// 契约要求「不是图片」返回 null，不许把异常抛给 SDK
				expect(await ops!.read.detectImageMimeType(at("dist", "empty-dump"))).toBeNull();
				expect(await ops!.read.detectImageMimeType(at("dist", "broken"))).toBeNull();
			} finally {
				setGlobalRemoteSshService(null);
			}
		} finally {
			await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("remote read ops 流式读文本，abort 后立刻断流（不再整文件传回内存）", async () => {
		const testDir = path.join(
			os.tmpdir(),
			`pi-web-remote-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });
		try {
			const remoteUri = "ssh://root@198.51.100.10:22/project/game-share";
			const localSessionDir = resolveWorkspaceSessionDir(testDir, remoteUri);
			const opened: string[] = [];
			const streams: PassThrough[] = [];
			const mockSvc = {
				sftpCreateReadStream: async (_uri: string, remoteAbs: string) => {
					opened.push(remoteAbs);
					const stream = new PassThrough();
					streams.push(stream);
					return stream;
				},
			};
			setGlobalRemoteSshService(mockSvc as unknown as RemoteSshService);
			try {
				const ops = createRemoteSdkOperations(localSessionDir);
				expect(ops).not.toBeNull();
				const logPath = path.join(localSessionDir, "logs", "app.log");

				const controller = new AbortController();
				const iter = ops!.read.createReadStream(logPath, { signal: controller.signal });
				const pending = iter.next();
				await new Promise((resolve) => setTimeout(resolve, 0));
				streams[0].write(Buffer.from("line1\n"));
				const first = await pending;
				expect(Buffer.from(first.value as Uint8Array).toString()).toBe("line1\n");

				controller.abort();
				expect(streams[0].destroyed, "abort 后必须断掉 SFTP 流").toBe(true);
				await iter.return(undefined);
				expect(opened).toEqual(["/project/game-share/logs/app.log"]);
			} finally {
				setGlobalRemoteSshService(null);
			}
		} finally {
			await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("SDK read 接到桥接 ops 后：图片进图片分支，文本走流而非整文件下载", async () => {
		const testDir = path.join(
			os.tmpdir(),
			`pi-web-remote-read-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });
		try {
			const remoteUri = "ssh://root@198.51.100.10:22/project/game-share";
			const localSessionDir = resolveWorkspaceSessionDir(testDir, remoteUri);
			const png = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
				"base64",
			);
			const buffered: string[] = [];
			const streamed: string[] = [];
			const mockSvc = {
				sftpStat: async () => ({ isDirectory: false, isFile: true, size: png.length, mode: 0o644, mtime: 0 }),
				sftpReadFile: async (_uri: string, remoteAbs: string) => {
					buffered.push(remoteAbs);
					return { data: png, size: png.length };
				},
				sftpCreateReadStream: async (_uri: string, remoteAbs: string) => {
					streamed.push(remoteAbs);
					return Readable.from([Buffer.from("alpha\n"), Buffer.from("beta\n")]);
				},
			};
			setGlobalRemoteSshService(mockSvc as unknown as RemoteSshService);
			try {
				const ops = createRemoteSdkOperations(localSessionDir);
				expect(ops).not.toBeNull();
				const tool = createReadToolDefinition(localSessionDir, { operations: ops!.read });
				const run = (p: string, id: string) =>
					tool.execute(id, { path: p }, undefined, undefined, { cwd: localSessionDir } as never);

				const image = await run(path.join(localSessionDir, "assets", "fig.png"), "call-image");
				expect(JSON.stringify(image.content)).toContain("Read image file [image/png]");
				expect(streamed, "图片不该走文本流").toHaveLength(0);

				const text = await run(path.join(localSessionDir, "logs", "app.log"), "call-text");
				const body = text.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				expect(body).toContain("alpha");
				expect(body).toContain("beta");
				expect(streamed).toEqual(["/project/game-share/logs/app.log"]);
				expect(
					buffered.filter((p) => p.endsWith("app.log")),
					"文本读必须走流，不许先把整份文件读进内存",
				).toHaveLength(0);
			} finally {
				setGlobalRemoteSshService(null);
			}
		} finally {
			await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
