import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SandboxModal, canApplySandboxPreview, matchesSandboxPreview } from "../../web/src/components/SandboxModal.js";
import { handleFileMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/engine-service.js";
import type { SandboxDiffView, SandboxInfo } from "../../server/protocol.js";

const sandbox: SandboxInfo = {
	id: "sbx-preview",
	name: "Preview",
	path: "/sandbox",
	sourcePath: "/source",
	ephemeral: true,
	createdAt: 1,
};
const preview: SandboxDiffView = {
	sandboxId: sandbox.id,
	path: sandbox.path,
	sourcePath: sandbox.sourcePath,
	requestId: "request-current",
	expectedRevision: "content-hash",
	added: ["new.ts"],
	modified: [],
	deleted: [],
	unchangedCount: 1,
};
const request = { requestId: "request-current", path: sandbox.path };

describe("sandbox approval preview", () => {
	it("requires the current request and both sandbox identity and path", () => {
		expect(matchesSandboxPreview(preview, sandbox, request)).toBe(true);
		for (const diff of [
			{ ...preview, requestId: "request-previous" },
			{ ...preview, requestId: undefined },
			{ ...preview, sandboxId: "other" },
			{ ...preview, path: "/other" },
		])
			expect(matchesSandboxPreview(diff, sandbox, request)).toBe(false);
		expect(matchesSandboxPreview(preview, sandbox, null)).toBe(false);
		expect(matchesSandboxPreview(preview, sandbox, { ...request, path: "/other" })).toBe(false);
	});

	it("displays correlated lookup errors even when the server cannot resolve a sandbox id", () => {
		const error = { ...preview, sandboxId: "", error: "Sandbox no longer exists" };
		expect(matchesSandboxPreview(error, sandbox, request)).toBe(true);
		expect(matchesSandboxPreview({ ...error, requestId: "old" }, sandbox, request)).toBe(false);
		expect(canApplySandboxPreview(error)).toBe(false);
	});

	it("rejects errors, missing content revisions, and empty changes", () => {
		expect(canApplySandboxPreview(preview)).toBe(true);
		expect(canApplySandboxPreview({ ...preview, error: "Source conflict" })).toBe(false);
		expect(canApplySandboxPreview({ ...preview, expectedRevision: undefined })).toBe(false);
		expect(canApplySandboxPreview({ ...preview, expectedRevision: "" })).toBe(false);
		expect(canApplySandboxPreview({ ...preview, added: [] })).toBe(false);
		expect(canApplySandboxPreview(null)).toBe(false);
	});

	it("does not display a retained preview or enable apply when a dialog opens", () => {
		const html = renderToStaticMarkup(
			createElement(SandboxModal, {
				mode: "apply",
				currentSandbox: sandbox,
				sandboxDiff: preview,
				projects: [],
				send: vi.fn(),
				onClose: vi.fn(),
			}),
		);
		expect(html).not.toContain("new.ts");
		expect(html).toMatch(/type="submit"[^>]*disabled=""/);
	});

	it("forwards request correlation and the exact approved revision through dispatch", () => {
		const diffSandbox = vi.fn();
		const applySandboxToSource = vi.fn();
		const cs = { diffSandbox, applySandboxToSource } as unknown as DispatchSession;
		expect(handleFileMessage({ type: "diff_sandbox", path: sandbox.path, requestId: request.requestId }, cs)).toBe(
			true,
		);
		expect(diffSandbox).toHaveBeenCalledWith(sandbox.path, request.requestId);
		expect(
			handleFileMessage(
				{ type: "apply_sandbox_to_source", path: sandbox.path, expectedRevision: preview.expectedRevision! },
				cs,
			),
		).toBe(true);
		expect(applySandboxToSource).toHaveBeenCalledWith(sandbox.path, preview.expectedRevision);
	});
});
