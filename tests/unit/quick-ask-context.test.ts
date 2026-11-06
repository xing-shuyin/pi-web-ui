import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fakeClientSession } from "../helpers/fake-session.js";
import { UniversalSession, UniversalSessionStore, MockAgentDriver } from "../../server/universal/index.js";
import {
	captureQuickAskConversation,
	MAX_QUICK_ASK_ATTACHMENT_TEXT,
	MAX_QUICK_ASK_IMAGE_BYTES,
	parseQuickAskAttachment,
	parseQuickAskContextRequest,
	readQuickAskHistoryConversation,
	resolveQuickAskContext,
	type QuickAskContextDependencies,
} from "../../server/quick-ask-context.js";
import { registerQuickAskRoutes } from "../../server/quick-ask.js";

let root: string;
let deps: QuickAskContextDependencies;
const signal = () => new AbortController().signal;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quick-ask-context-"));
	deps = { getWorkspace: vi.fn(() => ({ cwd: root })), readConversation: vi.fn().mockResolvedValue(undefined) };
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const read = (body: unknown, abortSignal = signal()) =>
	resolveQuickAskContext(parseQuickAskContextRequest(body), deps, abortSignal);

describe("quick ask reference snapshots", () => {
	it("reads real text files with the shared UTF-8/GBK decoder and returns independent snapshots", async () => {
		await writeFile(join(root, "note.txt"), "original text");
		const snapshot = await read({ source: { kind: "file", path: "note.txt" }, clientId: "browser" });
		await writeFile(join(root, "note.txt"), "changed later");
		expect(snapshot).toMatchObject({ kind: "file", name: "note.txt", content: "original text" });
		expect(snapshot.path).toContain("note.txt");
		expect(deps.getWorkspace).toHaveBeenCalledWith("browser");
		await writeFile(join(root, "legacy.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
		expect((await read({ source: { kind: "file", path: "legacy.txt" } })).content).toBe("中文");
	});
	it("accepts uploads through the same decoder and strict image validation", async () => {
		expect(
			await read({ source: { kind: "upload", name: "note.txt", data: Buffer.from("hello").toString("base64") } }),
		).toMatchObject({ kind: "file", content: "hello" });
		expect(
			await read({
				source: { kind: "upload", name: "legacy.txt", data: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]).toString("base64") },
			}),
		).toMatchObject({ content: "中文" });
		const image = await read({
			source: { kind: "upload", name: "image.png", data: png.toString("base64"), mimeType: "image/png" },
		});
		expect(image.image).toEqual({ data: png.toString("base64"), mimeType: "image/png" });
		expect(image).not.toHaveProperty("path");
		await expect(
			read({ source: { kind: "upload", name: "image.png", data: png.toString("base64"), mimeType: "image/jpeg" } }),
		).rejects.toThrow("MIME");
	});
	it("uses stable source IDs for files, directories, conversations and uploads", async () => {
		await writeFile(join(root, "same.txt"), "first");
		const file = { source: { kind: "file", path: "same.txt" } };
		const first = await read(file);
		expect((await read(file)).id).toBe(first.id);
		await writeFile(join(root, "same.txt"), "changed");
		const updated = await read(file);
		expect(updated.id).toBe(first.id);
		expect(updated.content).toBe("changed");
		expect(first.content).toBe("first");
		const directory = await read({ source: { kind: "directory", path: "." } });
		expect((await read({ source: { kind: "directory", path: root }, scope: "content" })).id).toBe(directory.id);
		const snapshot = captureQuickAskConversation(
			"Other",
			join(root, "session.jsonl"),
			[{ role: "user", content: "first" }],
			root,
		);
		vi.mocked(deps.readConversation).mockResolvedValue(snapshot);
		const source = { kind: "conversation", conversationId: "c2", owner: "owner" };
		const conversation = await read({ source });
		expect((await read({ source, scope: "full" })).id).toBe(conversation.id);
		expect((await read({ source: { kind: "conversation", sessionFile: snapshot.path, owner: "owner" } })).id).toBe(
			conversation.id,
		);
		expect((await read({ source: { ...source, owner: "another-owner" } })).id).not.toBe(conversation.id);
		const upload = { source: { kind: "upload", name: "same.txt", data: Buffer.from("first").toString("base64") } };
		const uploaded = await read(upload);
		expect((await read(upload)).id).toBe(uploaded.id);
		expect((await read({ source: { ...upload.source, data: Buffer.from("changed").toString("base64") } })).id).not.toBe(
			uploaded.id,
		);
	});
	it("detects image content independently of the filename", async () => {
		await writeFile(join(root, "image.dat"), png);
		expect((await read({ source: { kind: "file", path: "image.dat" } })).image?.mimeType).toBe("image/png");
	});
	it.each([Buffer.alloc(0), Buffer.from("%PDF-1.7"), Buffer.from([0, 1, 2, 3])])(
		"clearly rejects empty/unsupported binary files",
		async (bytes) => {
			await writeFile(join(root, "file.bin"), bytes);
			await expect(read({ source: { kind: "file", path: "file.bin" } })).rejects.toThrow(/empty|Unsupported binary/);
		},
	);
	it("rejects file/directory type mismatches before opening the reference", async () => {
		await writeFile(join(root, "note.txt"), "text");
		await expect(read({ source: { kind: "file", path: "." } })).rejects.toThrow("not a regular file");
		await expect(read({ source: { kind: "directory", path: "note.txt" } })).rejects.toThrow("not a directory");
	});
	it("enforces file byte and decoded text limits before returning any content", async () => {
		await writeFile(join(root, "large.txt"), "x".repeat(MAX_QUICK_ASK_ATTACHMENT_TEXT + 1));
		await expect(read({ source: { kind: "file", path: "large.txt" } })).rejects.toThrow("32768");
		await writeFile(join(root, "huge.bin"), Buffer.alloc(MAX_QUICK_ASK_IMAGE_BYTES + 1));
		await expect(read({ source: { kind: "file", path: "huge.bin" } })).rejects.toThrow("byte limit");
	});
	it("rejects traversal and binds absolute paths/cwd overrides to the captured sandbox", async () => {
		const sandbox = join(root, "sandbox");
		await mkdir(sandbox);
		await writeFile(join(root, "outside.txt"), "private");
		deps.getWorkspace = () => ({ cwd: sandbox, sandboxRoot: sandbox });
		await expect(read({ source: { kind: "file", path: "../outside.txt" } })).rejects.toThrow("outside the workspace");
		await expect(read({ source: { kind: "file", path: join(root, "outside.txt") } })).rejects.toThrow(
			"outside the sandbox",
		);
		await expect(read({ source: { kind: "file", path: "outside.txt", cwd: root } })).rejects.toThrow(
			"outside the sandbox",
		);
	});
	it("lists bounded directories and includes explicitly requested text content", async () => {
		await mkdir(join(root, "folder", "nested"), { recursive: true });
		await writeFile(join(root, "folder", "a.txt"), "file body");
		await writeFile(join(root, "folder", "nested", "b.txt"), "nested body");
		await writeFile(join(root, "folder", "binary.dat"), Buffer.from([0, 1, 2]));
		await writeFile(join(root, "folder", "document.pdf"), "%PDF-1.7 BINARY PDF BODY");
		const listing = await read({ source: { kind: "directory", path: "folder" }, scope: "listing" });
		expect(listing).toMatchObject({ kind: "directory", name: "folder" });
		expect(listing.content).toContain("nested/b.txt");
		expect(listing.content).not.toContain("file body");
		const content = await read({ source: { kind: "directory", path: "folder" }, scope: "content" });
		expect(content.content).toContain("file body");
		expect(content.content).toContain("nested body");
		expect(content.content).toContain("Unsupported binary");
		expect(content.content).not.toContain("BINARY PDF BODY");
		expect(content.content.length).toBeLessThanOrEqual(MAX_QUICK_ASK_ATTACHMENT_TEXT);
	});
	it("caps recursive depth, entry count and text with explicit omission markers", async () => {
		await mkdir(join(root, "deep", "a", "b", "c"), { recursive: true });
		await writeFile(join(root, "deep", "a", "b", "c", "secret.txt"), "past depth");
		const deep = await read({ source: { kind: "directory", path: "deep" }, scope: "content" });
		expect(deep.content).toContain("Depth limit");
		expect(deep.content).not.toContain("past depth");
		await mkdir(join(root, "many"));
		await Promise.all(Array.from({ length: 105 }, (_, i) => writeFile(join(root, "many", `${i}.txt`), "body")));
		const many = await read({ source: { kind: "directory", path: "many" } });
		expect(many.content).toContain("Snapshot truncated");
		expect(many.content.split(".txt")).toHaveLength(101);
		await mkdir(join(root, "long"));
		await writeFile(join(root, "long", "a.txt"), "x".repeat(32768));
		expect(
			(await read({ source: { kind: "directory", path: "long" }, scope: "content" })).content.length,
		).toBeLessThanOrEqual(32768);
	});
	it("omits directory junctions and rejects direct symbolic-link references", async () => {
		await mkdir(join(root, "outside"));
		await writeFile(join(root, "outside", "secret.txt"), "linked secret");
		await mkdir(join(root, "folder"));
		try {
			await symlink(
				join(root, "outside"),
				join(root, "folder", "link"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		const snapshot = await read({ source: { kind: "directory", path: "folder" }, scope: "content" });
		expect(snapshot.content).toContain("symbolic link omitted");
		expect(snapshot.content).not.toContain("linked secret");
		await expect(read({ source: { kind: "directory", path: "folder/link" } })).rejects.toThrow("Symbolic link");
		await expect(read({ source: { kind: "file", path: "folder/link/secret.txt" } })).resolves.toMatchObject({
			content: "linked secret",
		});
	});
	it("reads only explicit conversation identities and preserves the captured recent/full scope", async () => {
		const messages = Array.from({ length: 14 }, (_, i) => ({
			role: i % 2 ? "assistant" : "user",
			content: `message-${i}`,
		}));
		messages.splice(2, 0, { role: "system", content: "system secret" }, { role: "toolResult", content: "tool secret" });
		const snapshot = captureQuickAskConversation("Other conversation", "/allowed/session.jsonl", messages, root);
		vi.mocked(deps.readConversation).mockResolvedValue(snapshot);
		const source = {
			kind: "conversation",
			conversationId: "c2",
			sessionFile: "/allowed/session.jsonl",
			owner: "owner-2",
		};
		const recent = await read({ source, clientId: "viewer" });
		expect(deps.readConversation).toHaveBeenCalledWith(source, "viewer", expect.any(AbortSignal));
		expect(recent.content).not.toContain("message-3");
		expect(recent.content).toContain("message-4");
		expect(recent.content).not.toMatch(/system secret|tool secret/);
		const full = await read({ source, scope: "full" });
		expect(full.content).toContain("message-0");
		expect(full.content).toContain("message-13");
		expect(() => parseQuickAskContextRequest({ source: { kind: "conversation" } })).toThrow("explicit");
	});
	it("copies user/assistant text immediately, dropping images, tools and thinking blocks", () => {
		const raw: any[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "question" },
					{ type: "image", data: "private image" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private thought" },
					{ type: "toolCall", name: "bash", arguments: "private command" },
					{ type: "text", text: "answer" },
				],
			},
			{ role: "system", content: "private system" },
			{ role: "toolResult", content: "private result" },
		];
		const snapshot = captureQuickAskConversation("Title", undefined, raw);
		raw[0].content[0].text = "mutated";
		expect(snapshot.messages).toEqual([
			{ role: "user", content: "question" },
			{ role: "assistant", content: "answer" },
		]);
	});
	it("reads a non-current live conversation through its explicit ID without consulting active state", async () => {
		const current = {
			id: "c1",
			title: "Current",
			cwd: root,
			session: { sessionFile: join(root, "current.jsonl"), messages: [{ role: "user", content: "DO NOT INCLUDE" }] },
		};
		const other = {
			id: "c2",
			title: "Other",
			cwd: root,
			session: {
				sessionFile: join(root, "other.jsonl"),
				messages: [
					{ role: "user", content: "Other question" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Other answer" },
							{ type: "toolCall", name: "bash", arguments: "SECRET" },
						],
					},
				],
			},
		};
		const client = fakeClientSession({
			activeId: "c1",
			cwd: root,
			convs: new Map([
				["c1", current],
				["c2", other],
			]),
		});
		const snapshot = await client.readQuickAskConversation({ kind: "conversation", conversationId: "c2" }, signal());
		expect(snapshot?.messages).toEqual([
			{ role: "user", content: "Other question" },
			{ role: "assistant", content: "Other answer" },
		]);
		other.session.messages[0].content = "later edit";
		expect(snapshot?.messages[0].content).toBe("Other question");
		expect(
			await client.readQuickAskConversation({ kind: "conversation", conversationId: "missing" }, signal()),
		).toBeUndefined();
		expect(
			await client.readQuickAskConversation(
				{ kind: "conversation", conversationId: "c2", sessionFile: current.session.sessionFile },
				signal(),
			),
		).toBeUndefined();
	});
	it("resolves Universal history's opaque session paths through its engine store without switching the current conversation", async () => {
		const store = new UniversalSessionStore(root, "claude");
		const session = new UniversalSession({
			clientId: "universal",
			cwd: root,
			dataDir: root,
			agentDir: root,
			send: () => {},
			store,
			driver: new MockAgentDriver(root),
			engine: "claude",
		});
		try {
			const active = (session as any).activeConvId;
			store.saveConversation(root, {
				id: "past-conversation",
				title: "Stored history",
				createdAt: 1,
				updatedAt: 2,
				messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "Historical Universal question" }] }],
			});
			deps.readConversation = (source, _clientId, abortSignal) => session.readQuickAskConversation(source, abortSignal);
			const history = await read({
				source: { kind: "conversation", sessionFile: "past-conversation" },
				clientId: "universal",
			});
			expect(history.content).toContain("Historical Universal question");
			expect(
				(await read({ source: { kind: "conversation", conversationId: "past-conversation" }, clientId: "universal" }))
					.id,
			).toBe(history.id);
			expect((session as any).activeConvId).toBe(active);
			expect(
				await session.readQuickAskConversation({ kind: "conversation", sessionFile: "../outside.json" }, signal()),
			).toBeUndefined();
			expect(
				await session.readQuickAskConversation(
					{ kind: "conversation", conversationId: active, sessionFile: "past-conversation" },
					signal(),
				),
			).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
	it("reuses the history-list allowlist and transcript parser for explicit historical session files", async () => {
		const path = join(root, "history.jsonl");
		await writeFile(
			path,
			[
				{ type: "session", cwd: root },
				{ type: "message", message: { role: "user", content: "Historical question" } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "Historical answer" },
							{ type: "thinking", thinking: "PRIVATE" },
						],
					},
				},
				{ type: "message", message: { role: "toolResult", content: "PRIVATE RESULT" } },
				{ type: "message", message: { role: "system", content: "PRIVATE SYSTEM" } },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([{ path, name: "Past conversation", cwd: root }] as any);
		expect(await readQuickAskHistoryConversation({ kind: "conversation", sessionFile: path }, signal())).toMatchObject({
			name: "Past conversation",
			path,
			messages: [
				{ role: "user", content: "Historical question" },
				{ role: "assistant", content: "Historical answer" },
			],
		});
		expect(
			await readQuickAskHistoryConversation(
				{ kind: "conversation", sessionFile: join(root, "not-listed.jsonl") },
				signal(),
			),
		).toBeUndefined();
	});
	it("denies conversation snapshots outside the requesting sandbox", async () => {
		deps.getWorkspace = () => ({ cwd: join(root, "sandbox"), sandboxRoot: join(root, "sandbox") });
		vi.mocked(deps.readConversation).mockResolvedValue(
			captureQuickAskConversation("Outside", undefined, [{ role: "user", content: "secret" }], root),
		);
		await expect(read({ source: { kind: "conversation", conversationId: "c2" } })).rejects.toThrow(
			"outside the sandbox",
		);
	});
	it("honors a pre-aborted request before touching workspace or history", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(read({ source: { kind: "file", path: "missing.txt" } }, controller.signal)).rejects.toThrow(
			"cancelled",
		);
		expect(deps.getWorkspace).not.toHaveBeenCalled();
	});
	it.each([
		{ source: { kind: "file", path: "a", command: "run" } },
		{ source: { kind: "conversation", conversationId: "c2" }, scope: "content" },
		{ source: { kind: "directory", path: "." }, scope: "full" },
		{ source: { kind: "file", path: "a" }, hiddenHistory: [] },
		{ source: { kind: "upload", name: "a", data: "" } },
	])("rejects unknown fields, incompatible scopes and empty uploads", (body) => {
		expect(() => parseQuickAskContextRequest(body)).toThrow();
	});
	it("strictly validates incoming attachments and base64/image MIME budgets", () => {
		const attachment = {
			id: "a",
			kind: "file",
			name: "image.png",
			content: "image",
			image: { data: png.toString("base64"), mimeType: "image/png" },
		};
		expect(parseQuickAskAttachment(attachment)).toEqual(attachment);
		for (const image of [
			{ data: "!!!=", mimeType: "image/png" },
			{ data: png.toString("base64"), mimeType: "image/jpeg" },
			{ data: png.toString("base64"), mimeType: "image/svg+xml" },
			{ data: "a".repeat(Math.ceil(MAX_QUICK_ASK_IMAGE_BYTES / 3) * 4 + 4), mimeType: "image/png" },
		]) {
			expect(() => parseQuickAskAttachment({ ...attachment, image })).toThrow();
		}
		expect(() => parseQuickAskAttachment({ ...attachment, kind: "directory" })).toThrow("Only file");
		expect(() => parseQuickAskAttachment({ ...attachment, content: "x".repeat(32769) })).toThrow("32768");
	});
});

describe("quick ask context HTTP lifecycle", () => {
	let server: Server;
	let url: string;
	let timeoutMs = 5000;
	let getRuntime: ReturnType<typeof vi.fn>;
	beforeEach(async () => {
		timeoutMs = 5000;
		getRuntime = vi.fn();
		const app = express();
		app.use(express.json({ limit: "4mb" }));
		registerQuickAskRoutes(app, {
			getSettings: () => ({ quickAskConversationScope: "full", quickAskFolderScope: "content" }),
			getRuntime: getRuntime as any,
			context: deps,
			get contextTimeoutMs() {
				return timeoutMs;
			},
		});
		server = await new Promise<Server>((resolve, reject) => {
			const instance = app.listen(28900 + Math.floor(Math.random() * 10000), "127.0.0.1", () => resolve(instance));
			instance.once("error", reject);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing server address");
		url = `http://127.0.0.1:${address.port}/api/quick-ask/context`;
	});
	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const post = (source: unknown, options: Record<string, unknown> = {}, abortSignal?: AbortSignal) =>
		fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source, ...options }),
			signal: abortSignal,
		});
	it("returns the contracted attachment JSON, applies saved scope defaults, and never initializes a model", async () => {
		await mkdir(join(root, "folder"));
		await writeFile(join(root, "folder", "a.txt"), "saved content scope");
		const response = await post({ kind: "directory", path: "folder" });
		expect(response.status).toBe(200);
		expect((await response.json()).attachment.content).toContain("saved content scope");
		vi.mocked(deps.readConversation).mockResolvedValue(
			captureQuickAskConversation(
				"History",
				undefined,
				Array.from({ length: 12 }, (_, i) => ({ role: "user", content: `turn ${i}` })),
			),
		);
		const history = await post({ kind: "conversation", conversationId: "c2" });
		expect((await history.json()).attachment.content).toContain("turn 0");
		expect(getRuntime).not.toHaveBeenCalled();
	});
	it("returns clear JSON errors for invalid sources and inaccessible paths", async () => {
		const bad = await post({ kind: "conversation" });
		expect(bad.status).toBe(400);
		expect((await bad.json()).error).toContain("explicit");
		const missing = await post({ kind: "file", path: "missing.txt" });
		expect(missing.status).toBe(404);
		expect((await missing.json()).error).toContain("Cannot read reference");
		const unknown = await post({ kind: "conversation", conversationId: "missing" });
		expect(unknown.status).toBe(404);
		expect((await unknown.json()).error).toContain("not found");
		expect(getRuntime).not.toHaveBeenCalled();
	});
	it("times out an unresponsive context reader and aborts its signal", async () => {
		timeoutMs = 25;
		vi.mocked(deps.readConversation).mockImplementation(() => new Promise(() => {}));
		const response = await post({ kind: "conversation", conversationId: "c2" });
		expect(response.status).toBe(504);
		expect((await response.json()).error).toContain("timed out");
		expect(vi.mocked(deps.readConversation).mock.calls[0][2].aborted).toBe(true);
	});
	it("cancels the context read when its browser request disconnects", async () => {
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		vi.mocked(deps.readConversation).mockImplementation(() => {
			ready();
			return new Promise(() => {});
		});
		const controller = new AbortController();
		const response = post({ kind: "conversation", conversationId: "c2" }, {}, controller.signal);
		await started;
		controller.abort();
		await expect(response).rejects.toThrow();
		await vi.waitFor(() => expect(vi.mocked(deps.readConversation).mock.calls[0][2].aborted).toBe(true));
	});
});
