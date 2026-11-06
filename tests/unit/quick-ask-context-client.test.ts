import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loadQuickAskFile,
	loadQuickAskFolder,
	loadQuickAskReference,
	quickAskBudgetError,
	QUICK_ASK_MAX_FILE_BYTES,
} from "../../web/src/quick-ask-context.js";
import type { QuickAskAttachment, QuickAskMessage } from "../../web/src/quick-ask.js";

afterEach(() => vi.unstubAllGlobals());
const attachment: QuickAskAttachment = { id: "file:readme", kind: "file", name: "README.md", content: "Snapshot" };

describe("quick ask explicit client references", () => {
	it("captures source path, cwd and client identity in the request before any async response", async () => {
		let finish!: (response: Response) => void;
		const fetch = vi.fn(
			(_url: string, _init: RequestInit) =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const source = { kind: "file" as const, path: "README.md", cwd: "/original" };
		const loading = loadQuickAskReference(source, { clientId: "window-one", signal: new AbortController().signal });
		source.path = "different.md";
		source.cwd = "/changed";
		finish(Response.json({ attachment }));
		expect(await loading).toEqual(attachment);
		expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({
			source: { kind: "file", path: "README.md", cwd: "/original" },
			clientId: "window-one",
		});
	});

	it("passes file bytes to the common server decoder rather than interpreting binary as text", async () => {
		const fetch = vi.fn().mockResolvedValue(Response.json({ attachment }));
		vi.stubGlobal("fetch", fetch);
		await loadQuickAskFile(
			new File([new Uint8Array([0xff, 0x00, 0xfe])], "sample.bin", { type: "application/octet-stream" }),
			{ signal: new AbortController().signal },
		);
		const body = JSON.parse(fetch.mock.calls[0][1].body);
		expect(body.source).toEqual({
			kind: "upload",
			name: "sample.bin",
			mimeType: "application/octet-stream",
			data: "/wD+",
		});
	});

	it("rejects oversized and already-cancelled uploads before sending data", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			loadQuickAskFile(new File([new Uint8Array(QUICK_ASK_MAX_FILE_BYTES + 1)], "large.txt"), {
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "quickAskFileTooLarge" });
		const controller = new AbortController();
		controller.abort();
		await expect(
			loadQuickAskFile(new File(["text"], "small.txt"), { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("forwards cancellation while a source snapshot is being resolved", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url, init) =>
					new Promise((_resolve, reject) =>
						init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
					),
			),
		);
		const controller = new AbortController();
		const loading = loadQuickAskReference(
			{ kind: "conversation", conversationId: "original-conversation" },
			{ signal: controller.signal },
		);
		controller.abort(new Error("Topic reset"));
		await expect(loading).rejects.toThrow("Topic reset");
	});

	it("maps unsupported binary responses to a localized error code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ error: "Unsupported file type" }, { status: 415 })),
		);
		await expect(
			loadQuickAskReference({ kind: "file", path: "archive.zip" }, { signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: "quickAskUnsupportedFile" });
	});

	it("takes a bounded folder listing without reading file contents or making requests", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const files = Array.from({ length: 70 }, (_, i) => {
			const file = new File(["Private file content"], `file-${i}.md`);
			Object.defineProperty(file, "webkitRelativePath", { value: `docs/file-${i}.md` });
			return file;
		});
		const result = await loadQuickAskFolder(files, { scope: "listing", signal: new AbortController().signal });
		expect(result.kind).toBe("directory");
		expect(result.content).toContain("docs/file-63.md");
		expect(result.content).not.toContain("docs/file-64.md");
		expect(result.content).toContain("Listing truncated: 6 more files");
		expect(result.content).not.toContain("Private file content");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("quick ask topic budgets", () => {
	const user = (attachments: QuickAskAttachment[], content = "Question"): QuickAskMessage => ({
		role: "user",
		content,
		attachments,
	});
	it("counts references retained on older turns", () => {
		const references = Array.from({ length: 8 }, (_, i) => ({ ...attachment, id: `file:${i}` }));
		expect(quickAskBudgetError([user(references), { role: "assistant", content: "Answer" }, user([attachment])])).toBe(
			"quickAskTooManyReferences",
		);
	});
	it("checks combined image sizes before an HTTP body exceeds the server limit", () => {
		const data = Buffer.alloc(1024 * 1024).toString("base64");
		const images = Array.from({ length: 7 }, (_, i) => ({
			...attachment,
			id: `image:${i}`,
			image: { data, mimeType: "image/png" },
		}));
		expect(quickAskBudgetError([user(images)])).toBe("quickAskImagesTooLarge");
		expect(quickAskBudgetError([user(images.slice(0, 6))])).toBeNull();
	});
	it("includes message history, source names and reference framing in its text estimate", () => {
		expect(quickAskBudgetError([user([{ ...attachment, content: "x".repeat(32768) }], "q".repeat(32700))])).toBe(
			"quickAskContextTooLarge",
		);
	});
});
