import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdminService, type ModelAdminHost } from "../../server/model-admin.js";
import type { ServerMessage, UiProviderConfig } from "../../server/protocol.js";

function makeHost(agentDir: string, opts: { baseUrl?: string; refresh?: () => Promise<void> } = {}) {
	const notices: ServerMessage[] = [];
	const refresh = vi.fn(opts.refresh ?? (async () => {}));
	const host = {
		agentDir,
		emit: (msg: ServerMessage) => {
			notices.push(msg);
		},
		flushSnapshot: () => {},
		isDisposed: () => false,
		modelRuntime: () =>
			({
				refresh,
				setRuntimeApiKey: async () => {},
				getProvider: (pid: string) => (pid === "opencode-go" && opts.baseUrl ? { baseUrl: opts.baseUrl } : undefined),
			}) as unknown as ModelRuntime,
		invalidatePiConfig: () => {},
		pushModels: async () => {},
	} satisfies ModelAdminHost;
	return { host, notices, refresh };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ModelAdminService.reloadModelsConfig", () => {
	it("从磁盘重读并重推：refresh 被调用、发出 models_config 与成功 notice", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-reload-"));
		try {
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({ providers: { "my-proxy": { models: [{ id: "m1" }] } } }, null, 2) + "\n",
			);
			const { host, notices, refresh } = makeHost(agentDir);
			await new ModelAdminService(host).reloadModelsConfig();
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(notices.some((m) => m.type === "models_config")).toBe(true);
			const ok = notices.filter((m) => m.type === "notice");
			expect(ok.length).toBe(1);
			expect(ok[0]).toMatchObject({ level: "info" });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("refresh 抛错时发出 error notice 而不崩", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-reload-"));
		try {
			const { host, notices } = makeHost(agentDir, {
				refresh: async () => {
					throw new Error("disk gone");
				},
			});
			await new ModelAdminService(host).reloadModelsConfig();
			const errs = notices.filter((m) => m.type === "notice" && (m as { level?: string }).level === "error");
			expect(errs.length).toBe(1);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("ModelAdminService.refreshProviderModels baseUrl 回退", () => {
	const entryWithoutBaseUrl = {
		api: "openai-completions",
		models: [{ id: "deepseek-flash", name: "DeepSeek" }],
	};

	it("纯覆盖条目（无 provider 级 baseUrl）回退运行时地址探测，且不把回退地址写回磁盘", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-refresh-fallback-"));
		try {
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({ providers: { "opencode-go": entryWithoutBaseUrl } }, null, 2) + "\n",
			);
			const probe = vi
				.spyOn(ModelAdminService, "probeModelsEndpoint")
				.mockResolvedValue([{ id: "deepseek-flash" }, { id: "new-model" }]);
			const { host, notices } = makeHost(agentDir, { baseUrl: "https://opencode.ai/zen/go/v1" });
			const service = new ModelAdminService(host);
			let reqId = 0;
			const done = new Promise<ServerMessage>((resolve) => {
				const origEmit = host.emit;
				host.emit = (msg: ServerMessage) => {
					origEmit(msg);
					if (msg.type === "refresh_provider_result") {
						reqId = (msg as { reqId: number }).reqId;
						resolve(msg);
					}
				};
			});
			await service.refreshProviderModels("opencode-go", 7);
			const result = await done;
			expect(reqId).toBe(7);
			expect(result).toMatchObject({ type: "refresh_provider_result", ok: true, added: 1, total: 2 });
			expect(probe).toHaveBeenCalledTimes(1);
			expect(probe.mock.calls[0][0]).toBe("https://opencode.ai/zen/go/v1");
			const written = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
				providers: Record<string, UiProviderConfig & Record<string, unknown>>;
			};
			const saved = written.providers["opencode-go"];
			expect(saved.baseUrl).toBeUndefined();
			expect(saved.models?.map((m) => m.id).sort()).toEqual(["deepseek-flash", "new-model"]);
			expect(notices.some((m) => m.type === "notice")).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("磁盘与运行时都没有 baseUrl 时拒绝并返回 ok:false", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-refresh-fallback-"));
		try {
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({ providers: { "my-proxy": { models: [{ id: "m1" }] } } }, null, 2) + "\n",
			);
			const probe = vi.spyOn(ModelAdminService, "probeModelsEndpoint");
			const { host } = makeHost(agentDir);
			const results: ServerMessage[] = [];
			const origEmit = host.emit;
			host.emit = (msg: ServerMessage) => {
				origEmit(msg);
				if (msg.type === "refresh_provider_result") results.push(msg);
			};
			await new ModelAdminService(host).refreshProviderModels("my-proxy", 3);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ type: "refresh_provider_result", ok: false });
			expect(probe).not.toHaveBeenCalled();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
