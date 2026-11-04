import { mkdtemp, readFile, rm, writeFile, readdir, truncate, open, symlink, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	persistContextEvidence,
	copyContextEvidence,
	removeContextEvidence,
	contextEvidenceReference,
	withContextEvidenceRead,
	buildContextEvidenceIndex,
} from "../../server/context-evidence.js";
import { externalizeRequestEvidence, requestContextExtension } from "../../server/request-context.js";

const directories: string[] = [];
async function session() {
	const directory = await mkdtemp(join(tmpdir(), "context-evidence-"));
	directories.push(directory);
	const file = join(directory, "session.jsonl");
	await writeFile(file, "");
	return file;
}
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const text = "line of evidence\n".repeat(3000);
function result(toolName = "read", content: any[] = [{ type: "text", text }]): any {
	return { role: "toolResult", toolName, toolCallId: "call-1", isError: false, content };
}

describe("persistent context evidence", () => {
	it("builds a deterministic bounded index from hash filenames without reading bodies", async () => {
		const file = await session();
		expect(await buildContextEvidenceIndex(file)).toBe("");
		await mkdir(`${file}.evidence`);
		expect(await buildContextEvidenceIndex(file)).toBe("");
		const hashes = Array.from({ length: 35 }, (_, index) => index.toString(16).padStart(64, "0"));
		for (const hash of hashes.slice().reverse())
			await writeFile(join(`${file}.evidence`, `${hash}.txt`), "body must not appear");
		await writeFile(join(`${file}.evidence`, "notes.txt"), "ignored");
		await writeFile(join(`${file}.evidence`, ".pending.tmp"), "ignored");
		await mkdir(join(`${file}.evidence`, `${"f".repeat(64)}.txt`));
		const index = await buildContextEvidenceIndex(file);
		expect(index.split("\n")).toEqual([
			"[Context evidence: 35 files. Read context-evidence:index for the complete directory listing.]",
			...hashes.slice(0, 32).map((hash) => `context-evidence:${hash}`),
		]);
		expect(index).not.toContain("body must not appear");
		expect(index).not.toContain(file);
		expect(await buildContextEvidenceIndex(file)).toBe(index);
	});

	it("resolves the index alias through the guarded reader for the current session", async () => {
		const first = await session();
		const second = await session();
		await persistContextEvidence(first, text);
		await persistContextEvidence(second, text + "second");
		let current = first;
		const execute = vi.fn(async (_id: string, params: any) => ({
			content: [{ type: "text", text: (await readdir(params.path)).join("\n") }],
		}));
		const reader = withContextEvidenceRead({ execute } as any, () => current);
		const invoke = (signal?: AbortSignal) =>
			reader.execute("id", { file_path: "context-evidence:index", limit: 100 }, signal, undefined, {} as any);
		await invoke();
		expect(execute.mock.calls[0][1]).toEqual({ path: `${first}.evidence`, file_path: `${first}.evidence`, limit: 100 });
		current = second;
		await invoke();
		expect(execute.mock.calls[1][1].path).toBe(`${second}.evidence`);
		execute.mockRejectedValueOnce(new Error("permission denied"));
		await expect(invoke()).rejects.toThrow("permission denied");
		const controller = new AbortController();
		controller.abort(new Error("index cancelled"));
		await expect(invoke(controller.signal)).rejects.toThrow("index cancelled");
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("validates SDK-resolved artifact paths before the base reader, including relative paths", async () => {
		const file = await session();
		const artifact = (await persistContextEvidence(file, text))!;
		const execute = vi.fn(async () => ({ content: [] }));
		const reader = withContextEvidenceRead({ execute } as any, () => file);
		const invoke = (path: string) =>
			reader.execute("id", { path }, undefined, undefined, { cwd: process.cwd() } as any);
		await invoke(artifact);
		await invoke(relative(process.cwd(), artifact));
		expect(execute).toHaveBeenCalledTimes(2);
		await writeFile(artifact, "corrupt");
		await expect(invoke(artifact)).rejects.toThrow("integrity");
		await expect(invoke(relative(process.cwd(), artifact))).rejects.toThrow("integrity");
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("keeps resolved-path validation scoped to the current session and direct children", async () => {
		const file = await session();
		const other = await session();
		const artifact = (await persistContextEvidence(other, text))!;
		await writeFile(artifact, "corrupt in another session");
		const execute = vi.fn(async () => ({ content: [] }));
		const reader = withContextEvidenceRead({ execute } as any, () => file);
		for (const path of [
			artifact,
			join(`${file}.evidence-other`, `${"a".repeat(64)}.txt`),
			join(`${file}.evidence`, "nested", `${"a".repeat(64)}.txt`),
			join(`${file}.evidence`, "notes.txt"),
		]) {
			const params = { path };
			await reader.execute("id", params, undefined, undefined, {} as any);
			expect((execute.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toBe(params);
		}
		expect(execute).toHaveBeenCalledTimes(4);
	});

	it("validates the resolved index directory and preserves permission guard behavior", async () => {
		const file = await session();
		await persistContextEvidence(file, text);
		const execute = vi.fn().mockRejectedValue(new Error("permission denied"));
		const reader = withContextEvidenceRead({ execute } as any, () => file);
		await expect(reader.execute("id", { path: `${file}.evidence` }, undefined, undefined, {} as any)).rejects.toThrow(
			"permission denied",
		);
		expect(execute).toHaveBeenCalledTimes(1);
		await removeContextEvidence(file);
		await writeFile(`${file}.evidence`, "not a directory");
		await expect(reader.execute("id", { path: `${file}.evidence` }, undefined, undefined, {} as any)).rejects.toThrow(
			"directory",
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("queues index construction after pending evidence persistence", async () => {
		const file = await session();
		const pending = persistContextEvidence(file, text);
		const index = buildContextEvidenceIndex(file);
		await pending;
		expect(await index).toContain(contextEvidenceReference(text));
	});

	it("rejects cancelled persistence, copies and ordinary reads before doing work", async () => {
		const file = await session();
		const child = await session();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(persistContextEvidence(file, text, controller.signal)).rejects.toThrow("cancelled");
		await expect(copyContextEvidence(file, child, controller.signal)).rejects.toThrow("cancelled");
		const execute = vi.fn();
		const reader = withContextEvidenceRead({ execute } as any, () => file);
		await expect(reader.execute("id", { path: file }, controller.signal, undefined, {} as any)).rejects.toThrow(
			"cancelled",
		);
		expect(execute).not.toHaveBeenCalled();
		await expect(readdir(`${file}.evidence`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not run a cancelled write queued behind an active reader", async () => {
		const file = await session();
		await persistContextEvidence(file, text);
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const reader = withContextEvidenceRead(
			{
				execute: async () => {
					entered();
					await waiting;
					return { content: [] };
				},
			} as any,
			() => file,
		);
		const active = reader.execute("id", { path: contextEvidenceReference(text) }, undefined, undefined, {} as any);
		await started;
		const controller = new AbortController();
		const queued = persistContextEvidence(file, text + "cancelled", controller.signal);
		const rejected = expect(queued).rejects.toThrow("queued cancellation");
		controller.abort(new Error("queued cancellation"));
		release();
		await active;
		await rejected;
		expect(await readdir(`${file}.evidence`)).toHaveLength(1);
		expect(await persistContextEvidence(file, text + "usable")).toBeTruthy();
	});

	it("cleans a cancelled persistence write and allows the next writer to proceed", async () => {
		const file = await session();
		const probe = await open(file, "r");
		const prototype = Object.getPrototypeOf(probe);
		await probe.close();
		const original = prototype.writeFile;
		const controller = new AbortController();
		vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: any, ...args: any[]) {
			const result = await original.apply(this, args);
			controller.abort(new Error("persistence cancelled"));
			return result;
		});
		await expect(persistContextEvidence(file, text, controller.signal)).rejects.toThrow("persistence cancelled");
		expect(await readdir(`${file}.evidence`)).toEqual([]);
		vi.restoreAllMocks();
		expect(await persistContextEvidence(file, text)).toBeTruthy();
	});

	it("checks digests and size before calling the guarded reader, and preserves permission errors", async () => {
		const file = await session();
		const artifact = (await persistContextEvidence(file, text))!;
		const execute = vi.fn().mockRejectedValue(new Error("permission denied"));
		const reader = withContextEvidenceRead({ execute } as any, () => file);
		const invoke = () =>
			reader.execute("id", { file_path: contextEvidenceReference(text), limit: 2 }, undefined, undefined, {} as any);
		await expect(invoke()).rejects.toThrow("permission denied");
		expect(execute.mock.calls[0][1]).toMatchObject({ path: artifact, file_path: artifact, limit: 2 });
		execute.mockClear();
		await writeFile(artifact, "broken");
		await expect(invoke()).rejects.toThrow("integrity");
		await truncate(artifact, 128 * 1024 * 1024);
		await expect(invoke()).rejects.toThrow("budget");
		expect(execute).not.toHaveBeenCalled();
	});

	it("fails when the guarded reader changes evidence or aborts", async () => {
		const file = await session();
		const artifact = (await persistContextEvidence(file, text))!;
		const controller = new AbortController();
		const execute = vi.fn(async () => {
			controller.abort(new Error("reader cancelled"));
			return { content: [] };
		});
		const reader = withContextEvidenceRead({ execute } as any, () => file);
		await expect(
			reader.execute("id", { path: contextEvidenceReference(text) }, controller.signal, undefined, {} as any),
		).rejects.toThrow("reader cancelled");
		execute.mockImplementation(async () => {
			await writeFile(artifact, "broken");
			return { content: [] };
		});
		await expect(
			reader.execute("id", { path: contextEvidenceReference(text) }, undefined, undefined, {} as any),
		).rejects.toThrow("integrity");
	});

	it("serializes opposite-direction copies without deadlock and preserves all evidence", async () => {
		const first = await session();
		const second = await session();
		await persistContextEvidence(first, text);
		await persistContextEvidence(second, text + "second");
		await Promise.all([
			copyContextEvidence(first, second),
			copyContextEvidence(second, first),
			persistContextEvidence(first, text + "third"),
		]);
		await copyContextEvidence(first, second);
		expect((await readdir(`${first}.evidence`)).sort()).toEqual((await readdir(`${second}.evidence`)).sort());
		expect(await readdir(`${first}.evidence`)).toHaveLength(3);
	}, 10000);

	it("rejects a corrupt existing destination instead of silently retaining a broken reference", async () => {
		const first = await session();
		const second = await session();
		await persistContextEvidence(first, text);
		const target = (await persistContextEvidence(second, text))!;
		await writeFile(target, "broken");
		await expect(copyContextEvidence(first, second)).rejects.toThrow("integrity");
		expect(await readFile(target, "utf8")).toBe("broken");
	});

	it("preflights the complete copy budget before writing artifacts", async () => {
		const first = await session();
		const second = await session();
		await persistContextEvidence(first, text);
		await persistContextEvidence(first, text + "extra");
		const seed = (await persistContextEvidence(second, "seed"))!;
		await truncate(seed, 64 * 1024 * 1024 - Buffer.byteLength(text));
		await expect(copyContextEvidence(first, second)).rejects.toThrow("budget");
		expect(await readdir(`${second}.evidence`)).toHaveLength(1);
	});

	it("rejects symlink artifacts and evidence directories", async (ctx) => {
		const first = await session();
		const second = await session();
		const artifact = (await persistContextEvidence(first, text))!;
		const outside = join(first + ".outside");
		await writeFile(outside, text);
		await rm(artifact);
		try {
			await symlink(outside, artifact, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") {
				ctx.skip();
				return;
			}
			throw error;
		}
		expect(await persistContextEvidence(first, text)).toBeUndefined();
		await expect(copyContextEvidence(first, second)).rejects.toThrow("artifact");
		await rm(`${first}.evidence`, { recursive: true });
		const directory = join(first + ".outside-dir");
		await mkdir(directory);
		await symlink(directory, `${first}.evidence`, process.platform === "win32" ? "junction" : "dir");
		expect(await persistContextEvidence(first, text)).toBeUndefined();
		await expect(copyContextEvidence(first, second)).rejects.toThrow("directory");
	});

	it("bounds streamed copy reads and cleans temporary files on mid-copy cancellation", async () => {
		const first = await session();
		const second = await session();
		const artifact = (await persistContextEvidence(first, "x".repeat(1024 * 1024)))!;
		const probe = await open(artifact, "r");
		const prototype = Object.getPrototypeOf(probe);
		await probe.close();
		const original = prototype.read;
		const controller = new AbortController();
		let reads = 0;
		vi.spyOn(prototype, "read").mockImplementation(async function (this: any, ...args: any[]) {
			expect(args[2]).toBeLessThanOrEqual(64 * 1024);
			const result = await original.apply(this, args);
			if (++reads === 2) controller.abort(new Error("copy cancelled"));
			return result;
		});
		await expect(copyContextEvidence(first, second, controller.signal)).rejects.toThrow("copy cancelled");
		expect(reads).toBe(2);
		expect(await readdir(`${second}.evidence`)).toEqual([]);
		vi.restoreAllMocks();
		await copyContextEvidence(first, second);
		expect(await stat(join(`${second}.evidence`, (await readdir(`${second}.evidence`))[0]))).toMatchObject({
			size: 1024 * 1024,
		});
	});

	it("checks opened file identity after a pathname replacement", async () => {
		const first = await session();
		const second = await session();
		const artifact = (await persistContextEvidence(first, text))!;
		const probe = await open(artifact, "r");
		const prototype = Object.getPrototypeOf(probe);
		await probe.close();
		const original = prototype.stat;
		let replaced = false;
		vi.spyOn(prototype, "stat").mockImplementation(async function (this: any, ...args: any[]) {
			const info = await original.apply(this, args);
			if (!replaced && info.size === Buffer.byteLength(text)) {
				replaced = true;
				await rm(artifact);
				await writeFile(artifact, text);
			}
			return info;
		});
		try {
			await expect(copyContextEvidence(first, second)).rejects.toThrow("changed while opening");
			expect(replaced).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("detects growth after fstat without consuming the enlarged file", async () => {
		const first = await session();
		const second = await session();
		const artifact = (await persistContextEvidence(first, text))!;
		const probe = await open(artifact, "r");
		const prototype = Object.getPrototypeOf(probe);
		await probe.close();
		const original = prototype.read;
		let reads = 0;
		vi.spyOn(prototype, "read").mockImplementation(async function (this: any, ...args: any[]) {
			if (++reads === 1) await truncate(artifact, 128 * 1024 * 1024);
			return original.apply(this, args);
		});
		await expect(copyContextEvidence(first, second)).rejects.toThrow("changed");
		expect(reads).toBeLessThanOrEqual(2);
		expect(await readdir(`${second}.evidence`)).toEqual([]);
	});
	it("externalizes only older results when over budget and preserves recent result identities", async () => {
		const file = await session();
		const messages = [0, 1, 2].map((index) => ({
			...result("read", [{ type: "text", text: text + index }]),
			toolCallId: `call-${index}`,
		}));
		const output = await externalizeRequestEvidence(messages, file, { keepRecentResults: 2, messageTokens: 0 });
		expect(output).not.toBe(messages);
		expect(output[0]).not.toBe(messages[0]);
		expect(JSON.stringify(output[0])).toContain(contextEvidenceReference(text + "0"));
		expect(output[1]).toBe(messages[1]);
		expect(output[2]).toBe(messages[2]);
		expect(await readdir(`${file}.evidence`)).toHaveLength(1);
	});

	it("keeps all results within the token budget and rejects pre-aborted externalization", async () => {
		const file = await session();
		const messages = [0, 1, 2].map((index) => ({
			...result("read", [{ type: "text", text: text + index }]),
			toolCallId: `call-${index}`,
		}));
		expect(await externalizeRequestEvidence(messages, file, { keepRecentResults: 2, messageTokens: 1e9 })).toBe(
			messages,
		);
		const controller = new AbortController();
		controller.abort(new Error("externalization cancelled"));
		await expect(externalizeRequestEvidence(messages, file, { signal: controller.signal })).rejects.toThrow(
			"externalization cancelled",
		);
		await expect(readdir(`${file}.evidence`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes evidence with deleted transcripts and rejects late writers", async () => {
		const file = await session();
		await persistContextEvidence(file, text);
		await rm(file);
		await Promise.all([removeContextEvidence(file), persistContextEvidence(file, text + "late")]);
		await expect(readdir(`${file}.evidence`)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await persistContextEvidence(file, text)).toBeUndefined();
		await removeContextEvidence(file);
	});

	it("can rebuild evidence while the transcript still exists", async () => {
		const file = await session();
		await persistContextEvidence(file, text);
		await removeContextEvidence(file);
		expect(await persistContextEvidence(file, text)).toBeTruthy();
	});

	it("resolves the same reference in a relocated session before the guarded reader", async () => {
		const first = await session();
		const second = await session();
		await persistContextEvidence(first, text);
		await persistContextEvidence(second, text);
		let current = first;
		const paths: string[] = [];
		const reader = withContextEvidenceRead(
			{
				name: "read",
				execute: async (_id: string, params: any) => {
					paths.push(params.path);
					expect(params.offset).toBe(10);
					return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
				},
			} as any,
			() => current,
		);
		const invoke = () =>
			reader.execute(
				"call",
				{ path: contextEvidenceReference(text), offset: 10 } as any,
				undefined,
				undefined,
				{} as any,
			);
		await invoke();
		current = second;
		await invoke();
		expect(paths[0]).toContain(`${first}.evidence`);
		expect(paths[1]).toContain(`${second}.evidence`);
		await expect(
			reader.execute("call", { path: "context-evidence:../../secret" } as any, undefined, undefined, {} as any),
		).rejects.toThrow("Invalid evidence");
	});

	it("inherits independent evidence that survives deletion of the parent session", async () => {
		const parent = await session();
		const child = await session();
		await persistContextEvidence(parent, text);
		await copyContextEvidence(parent, child);
		await rm(parent);
		await removeContextEvidence(parent);
		const digest = contextEvidenceReference(text).split(":")[1];
		expect(await readFile(join(`${child}.evidence`, `${digest}.txt`), "utf8")).toBe(text);
		await copyContextEvidence(child, child);
	});

	it("handles a parent without evidence and rejects corrupt inherited evidence", async () => {
		const parent = await session();
		const child = await session();
		await copyContextEvidence(parent, child);
		const artifact = (await persistContextEvidence(parent, text))!;
		await writeFile(artifact, "corrupt");
		await expect(copyContextEvidence(parent, child)).rejects.toThrow("integrity");
	});

	it("is complete, stable across repeated calls and scoped by session", async () => {
		const file = await session();
		const first = await persistContextEvidence(file, text);
		expect(first).toBeTruthy();
		expect(await readFile(first!, "utf8")).toBe(text);
		expect(await persistContextEvidence(file, text)).toBe(first);
		expect(await persistContextEvidence(await session(), text)).not.toBe(first);
		expect(await readdir(`${file}.evidence`)).toHaveLength(1);
	});

	it("serializes concurrent writes so a full directory cannot overshoot its budget", async () => {
		const file = await session();
		const seed = (await persistContextEvidence(file, "seed"))!;
		await truncate(seed, 64 * 1024 * 1024 - Buffer.byteLength(text));
		const results = await Promise.all([
			persistContextEvidence(file, text),
			persistContextEvidence(file, text.replace("line", "LINE")),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await readdir(`${file}.evidence`)).toHaveLength(2);
	});

	it("reuses a single complete artifact for concurrent identical writes", async () => {
		const file = await session();
		const results = await Promise.all(Array.from({ length: 5 }, () => persistContextEvidence(file, text)));
		expect(results[0]).toBeTruthy();
		expect(new Set(results).size).toBe(1);
		expect(await readdir(`${file}.evidence`)).toHaveLength(1);
		expect(await readFile(results[0]!, "utf8")).toBe(text);
	});

	it("keeps full output for SSH workspaces and when read is disabled", async () => {
		const file = await session();
		for (const [cwd, activeTools] of [
			["ssh://user@host/project", ["read"]],
			["/workspace", []],
		] as const) {
			let handler: any;
			requestContextExtension({
				on: (_: string, callback: any) => {
					handler = callback;
				},
				getActiveTools: () => activeTools,
			} as any);
			const messages = [result()];
			const output = await handler({ messages }, { cwd, sessionManager: { getSessionFile: () => file } });
			expect(output.messages).toBe(messages);
		}
	});

	it("does not trust a damaged artifact or replace its contents", async () => {
		const file = await session();
		const path = (await persistContextEvidence(file, text))!;
		await writeFile(path, "damaged");
		expect(await persistContextEvidence(file, text)).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe("damaged");
	});

	it("preserves original output when the session evidence budget is exhausted", async () => {
		const file = await session();
		const artifact = (await persistContextEvidence(file, "existing"))!;
		await truncate(artifact, 64 * 1024 * 1024);
		const messages = [result()];
		expect(await externalizeRequestEvidence(messages, file)).toBe(messages);
	});

	it("rejects oversized evidence and degrades gracefully on write failure", async () => {
		const file = await session();
		expect(await persistContextEvidence(file, "x".repeat(1024 * 1024 + 1))).toBeUndefined();
		await writeFile(`${file}.evidence`, "not a directory");
		const messages = [result()];
		expect(await externalizeRequestEvidence(messages, file)).toBe(messages);
	});

	it("keeps original messages and pairs, replacing only request content after persistence", async () => {
		const file = await session();
		const messages = [result()];
		const before = structuredClone(messages);
		const output = await externalizeRequestEvidence(messages, file);
		expect(messages).toEqual(before);
		expect(output[0]).toMatchObject({ role: "toolResult", toolCallId: "call-1" });
		expect(JSON.stringify(output).length).toBeLessThan(JSON.stringify(messages).length / 4);
		const path = join(`${file}.evidence`, (await readdir(`${file}.evidence`))[0]);
		expect(JSON.stringify(output)).toContain("Full UTF-8 evidence file");
		expect(await readFile(path, "utf8")).toBe(text);
		expect(await externalizeRequestEvidence(messages, file)).toEqual(output);
	});

	it.each([
		"/tmp/session.jsonl.evidence/hash.txt",
		"C:\\sessions\\a.jsonl.evidence\\hash.txt",
		contextEvidenceReference(text),
	])("does not externalize evidence reads again: %s", async (path) => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path } }] },
			result(),
		];
		expect(await externalizeRequestEvidence(messages as any, await session())).toBe(messages);
	});

	it("preserves errors, images, signed text, structured results and side-effect tools", async () => {
		const messages = [
			{ ...result(), isError: true },
			result("bash"),
			result("plugin_read"),
			result("read", [{ type: "image", data: "x", mimeType: "image/png" }]),
			result("read", [{ type: "text", text, signature: "signed" }]),
			{ ...result(), structuredContent: { value: 1 } },
		];
		expect(await externalizeRequestEvidence(messages, await session())).toBe(messages);
	});
});
