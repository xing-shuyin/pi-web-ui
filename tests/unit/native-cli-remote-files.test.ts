import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NATIVE_CLI_PASTE } from "../../server/native-cli.js";
import {
	cleanupRemoteNativeCliFiles,
	prepareRemoteNativeCliPaste,
	type RemoteNativeCliPasteConfig,
} from "../../server/native-cli-remote-files.js";
import type { PromptAttachment } from "../../server/protocol.js";
import { saveUpload } from "../../server/uploads.js";

const cwd = "ssh://alice@host:22/project";
let dataDir: string;
let realpaths: Map<string, string>;
let directories: Set<string>;
let remote: Map<string, Buffer>;
let sftp: { realpath: ReturnType<typeof vi.fn>; mkdir: ReturnType<typeof vi.fn> };
let service: {
	getOrConnectByUri: ReturnType<typeof vi.fn>;
	sftpStat: ReturnType<typeof vi.fn>;
	sftpWriteFile: ReturnType<typeof vi.fn>;
	execInWorkspace: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "pi-remote-cli-files-"));
	realpaths = new Map();
	directories = new Set(["/project", "/project/src"]);
	remote = new Map();
	sftp = {
		realpath: vi.fn((path: string, callback: (error: Error | null, path: string) => void) =>
			callback(null, realpaths.get(path) ?? path),
		),
		mkdir: vi.fn((path: string, _attrs: unknown, callback: (error?: Error) => void) => {
			directories.add(path);
			callback();
		}),
	};
	service = {
		getOrConnectByUri: vi.fn(async () => ({ sftp })),
		sftpStat: vi.fn(async (_cwd: string, path: string) => ({
			isFile: !directories.has(path),
			isDirectory: directories.has(path),
			size: 10,
		})),
		sftpWriteFile: vi.fn(async (_cwd: string, path: string, bytes: Buffer) => {
			remote.set(path, Buffer.from(bytes));
		}),
		execInWorkspace: vi.fn(async (_cwd: string, command: string) => {
			const batch = /\/tmp\/pi-native-cli-[a-f0-9-]+/.exec(command)?.[0];
			if (batch) {
				directories.delete(batch);
				for (const path of remote.keys()) if (path.startsWith(`${batch}/`)) remote.delete(path);
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		}),
	};
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(dataDir, { recursive: true, force: true });
});
function config(overrides: Partial<RemoteNativeCliPasteConfig> = {}): RemoteNativeCliPasteConfig {
	return {
		cwd,
		clientId: "client-a",
		settings: { chatUploadMaxMb: 1 },
		dataDir,
		service: service as any,
		...overrides,
	};
}
function prepare(
	attachments: PromptAttachment[],
	data = "Use attachments",
	overrides: Partial<RemoteNativeCliPasteConfig> = {},
) {
	return prepareRemoteNativeCliPaste(config(overrides), data, attachments);
}
function uploaded(content = "contents", name = "document.txt"): PromptAttachment {
	const saved = saveUpload("client-a", name, Buffer.from(content), dataDir);
	return { path: "", uploadPath: saved.abs, name };
}

describe("prepareRemoteNativeCliPaste", () => {
	it("preserves short quoted text and sanitizes terminal controls without connecting", async () => {
		const result = await prepare(
			[{ path: "", mode: "quote", quote: { text: "原文\r\nline\x1b[201~" } as any }],
			"read\x03",
		);
		expect(result.text).toBe("read\n\nQuoted text:\n原文\nline[201~");
		expect(result.paths).toEqual([]);
		await result.dispose();
		expect(service.getOrConnectByUri).not.toHaveBeenCalled();
	});

	it("uses real remote paths for files, directories, and same-host URIs", async () => {
		realpaths.set("/project/link.ts", "/project/real.ts");
		const result = await prepare([
			{ path: "link.ts", mode: "lines", lines: { start: 2, end: 7 } },
			{ path: "/project/src" },
			{ path: "ssh://alice@host/project/readme.md" },
		]);
		expect(result.text).toContain('File path: "/project/real.ts" (lines 2-7)');
		expect(result.text).toContain('Directory path: "/project/src"');
		expect(result.text).toContain('File path: "/project/readme.md"');
		expect(result.text).not.toContain("ssh://");
		expect(service.sftpWriteFile).not.toHaveBeenCalled();
	});

	it("accepts workspaces whose own root is a symlink", async () => {
		realpaths.set("/project", "/srv/repo");
		realpaths.set("/project/file", "/srv/repo/file");
		expect((await prepare([{ path: "file" }])).text).toContain('"/srv/repo/file"');
	});

	it.each([
		"../secret",
		"/project/../secret",
		"src/../../secret",
		"ssh://alice@host/project/../secret",
		"ssh://alice@other/project/file",
		"ssh://bob@host/project/file",
		"ssh://alice@host:222/project/file",
		"C:\\private\\secret",
		"src\\..\\secret",
		"file:///local/file",
		"/other/file",
		"ssh://alice@host/other/file",
	])("rejects unsafe remote reference %s", async (path) => {
		await expect(prepare([{ path }])).rejects.toThrow();
		expect(service.sftpWriteFile).not.toHaveBeenCalled();
	});

	it("rejects a file or directory symlink escaping the workspace", async () => {
		realpaths.set("/project/link", "/outside/secret");
		await expect(prepare([{ path: "link" }])).rejects.toThrow(/symlink escapes/);
		expect(service.sftpStat).not.toHaveBeenCalled();
	});

	it("requires explicit server authorization for outside absolute references", async () => {
		expect((await prepare([{ path: "/extra/file" }], "Read", { allowAbsolutePaths: true })).text).toContain(
			'"/extra/file"',
		);
		realpaths.set("/project/link", "/outside/file");
		await expect(prepare([{ path: "link" }], "Read", { allowAbsolutePaths: true })).rejects.toThrow(/symlink escapes/);
		await expect(
			prepare([{ path: "ssh://alice@other/extra/file" }], "Read", { allowAbsolutePaths: true }),
		).rejects.toThrow(/another SSH host/);
	});

	it("uploads images, local uploads and materialized host references into one private random batch", async () => {
		const local = uploaded("page snapshot", "页面.md");
		const result = await prepare([
			local,
			{ path: "", imageData: "data:image/png;base64,aW1hZ2U=", name: "../image.png" },
			{ path: "", fileData: "ZmlsZQ==", name: "same.md" },
		]);
		expect(sftp.mkdir).toHaveBeenCalledWith(
			expect.stringMatching(/^\/tmp\/pi-native-cli-[a-f0-9-]{36}$/),
			{ mode: 0o700 },
			expect.any(Function),
		);
		expect(result.paths).toHaveLength(1);
		expect(result.text).not.toContain(local.uploadPath);
		expect(result.text).not.toContain("ssh://");
		expect([...remote.values()].map((bytes) => bytes.toString())).toEqual(["page snapshot", "image", "file"]);
		for (const call of service.sftpWriteFile.mock.calls) {
			expect(call[1]).toMatch(new RegExp(`^${result.paths[0]}/[1-3]-`));
			expect(call[3]).toMatchObject({ flag: "wx", timeoutMs: 30_000, signal: expect.any(AbortSignal) });
		}
		expect(service.execInWorkspace).not.toHaveBeenCalled();
		await Promise.all([result.dispose(), result.dispose()]);
		expect(remote.size).toBe(0);
		expect(result.paths).toEqual([]);
		expect(service.execInWorkspace).toHaveBeenCalledTimes(1);
	});

	it("gives concurrent paste batches distinct directories and file names", async () => {
		const attachment = uploaded();
		const [first, second] = await Promise.all([prepare([attachment]), prepare([attachment])]);
		expect(first.paths[0]).not.toBe(second.paths[0]);
		await first.dispose();
		expect(remote.size).toBe(1);
		await second.dispose();
	});

	it("rejects another client's uploads and arbitrary local files before remote calls", async () => {
		const other = saveUpload("client-b", "private.txt", Buffer.from("private"), dataDir);
		await expect(prepare([{ path: "", uploadPath: other.abs }])).rejects.toThrow(/client's upload/);
		const local = join(dataDir, "private.txt");
		await writeFile(local, "private");
		await expect(prepare([{ path: "", uploadPath: local }])).rejects.toThrow(/client's upload/);
		await expect(prepare([{ path: "", uploadPath: "ssh://alice@host/project/file" }])).rejects.toThrow(
			/local upload path/,
		);
		expect(service.getOrConnectByUri).not.toHaveBeenCalled();
	});

	it("rejects upload-directory symlinks escaping client ownership", async () => {
		const other = saveUpload("client-b", "private.txt", Buffer.from("private"), dataDir);
		await mkdir(join(dataDir, "uploads", "client-a"));
		await symlink(join(dataDir, "uploads", "client-b"), join(dataDir, "uploads", "client-a", "escape"), "junction");
		await expect(
			prepare([
				{ path: "", uploadPath: join(dataDir, "uploads", "client-a", "escape", other.abs.split(/[\\/]/).pop()!) },
			]),
		).rejects.toThrow(/client's upload/);
	});

	it("rejects a symlink replacing the whole client upload directory", async () => {
		const other = saveUpload("client-b", "private.txt", Buffer.from("private"), dataDir);
		await symlink(join(dataDir, "uploads", "client-b"), join(dataDir, "uploads", "client-a"), "junction");
		await expect(
			prepare([{ path: "", uploadPath: join(dataDir, "uploads", "client-a", other.abs.split(/[\\/]/).pop()!) }]),
		).rejects.toThrow(/must not be a symlink/);
	});

	it("explicitly rejects uploaded directories without recursing", async () => {
		await mkdir(join(dataDir, "uploads", "client-a", "directory"), { recursive: true });
		await expect(
			prepare([{ path: "", uploadPath: join(dataDir, "uploads", "client-a", "directory") }]),
		).rejects.toThrow(/upload individual files/);
	});

	it.each(["%%%", "a", "YQ=", "a==="])("rejects invalid base64 %s", async (fileData) => {
		await expect(prepare([{ path: "", fileData }])).rejects.toThrow(/base64/);
		expect(sftp.mkdir).not.toHaveBeenCalled();
	});

	it("enforces the aggregate chat upload limit before creating a directory", async () => {
		const attachment = uploaded("x".repeat(600_000));
		await expect(prepare([attachment, attachment])).rejects.toThrow(/chat upload limit/);
		expect(sftp.mkdir).not.toHaveBeenCalled();
	});

	it("validates final paste bytes before uploading any data", async () => {
		await expect(prepare([uploaded()], "x".repeat(MAX_NATIVE_CLI_PASTE - 1))).rejects.toThrow(/too long/);
		await expect(prepare([], "中".repeat(Math.ceil(MAX_NATIVE_CLI_PASTE / 3)))).rejects.toThrow(/too long/);
		await expect(prepare([{ path: "", mode: "quote", quote: { text: "中".repeat(30_000) } as any }])).rejects.toThrow(
			/too long/,
		);
		expect(sftp.mkdir).not.toHaveBeenCalled();
	});

	it("rejects invalid modes, source ambiguity, line ranges and client identities", async () => {
		await expect(prepare([{ path: "page", mode: "page" }])).rejects.toThrow(/Materialize/);
		await expect(prepare([{ path: "", imageData: "", fileData: "" }])).rejects.toThrow(/Ambiguous/);
		await expect(prepare([{ path: "file", mode: "lines", lines: { start: 3, end: 1 } }])).rejects.toThrow(/line range/);
		await expect(prepare([], "hello", { clientId: "../other" })).rejects.toThrow(/identity/);
		await expect(prepare([], "\x03")).rejects.toThrow(/empty/);
	});

	it("cleans partial uploads after a failed write", async () => {
		service.sftpWriteFile.mockImplementation(async (_cwd: string, path: string) => {
			remote.set(path, Buffer.from("partial"));
			throw new Error("write failed");
		});
		await expect(prepare([uploaded()])).rejects.toThrow(/write failed/);
		expect(remote.size).toBe(0);
		expect(service.execInWorkspace).toHaveBeenCalledTimes(1);
	});

	it("does not remove a directory if exclusive mkdir fails", async () => {
		sftp.mkdir.mockImplementation((_path, _attrs, callback) => callback(new Error("already exists")));
		await expect(prepare([uploaded()])).rejects.toThrow(/already exists/);
		expect(service.execInWorkspace).not.toHaveBeenCalled();
	});

	it("keeps paths available and allows disposal retry after cleanup failure", async () => {
		const result = await prepare([uploaded()]);
		const paths = [...result.paths];
		service.execInWorkspace.mockRejectedValueOnce(new Error("offline"));
		await expect(result.dispose()).rejects.toMatchObject({ paths });
		expect(result.paths).toEqual(paths);
		await result.dispose();
		expect(result.paths).toEqual([]);
	});

	it("exposes retry paths when preparation and rollback both fail", async () => {
		service.sftpWriteFile.mockRejectedValue(new Error("write failure"));
		service.execInWorkspace.mockRejectedValue(new Error("offline"));
		await expect(prepare([uploaded()])).rejects.toMatchObject({
			paths: [expect.stringMatching(/^\/tmp\/pi-native-cli-/)],
			errors: [expect.any(Error), expect.any(AggregateError)],
		});
	});

	it("cancels before connection and cleans cancelled in-flight writes after settlement", async () => {
		const controller = new AbortController();
		controller.abort(new Error("closed"));
		await expect(prepare([], "Read", { signal: controller.signal })).rejects.toThrow(/closed/);
		expect(service.getOrConnectByUri).not.toHaveBeenCalled();
		const active = new AbortController();
		service.sftpWriteFile.mockImplementation(async (_cwd, path, _bytes, opts) => {
			remote.set(path, Buffer.from("partial"));
			active.abort(new Error("CLI closed"));
			expect(opts.signal.aborted).toBe(true);
			throw opts.signal.reason;
		});
		await expect(prepare([uploaded()], "Read", { signal: active.signal })).rejects.toThrow(/CLI closed/);
		expect(remote.size).toBe(0);
	});

	it("removes a directory whose mkdir callback arrives after cancellation", async () => {
		const controller = new AbortController();
		let complete: () => void = () => {
			throw new Error("mkdir not started");
		};
		sftp.mkdir.mockImplementation((path, _attrs, callback) => {
			complete = () => {
				directories.add(path);
				callback();
			};
			controller.abort(new Error("closed during mkdir"));
		});
		await expect(prepare([uploaded()], "Read", { signal: controller.signal })).rejects.toThrow(/closed during mkdir/);
		complete();
		await vi.waitFor(() => expect(service.execInWorkspace).toHaveBeenCalledTimes(1));
		expect([...directories].filter((path) => path.startsWith("/tmp/pi-native-cli-"))).toEqual([]);
	});

	it("retains retry paths if a late mkdir cleanup fails", async () => {
		const controller = new AbortController();
		let complete: () => void = () => {
			throw new Error("mkdir not started");
		};
		sftp.mkdir.mockImplementation((path, _attrs, callback) => {
			complete = () => {
				directories.add(path);
				callback();
			};
			controller.abort(new Error("closed during mkdir"));
		});
		service.execInWorkspace.mockRejectedValueOnce(new Error("offline"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const failure = await prepare([uploaded()], "Read", { signal: controller.signal }).catch(
				(error: unknown) => error,
			);
			expect(failure).toMatchObject({ paths: [] });
			complete();
			await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
			const paths = (failure as Error & { paths: string[] }).paths;
			expect(paths).toHaveLength(1);
			await cleanupRemoteNativeCliFiles(service as any, cwd, paths);
			expect([...directories].filter((path) => path.startsWith("/tmp/pi-native-cli-"))).toEqual([]);
		} finally {
			warning.mockRestore();
		}
	});

	it("reports late mkdir cleanup failures after rejection and contains callback errors", async () => {
		const controller = new AbortController();
		let complete: () => void = () => {
			throw new Error("mkdir not started");
		};
		sftp.mkdir.mockImplementation((path, _attrs, callback) => {
			complete = () => {
				directories.add(path);
				callback();
			};
			controller.abort(new Error("closed during mkdir"));
		});
		service.execInWorkspace.mockRejectedValueOnce(new Error("offline"));
		const retryQueue: Array<readonly string[]> = [];
		const onCleanupFailure = vi.fn((paths: readonly string[]) => {
			retryQueue.push(paths);
			throw new Error("retry queue unavailable");
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await expect(
				prepare([uploaded()], "Read", { signal: controller.signal, onCleanupFailure }),
			).rejects.toMatchObject({ paths: [] });
			expect(onCleanupFailure).not.toHaveBeenCalled();
			complete();
			await vi.waitFor(() => expect(onCleanupFailure).toHaveBeenCalledTimes(1));
			expect(retryQueue[0]).toEqual([expect.stringMatching(/^\/tmp\/pi-native-cli-/)]);
			expect(warning).toHaveBeenCalledWith("Remote CLI cleanup failure callback failed", expect.any(Error));
			await cleanupRemoteNativeCliFiles(service as any, cwd, retryQueue[0]);
			expect([...directories].filter((path) => path.startsWith("/tmp/pi-native-cli-"))).toEqual([]);
		} finally {
			warning.mockRestore();
		}
	});

	it("bounds a stalled remote realpath request", async () => {
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		try {
			sftp.realpath.mockImplementation(() => undefined);
			const promise = prepare([{ path: "file" }]);
			const assertion = expect(promise).rejects.toThrow(/deadline exceeded/);
			await vi.waitFor(() => expect(sftp.realpath).toHaveBeenCalled());
			expect(timeout).toHaveBeenCalledWith(30_000);
			deadline.abort(new Error("deadline exceeded"));
			await assertion;
		} finally {
			timeout.mockRestore();
		}
	});
});

describe("cleanupRemoteNativeCliFiles", () => {
	it.each([
		"/",
		"/tmp",
		"/tmp/pi-native-cli-other",
		"/tmp/pi-native-cli-11111111-1111-1111-1111-111111111111/../other",
		"ssh://alice@other/tmp/stage",
	])("refuses arbitrary cleanup path %s", async (path) => {
		await expect(cleanupRemoteNativeCliFiles(service as any, cwd, [path])).rejects.toThrow(/Invalid/);
		expect(service.execInWorkspace).not.toHaveBeenCalled();
	});
});
