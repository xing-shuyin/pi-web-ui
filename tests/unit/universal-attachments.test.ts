import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAttachmentUiMessages,
	formatUnavailableCanvasReference,
	materializeUploads,
	scanAtMentions,
} from "../../server/universal/universal-attachments.js";

describe("uploads for native CLI engines", () => {
	it("persists browser uploads under the client upload dir and shows a file card", () => {
		const dataDir = fs.mkdtempSync(join(tmpdir(), "pi-univ-uploads-"));
		dirs.push(dataDir);
		const [att] = materializeUploads(
			[{ path: "", name: "notes.txt", fileData: Buffer.from("hello").toString("base64"), mimeType: "text/plain" }],
			{ clientId: "c1", dataDir },
		);
		expect(att.fileData).toBeUndefined();
		expect(att.uploadPath).toContain(join(dataDir, "uploads", "c1"));
		expect(fs.readFileSync(att.uploadPath!, "utf8")).toBe("hello");
		const [card] = createAttachmentUiMessages([att], 1);
		expect(card.details).toMatchObject({ name: "notes.txt", path: att.uploadPath, mode: "reference" });
	});

	it("keeps small supported images inline, turns oversized/unsupported ones into files", () => {
		const dataDir = fs.mkdtempSync(join(tmpdir(), "pi-univ-uploads-"));
		dirs.push(dataDir);
		const small = {
			path: "",
			name: "s.png",
			imageData: `data:image/png;base64,${Buffer.alloc(10).toString("base64")}`,
		};
		const big = { path: "", name: "b.png", imageData: `data:image/png;base64,${Buffer.alloc(100).toString("base64")}` };
		const bmp = { path: "", name: "x.bmp", imageData: `data:image/bmp;base64,${Buffer.alloc(10).toString("base64")}` };
		const out = materializeUploads([small, big, bmp], { clientId: "c1", dataDir, maxInlineImageBytes: 50 });
		expect(out[0]).toEqual(small);
		expect(out[1].imageData).toBeUndefined();
		expect(fs.statSync(out[1].uploadPath!).size).toBe(100);
		expect(out[2].uploadPath).toMatch(/x\.bmp$/);
	});

	it("resolves relative upload paths and drops ones escaping the uploads root", () => {
		const dataDir = fs.mkdtempSync(join(tmpdir(), "pi-univ-uploads-"));
		dirs.push(dataDir);
		const out = materializeUploads(
			[
				{ path: "", uploadPath: "c1/1-a.txt", name: "a.txt" },
				{ path: "", uploadPath: "../../etc/passwd", name: "p" },
			],
			{ clientId: "c1", dataDir },
		);
		expect(out[0].uploadPath).toBe(join(dataDir, "uploads", "c1", "1-a.txt"));
		expect(out[1].uploadPath).toBeUndefined();
	});
});

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("canvas attachments in other engines", () => {
	it("preserves canvas identity and reports unavailable tooling without probing a file", () => {
		const exists = vi.spyOn(fs, "existsSync");
		const stat = vi.spyOn(fs, "statSync");
		const att = { mode: "canvas" as const, path: "build.png", name: 'Build "UI" & <test>' };
		const messages = createAttachmentUiMessages([att], 123);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			timestamp: 123,
			customType: "file",
			details: { mode: "canvas", path: att.path, name: att.name, title: att.name },
		});
		expect(messages[0].content).toEqual([{ type: "text", text: formatUnavailableCanvasReference(att) }]);
		expect(formatUnavailableCanvasReference(att)).toContain("Canvas tooling is unavailable");
		expect(formatUnavailableCanvasReference(att)).toContain("&quot;UI&quot; &amp; &lt;test&gt;");
		expect(exists).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
	});

	it.each(["Plan", "Plan with spaces", "Plan.v2+test"])(
		"skips the canvas display mention %s but still detects other files",
		(name) => {
			const cwd = fs.mkdtempSync(join(tmpdir(), "pi-canvas-mention-"));
			dirs.push(cwd);
			fs.writeFileSync(join(cwd, name), "secret");
			fs.writeFileSync(join(cwd, name.split(" ")[0]), "secret");
			fs.writeFileSync(join(cwd, "other.txt"), "other");
			const result = scanAtMentions(`@${name} @other.txt`, cwd, [], [{ mode: "canvas", path: "graph-1", name }]);
			expect(result.detectedAttachments).toEqual([{ path: "other.txt", name: "other.txt", mode: "reference" }]);
		},
	);
});
