import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { SandboxManager } from "../../server/sandbox-service.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildContextEvidenceIndex,
	contextEvidenceReference,
	copyContextEvidence,
	removeContextEvidence,
	withContextEvidenceRead,
} from "../../server/context-evidence.js";
import {
	COMPACTION_RETENTION_INSTRUCTIONS,
	installCompactionInstructions,
} from "../../server/compaction-instructions.js";
import { installEvidenceToolHooks } from "../../server/evidence-tool-hooks.js";
import { externalizeRequestEvidence } from "../../server/request-context.js";

const directories: string[] = [];
const text = "verified output line\n".repeat(3000);
const reference = contextEvidenceReference(text);
const artifactName = `${reference.slice("context-evidence:".length)}.txt`;

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function persistedSession() {
	const directory = await mkdtemp(join(tmpdir(), "context-integration-"));
	directories.push(directory);
	const file = join(directory, "parent.jsonl");
	await writeFile(file, "");
	return { directory, file };
}

function messages(): any[] {
	return [
		{ role: "toolResult", toolName: "read", toolCallId: "original", isError: false, content: [{ type: "text", text }] },
	];
}

function harness(file: string) {
	const session: any = Object.create(AgentSession.prototype);
	let currentFile = file;
	const emitToolCall = vi.fn(async (_event: any): Promise<any> => ({ block: false }));
	session._extensionRunner = { hasHandlers: vi.fn(() => true), emitToolCall } as any;
	session.sessionManager = { getSessionFile: () => currentFile } as any;
	const defaultCompaction = vi.fn(async function (
		_preparation: any,
		_model: any,
		_instructions: any,
		_signal: any,
		_reason: any,
	) {
		return {
			summary: "## Goal\nRetain verified output.\n## Next Steps\nRead evidence to verify details.",
			tokensBefore: 20000,
		};
	});
	session._runDefaultCompaction = defaultCompaction;
	expect(installEvidenceToolHooks(session)).toBe(true);
	expect(
		installCompactionInstructions(session, {
			getEvidenceIndex: () => buildContextEvidenceIndex(currentFile),
		}),
	).toBe(true);
	const execute = vi.fn(async (_id: string, args: any, signal: AbortSignal | undefined) => {
		signal?.throwIfAborted();
		const path = args.path ?? args.file_path;
		const body = path.endsWith(".txt") ? await readFile(path, "utf8") : (await readdir(path)).sort().join("\n");
		return { content: [{ type: "text", text: body }], details: {} };
	});
	const reader = withContextEvidenceRead({ name: "read", execute } as any, () => currentFile);
	async function read(ref = reference, signal?: AbortSignal) {
		const ctx: any = {
			toolCall: { id: "recover", name: "read", arguments: { file_path: ref } },
			args: { file_path: ref },
			signal,
		};
		try {
			const decision = await session._beforeToolCall(ctx, "parent-call");
			if (decision?.block) throw new Error(decision.reason);
			return await reader.execute("recover", ctx.args, signal, undefined, { cwd: tmpdir() } as any);
		} finally {
			expect(ctx.toolCall.arguments).toEqual({ file_path: ref });
		}
	}
	return {
		session,
		defaultCompaction,
		emitToolCall,
		execute,
		read,
		move: (file: string) => {
			currentFile = file;
		},
	};
}

describe("zero-token context evidence integration", () => {
	it("externalizes, appends a deterministic index, copies to a new path and reads after deleting the parent", async () => {
		const { directory, file } = await persistedSession();
		const original = messages();
		const originalSnapshot = structuredClone(original);
		const externalized: any = await externalizeRequestEvidence(original, file);
		expect(original).toEqual(originalSnapshot);
		expect(externalized).not.toBe(original);
		expect(externalized[0].content[0].text).toContain(reference);
		expect(externalized[0].content[0].text.length).toBeLessThan(text.length);
		expect(await readFile(join(`${file}.evidence`, artifactName), "utf8")).toBe(text);

		const h = harness(file);
		const compact = () =>
			h.session._runDefaultCompaction({ messages: externalized } as any, undefined, "Keep facts", undefined, "manual");
		const summary = await compact();
		const index = await buildContextEvidenceIndex(file);
		expect(summary.summary).toBe(`${(await h.defaultCompaction.mock.results[0].value).summary}\n\n${index}`);
		expect(summary.summary).toContain("context-evidence:index");
		expect(summary.summary).toContain(reference);
		expect(summary.summary).not.toContain(text);
		expect(summary.summary).not.toContain(directory);
		expect(await compact()).toEqual(summary);
		expect(h.defaultCompaction.mock.calls[0][2]).toBe(`Keep facts\n\n${COMPACTION_RETENTION_INSTRUCTIONS}`);

		const child = join(directory, "relocated", "child.jsonl");
		await mkdir(join(directory, "relocated"));
		await writeFile(child, JSON.stringify(summary));
		await copyContextEvidence(file, child);
		await rm(file);
		await removeContextEvidence(file);
		await expect(readFile(join(`${file}.evidence`, artifactName))).rejects.toHaveProperty("code", "ENOENT");
		h.move(child);
		expect(await buildContextEvidenceIndex(child)).toBe(index);
		const restored = JSON.parse(await readFile(child, "utf8"));
		const restoredRef = restored.summary.match(/context-evidence:[a-f0-9]{64}/)?.[0];
		expect(restoredRef).toBe(reference);
		expect((await h.read(restoredRef)).content).toEqual([{ type: "text", text }]);
		expect((await h.read("context-evidence:index")).content).toEqual([{ type: "text", text: artifactName }]);
		expect(h.emitToolCall).toHaveBeenCalledWith({
			type: "tool_call",
			toolName: "read",
			toolCallId: "recover",
			parentToolCallId: "parent-call",
			input: { path: join(`${child}.evidence`, artifactName), file_path: join(`${child}.evidence`, artifactName) },
		});
	});

	it.each(["cancel-before-hook", "cancel-in-policy", "policy-block", "policy-error", "reader-denied"])(
		"preserves %s and permits a fresh read after recovery",
		async (failure) => {
			const { file } = await persistedSession();
			await externalizeRequestEvidence(messages(), file);
			const h = harness(file);
			const controller = new AbortController();
			const reason = new Error(failure);
			if (failure === "cancel-before-hook") controller.abort(reason);
			if (failure === "cancel-in-policy")
				h.emitToolCall.mockImplementationOnce(async () => {
					controller.abort(reason);
					return { block: false };
				});
			if (failure === "policy-block") h.emitToolCall.mockResolvedValueOnce({ block: true, reason: failure });
			if (failure === "policy-error") h.emitToolCall.mockRejectedValueOnce(reason);
			if (failure === "reader-denied") h.execute.mockRejectedValueOnce(reason);
			await expect(h.read(reference, controller.signal)).rejects.toThrow(failure);
			expect(h.execute).toHaveBeenCalledTimes(failure === "reader-denied" ? 1 : 0);
			if (failure === "cancel-before-hook") expect(h.emitToolCall).not.toHaveBeenCalled();
			else
				expect(h.emitToolCall.mock.calls[0][0].input).toEqual({
					path: join(`${file}.evidence`, artifactName),
					file_path: join(`${file}.evidence`, artifactName),
				});
			expect(await readFile(join(`${file}.evidence`, artifactName), "utf8")).toBe(text);
			expect((await h.read()).content).toEqual([{ type: "text", text }]);
		},
	);

	it("keeps original output when persistence fails, then externalizes after repairing storage", async () => {
		const { file } = await persistedSession();
		await writeFile(`${file}.evidence`, "invalid directory");
		const original = messages();
		expect(await externalizeRequestEvidence(original, file)).toBe(original);
		expect(original[0].content[0].text).toBe(text);
		await rm(`${file}.evidence`);
		const recovered: any = await externalizeRequestEvidence(original, file);
		expect(recovered[0].content[0].text).toContain(reference);
		expect((await harness(file).read()).content).toEqual([{ type: "text", text }]);
	});

	it("rejects a failed index without publishing a checkpoint and retries after storage repair", async () => {
		const { file } = await persistedSession();
		await externalizeRequestEvidence(messages(), file);
		const h = harness(file);
		const artifact = await readFile(join(`${file}.evidence`, artifactName), "utf8");
		await rm(`${file}.evidence`, { recursive: true });
		await writeFile(`${file}.evidence`, "invalid directory");
		const publish = vi.fn();
		const compact = async () => {
			const result = await h.session._runDefaultCompaction({} as any, undefined, undefined, undefined, "auto");
			publish(result);
			return result;
		};
		await expect(compact()).rejects.toThrow();
		expect(publish).not.toHaveBeenCalled();
		expect((await h.defaultCompaction.mock.results[0].value).summary).not.toContain("context-evidence:");
		await rm(`${file}.evidence`);
		await mkdir(`${file}.evidence`);
		await writeFile(join(`${file}.evidence`, artifactName), artifact);
		expect((await compact()).summary).toContain(reference);
		expect(publish).toHaveBeenCalledOnce();
		expect((await h.read()).content).toEqual([{ type: "text", text }]);
	});
});

it.each(["fallback", "composeWith"])(
	"dynamic owner anchor retains evidenceSession through the real read %s",
	async (mode) => {
		const { directory, file } = await persistedSession();
		await externalizeRequestEvidence(messages(), file);
		const h = harness(file);
		const specMethod = (ClientSession.prototype as any).toolOverrideSpecs;
		const makeOwner = (id: string): any =>
			Object.assign(
				{},
				Object.fromEntries(
					[
						"awaitPendingWorkspaceSnapshot",
						"planModeOf",
						"delegateModeOf",
						"goalReviewTurnOf",
						"subagentSecurityModeOf",
						"subagentAllowedToolsOf",
					].map((name) => [name, (ClientSession.prototype as any)[name]]),
				),
				{
					sandboxes: new SandboxManager(directory),
					settingsSvc: { current: {} },
					convs: new Map([[id, { id, cwd: directory }]]),
					getLang: () => "en",
					roots: [],
					approvalRules: { list: () => [] },
					auditLogger: { record: vi.fn() },
					askApproval: vi.fn(async () => ({ decision: "allow" })),
					toolOverrideSpecs: specMethod,
				},
			);
		const oldOwner = makeOwner("old");
		const newOwner = makeOwner("new");
		let home = { client: oldOwner, conv: oldOwner.convs.get("old") };
		oldOwner.toolConversationHome = vi.fn(() => home);
		const anchor: any = { session: h.session };
		const spec = specMethod
			.call(oldOwner, "old", directory, undefined, anchor)
			.find((entry: any) => entry.name === "read");
		const base = { name: "read", execute: h.execute } as any;
		const read = mode === "fallback" ? spec.fallback() : spec.composeWith(base);
		const child = join(directory, "new-owner.jsonl");
		await writeFile(child, "");
		await copyContextEvidence(file, child);
		await rm(file);
		await removeContextEvidence(file);
		h.move(child);
		home = { client: newOwner, conv: newOwner.convs.get("new") };
		const dynamicSpecs = vi.spyOn(newOwner, "toolOverrideSpecs");
		const result = await read.execute("dynamic", { path: reference }, undefined, undefined, { cwd: directory } as any);
		expect(result.isError).not.toBe(true);
		expect(result.content.map((part: any) => part.text).join("\n")).toContain("verified output line");
		expect(dynamicSpecs).toHaveBeenCalledWith("new", directory, undefined, undefined, h.session);
		expect(oldOwner.toolConversationHome).toHaveBeenCalledWith(h.session);
		if (mode === "composeWith") expect(h.execute.mock.calls[0][1].path).toBe(join(`${child}.evidence`, artifactName));
	},
);

it("guards the dynamic evidenceSession argument without mirroring the implementation", async () => {
	const source = await readFile(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
	expect(source).toMatch(/\.toolOverrideSpecs\([^)]*,\s*undefined,\s*anchor\.session\s*\)/);
});
