import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NATIVE_CLI_PASTE, prepareNativeCliPaste } from "../../server/native-cli.js";
import { materializeNativeCliReferences, type NativeCliReferenceContext } from "../../server/native-cli-references.js";
import type { CanvasGraph, PromptAttachment } from "../../server/protocol.js";
import * as uploads from "../../server/uploads.js";

let root: string;
let context: NativeCliReferenceContext;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-native-cli-references-"));
	vi.stubEnv("PI_WEB_DATA_DIR", root);
	context = {
		clientId: "reference-client",
		settings: { chatUploadMaxMb: 1 },
		dataDir: root,
		readPage: vi.fn<NativeCliReferenceContext["readPage"]>(async () => ({
			ok: true,
			result: { text: "Real page body\n第二段正文" },
		})),
		readConversation: vi.fn<NativeCliReferenceContext["readConversation"]>(async () => ({
			name: "Design discussion",
			path: "/sessions/design.jsonl",
			cwd: "/work/project",
			messages: [
				{ role: "user", content: "Original question\n问题原文" },
				{ role: "assistant", content: "Actual answer\n回答原文" },
			],
		})),
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function quote(text: string): PromptAttachment {
	return { path: "", mode: "quote", quote: { text, messageId: "m1", role: "assistant", sessionId: "c1" } };
}
function exportedText(attachment: PromptAttachment): string {
	expect(attachment.mode).toBeUndefined();
	expect(attachment.path).toBe("");
	expect(isAbsolute(attachment.uploadPath!)).toBe(true);
	expect(attachment.uploadPath).toContain(join(root, "uploads", context.clientId));
	expect(statSync(attachment.uploadPath!).size).toBe(attachment.size);
	return readFileSync(attachment.uploadPath!, "utf8");
}
function savedFiles(): string[] {
	const directory = join(root, "uploads", context.clientId);
	return existsSync(directory) ? readdirSync(directory) : [];
}
function writeGraph(id = "workflow"): CanvasGraph {
	const graph: CanvasGraph = {
		id,
		name: "Authorized workflow",
		nodes: [],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		status: "idle",
		createdAt: 1,
		updatedAt: 2,
	};
	mkdirSync(join(root, "canvas"), { recursive: true });
	writeFileSync(join(root, "canvas", `${id}.json`), JSON.stringify(graph));
	return graph;
}

describe("native CLI readable references", () => {
	it("returns an empty list for absent attachments without reading sources", async () => {
		expect(await materializeNativeCliReferences(undefined, context)).toEqual([]);
		expect(context.readPage).not.toHaveBeenCalled();
		expect(context.readConversation).not.toHaveBeenCalled();
		expect(savedFiles()).toEqual([]);
	});

	it("preserves ordinary file, line, image, raw upload and owned upload objects", async () => {
		const uploaded = uploads.saveUpload(context.clientId, "existing.txt", Buffer.from("existing"), root);
		const attachments: PromptAttachment[] = [
			{ path: "README.md", mode: "reference" },
			{ path: "code.ts", mode: "lines", lines: { start: 2, end: 7 } },
			{ path: "", imageData: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" },
			{ path: "", fileData: "data:text/plain;base64,Ynl0ZXM=", name: "bytes.txt" },
			{ path: "", uploadPath: uploaded.abs },
		];
		const result = await materializeNativeCliReferences(attachments, context);
		result.forEach((attachment, index) => expect(attachment).toBe(attachments[index]));
		expect(savedFiles()).toHaveLength(1);
		expect(context.readPage).not.toHaveBeenCalled();
		expect(context.readConversation).not.toHaveBeenCalled();
	});

	it("preserves a small quote's exact source text and provenance", async () => {
		const attachment = quote(" Original \r\n  source\t内容\n");
		const [result] = await materializeNativeCliReferences([attachment], context);
		expect(result).toBe(attachment);
		expect(result.quote?.text).toBe(" Original \r\n  source\t内容\n");
		expect(savedFiles()).toEqual([]);
	});

	it("stores long quotes as real UTF-8 files without truncating or normalizing source text", async () => {
		const text = "原始引文\r\n\t".repeat(12_000);
		const [result] = await materializeNativeCliReferences([quote(text)], context);
		expect(exportedText(result)).toBe(text);
		expect(result.mimeType).toBe("text/plain");
		const paste = prepareNativeCliPaste("Read the reference", [result], root, context);
		expect(paste).toContain(JSON.stringify(result.uploadPath));
		expect(paste).not.toContain("原始引文");
		expect(Buffer.byteLength(paste)).toBeLessThan(MAX_NATIVE_CLI_PASTE);
	});

	it.each(["a".repeat(MAX_NATIVE_CLI_PASTE - 1024), "文".repeat(Math.floor((MAX_NATIVE_CLI_PASTE - 1024) / 3))])(
		"externalizes a short quote when the original prompt uses the UTF-8 paste budget",
		async (pasteText) => {
			context.pasteText = pasteText;
			const [result] = await materializeNativeCliReferences([quote("source text".repeat(150))], context);
			expect(exportedText(result)).toBe("source text".repeat(150));
			expect(Buffer.byteLength(prepareNativeCliPaste(pasteText, [result], root, context))).toBeLessThanOrEqual(
				MAX_NATIVE_CLI_PASTE,
			);
		},
	);

	it("budgets multiple quotes together rather than inlining every individually small quote", async () => {
		const attachments = [quote("a".repeat(4000)), quote("b".repeat(4000)), quote("c".repeat(4000))];
		const result = await materializeNativeCliReferences(attachments, context);
		expect(result[0]).toBe(attachments[0]);
		expect(result[1]).toBe(attachments[1]);
		expect(exportedText(result[2])).toBe("c".repeat(4000));
	});

	it.each(["123", "https://authorized.example"])(
		"reads only the explicitly authorized page target %s",
		async (target) => {
			const signal = new AbortController().signal;
			context.signal = signal;
			const [result] = await materializeNativeCliReferences(
				[{ path: target, mode: "page", name: "Page title" }],
				context,
			);
			expect(context.readPage).toHaveBeenCalledExactlyOnceWith(
				{ op: "read", target, args: { what: "text" }, timeoutMs: 30_000 },
				signal,
			);
			expect(exportedText(result)).toBe(`Page: Page title\nTarget: ${target}\n\nReal page body\n第二段正文`);
			expect(context.readConversation).not.toHaveBeenCalled();
		},
	);

	it("accepts a page bridge returning a plain string body", async () => {
		vi.mocked(context.readPage).mockResolvedValue({ ok: true, result: "Exact body\nNew line" });
		const [result] = await materializeNativeCliReferences([{ path: "tab-3", mode: "page" }], context);
		expect(exportedText(result)).toContain("Exact body\nNew line");
	});

	it.each([
		{ ok: false as const, error: "Page permission denied" },
		{ ok: true as const, result: { error: "Page disconnected" } },
		{ ok: true as const, result: { title: "Metadata alone", url: "https://example.com" } },
		{ ok: true as const, result: { text: " \n" } },
		{ ok: true as const },
	])("rejects failed or content-free page reads without exporting metadata: %j", async (response) => {
		vi.mocked(context.readPage).mockResolvedValue(response);
		await expect(materializeNativeCliReferences([{ path: "allowed-tab", mode: "page" }], context)).rejects.toThrow(
			/Unable to materialize native CLI page reference/,
		);
		expect(savedFiles()).toEqual([]);
	});

	it.each([
		{ conversationId: "c3" },
		{ sessionPath: "/sessions/history.jsonl" },
		{ conversationId: "c3", sessionPath: "/sessions/history.jsonl" },
	])("exports actual conversation messages for explicit source %j", async (source) => {
		const [result] = await materializeNativeCliReferences([{ path: "", mode: "conversation", ...source }], context);
		expect(context.readConversation).toHaveBeenCalledExactlyOnceWith(
			{
				kind: "conversation",
				...(source.conversationId ? { conversationId: source.conversationId } : {}),
				...(source.sessionPath ? { sessionFile: source.sessionPath } : {}),
			},
			expect.any(AbortSignal),
		);
		const text = exportedText(result);
		expect(text).toContain("Conversation: Design discussion");
		expect(text).toContain("Session: /sessions/design.jsonl");
		expect(text).toContain("Workspace: /work/project");
		expect(text).toContain("User:\nOriginal question\n问题原文\n\nAssistant:\nActual answer\n回答原文");
	});

	it("rejects a conversation with no explicit identity instead of reading the active conversation", async () => {
		await expect(materializeNativeCliReferences([{ path: "", mode: "conversation" }], context)).rejects.toThrow(
			/requires a conversation ID or session path/,
		);
		expect(context.readConversation).not.toHaveBeenCalled();
	});

	it.each([undefined, { name: "Empty conversation", messages: [] }])(
		"rejects missing or unreadable conversation content: %j",
		async (snapshot) => {
			vi.mocked(context.readConversation).mockResolvedValue(snapshot);
			await expect(
				materializeNativeCliReferences([{ path: "", mode: "conversation", conversationId: "c3" }], context),
			).rejects.toThrow(/Unable to materialize native CLI conversation reference/);
			expect(savedFiles()).toEqual([]);
		},
	);

	it("exports an existing canvas as JSON without modifying or running it", async () => {
		const graph = writeGraph();
		const source = join(root, "canvas", "workflow.json");
		const before = statSync(source);
		const [result] = await materializeNativeCliReferences([{ path: graph.id, mode: "canvas" }], context);
		expect(JSON.parse(exportedText(result))).toEqual(graph);
		expect(result.mimeType).toBe("application/json");
		expect(readFileSync(source, "utf8")).toBe(JSON.stringify(graph));
		expect(statSync(source).mtimeMs).toBe(before.mtimeMs);
		expect(context.readPage).not.toHaveBeenCalled();
		expect(context.readConversation).not.toHaveBeenCalled();
	});

	it.each(["default", "missing", "../outside"])(
		"rejects missing or unsafe canvas %s without initialization",
		async (id) => {
			await expect(materializeNativeCliReferences([{ path: id, mode: "canvas" }], context)).rejects.toThrow(
				/Unable to materialize native CLI canvas reference/,
			);
			expect(existsSync(join(root, "canvas"))).toBe(false);
			expect(savedFiles()).toEqual([]);
		},
	);

	it("rejects corrupt canvas JSON instead of exporting its ID", async () => {
		writeGraph();
		writeFileSync(join(root, "canvas", "workflow.json"), "{ invalid json");
		await expect(materializeNativeCliReferences([{ path: "workflow", mode: "canvas" }], context)).rejects.toThrow(
			/Unable to materialize native CLI canvas reference/,
		);
		expect(savedFiles()).toEqual([]);
	});

	it("does not save any export when a later reference fails", async () => {
		vi.mocked(context.readConversation).mockRejectedValue(new Error("Explicit reference denied"));
		await expect(
			materializeNativeCliReferences(
				[
					{ path: "page", mode: "page" },
					{ path: "", mode: "conversation", conversationId: "c3" },
				],
				context,
			),
		).rejects.toThrow(/Explicit reference denied/);
		expect(savedFiles()).toEqual([]);
	});

	it("combines raw uploads and generated references in the same chat upload limit", async () => {
		vi.mocked(context.readPage).mockResolvedValue({ ok: true, result: { text: "p".repeat(600_000) } });
		const raw: PromptAttachment = { path: "", fileData: Buffer.alloc(600_000).toString("base64") };
		await expect(materializeNativeCliReferences([raw, { path: "page", mode: "page" }], context)).rejects.toThrow(
			/chat upload limit/,
		);
		expect(savedFiles()).toEqual([]);
	});

	it("combines previously saved uploads and generated content in the same limit", async () => {
		const saved = uploads.saveUpload(context.clientId, "owned.bin", Buffer.alloc(700_000), root);
		await expect(
			materializeNativeCliReferences([{ path: "", uploadPath: saved.abs }, quote("q".repeat(400_000))], context),
		).rejects.toThrow(/chat upload limit/);
		expect(savedFiles()).toHaveLength(1);
	});

	it("rejects an oversized generated reference without truncating it", async () => {
		await expect(materializeNativeCliReferences([quote("文".repeat(400_000))], context)).rejects.toThrow(
			/chat upload limit/,
		);
		expect(savedFiles()).toEqual([]);
	});

	it("rejects uploads owned by another client before reading additional sources", async () => {
		const saved = uploads.saveUpload("another-client", "private.txt", Buffer.from("private"), root);
		await expect(
			materializeNativeCliReferences(
				[
					{ path: "", uploadPath: saved.abs },
					{ path: "page", mode: "page" },
				],
				context,
			),
		).rejects.toThrow(/different client|outside uploads/);
		expect(context.readPage).not.toHaveBeenCalled();
	});

	it("rejects invalid client identity before reading or writing references", async () => {
		context.clientId = "../another-client";
		await expect(materializeNativeCliReferences([{ path: "page", mode: "page" }], context)).rejects.toThrow(
			/Invalid upload client identity/,
		);
		expect(context.readPage).not.toHaveBeenCalled();
	});

	it("rejects ambiguous sources and more than 32 attachments", async () => {
		await expect(
			materializeNativeCliReferences([{ path: "page", mode: "page", fileData: "YQ==" }], context),
		).rejects.toThrow(/Ambiguous native CLI reference source/);
		await expect(
			materializeNativeCliReferences(
				Array.from({ length: 33 }, () => quote("text")),
				context,
			),
		).rejects.toThrow(/max 32/);
		expect(context.readPage).not.toHaveBeenCalled();
	});

	it("does not read or save after cancellation before the call", async () => {
		const controller = new AbortController();
		controller.abort(new Error("Cancelled before paste"));
		context.signal = controller.signal;
		await expect(materializeNativeCliReferences([{ path: "page", mode: "page" }], context)).rejects.toThrow(
			/Cancelled before paste/,
		);
		expect(context.readPage).not.toHaveBeenCalled();
		expect(savedFiles()).toEqual([]);
	});

	it("stops waiting for a page bridge that ignores cancellation", async () => {
		const controller = new AbortController();
		context.signal = controller.signal;
		let started!: () => void;
		const bridgeStarted = new Promise<void>((resolveStarted) => {
			started = resolveStarted;
		});
		vi.mocked(context.readPage).mockImplementation(() => {
			started();
			return new Promise(() => {});
		});
		const pending = materializeNativeCliReferences([{ path: "page", mode: "page" }], context);
		const rejected = expect(pending).rejects.toThrow(/Reference read timed out/);
		await bridgeStarted;
		controller.abort(new Error("Reference read timed out"));
		await rejected;
		expect(savedFiles()).toEqual([]);
	});

	it("removes the final saved export if cancellation occurs during persistence", async () => {
		const controller = new AbortController();
		context.signal = controller.signal;
		const realSave = uploads.saveUpload;
		vi.spyOn(uploads, "saveUpload").mockImplementation((...args) => {
			const saved = realSave(...args);
			controller.abort(new Error("Cancelled during save"));
			return saved;
		});
		await expect(materializeNativeCliReferences([{ path: "page", mode: "page" }], context)).rejects.toThrow(
			/Cancelled during save/,
		);
		expect(savedFiles()).toEqual([]);
	});

	it("removes this batch's exports if saving a later file fails", async () => {
		const realSave = uploads.saveUpload;
		vi.spyOn(uploads, "saveUpload")
			.mockImplementationOnce(realSave)
			.mockImplementationOnce(() => {
				throw new Error("Disk full");
			});
		await expect(
			materializeNativeCliReferences(
				[
					{ path: "page1", mode: "page" },
					{ path: "page2", mode: "page" },
				],
				context,
			),
		).rejects.toThrow(/Disk full/);
		expect(savedFiles()).toEqual([]);
	});
});
