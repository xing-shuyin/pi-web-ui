import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdminService, type ModelAdminHost } from "../../server/model-admin.js";
import type { ServerMessage } from "../../server/protocol.js";

function makeHost(agentDir: string) {
	const messages: ServerMessage[] = [];
	const host = {
		agentDir,
		emit: (msg: ServerMessage) => {
			messages.push(msg);
		},
		flushSnapshot: () => {},
		isDisposed: () => false,
		modelRuntime: () => ({}) as unknown as ModelRuntime,
		invalidatePiConfig: () => {},
		pushModels: async () => {},
	} satisfies ModelAdminHost;
	return { host, messages };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ModelAdminService.enrichModels & abortEnrichModels", () => {
	it("空 id 时报错并返回 ok: false", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-enrich-"));
		try {
			const { host, messages } = makeHost(agentDir);
			const admin = new ModelAdminService(host);
			await admin.enrichModels(1, [], undefined, () => "zh");
			const res = messages.find((m) => m.type === "enrich_models_result");
			expect(res).toBeDefined();
			expect(res).toMatchObject({ reqId: 1, ok: false });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("在执行中调用 abortEnrichModels 能成功中止", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-enrich-"));
		try {
			const { host, messages } = makeHost(agentDir);
			const admin = new ModelAdminService(host);

			const promise = admin.enrichModels(42, ["fake-model-id-12345"], undefined, () => "zh");
			admin.abortEnrichModels(42);
			await promise;

			const res = messages.find((m) => m.type === "enrich_models_result");
			expect(res).toBeDefined();
			expect(res).toMatchObject({ reqId: 42, ok: false });
			const notice = messages.find((m) => m.type === "notice" && m.text.includes("取消"));
			expect(notice).toBeDefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
