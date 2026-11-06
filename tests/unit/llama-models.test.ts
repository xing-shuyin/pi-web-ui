import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import {
	getSdkBuiltinExtensionFactories,
	SDK_DISABLED_BUILTIN_EXTENSIONS,
} from "../../server/sdk-builtin-extensions.js";
import { ModelAdminService } from "../../server/model-admin.js";

describe("llama.cpp local models integration (Issue #755)", () => {
	let testAgentDir: string;
	let testCwd: string;
	let mockServer: Server | null = null;
	const mockPort = 18088;
	const mockServerUrl = `http://127.0.0.1:${mockPort}`;
	const prevEnvUrl = process.env.LLAMA_BASE_URL;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "pi-llama-agent-test-"));
		testCwd = mkdtempSync(join(tmpdir(), "pi-llama-cwd-test-"));
	});

	afterEach(async () => {
		if (prevEnvUrl !== undefined) {
			process.env.LLAMA_BASE_URL = prevEnvUrl;
		} else {
			delete process.env.LLAMA_BASE_URL;
		}
		if (mockServer) {
			await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
			mockServer = null;
		}
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
			rmSync(testCwd, { recursive: true, force: true });
		} catch {}
	});

	it("1. getSdkBuiltinExtensionFactories 成功加载内置扩展，包含 llama.cpp 且排除 mcp", async () => {
		const factories = await getSdkBuiltinExtensionFactories();
		const names = factories.map((f) => f.name);

		expect(names).toContain("llama.cpp");
		expect(names).toContain("codemode");
		expect(names).toContain("tool-search");
		expect(names).not.toContain("mcp");

		const llamaExt = factories.find((f) => f.name === "llama.cpp");
		expect(llamaExt?.builtin).toBe(true);
		expect(typeof llamaExt?.factory).toBe("function");

		expect(SDK_DISABLED_BUILTIN_EXTENSIONS).toContain("mcp");
	});

	it("2. createAgentSessionServices 装配后，llama.cpp provider 成功注册进 modelRuntime", async () => {
		const factories = await getSdkBuiltinExtensionFactories();
		const services = await createAgentSessionServices({
			cwd: testCwd,
			agentDir: testAgentDir,
			resourceLoaderOptions: {
				disabledBuiltinExtensions: SDK_DISABLED_BUILTIN_EXTENSIONS,
				extensionFactories: factories,
			},
		});

		const mr = services.modelRuntime;
		const provider = (mr as any).models?.getProvider("llama.cpp");
		expect(provider).toBeDefined();
		expect(provider?.id).toBe("llama.cpp");
	});

	it("3. 模拟 llama-server router 模式，mr.refresh 能成功拉取并在 getAvailable 中列出本地模型", async () => {
		mockServer = createServer((req, res) => {
			if (req.url === "/v1/models" || req.url === "/models") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						data: [
							{
								id: "local-llama-3-8b-instruct",
								object: "model",
								status: { value: "loaded" },
							},
						],
					}),
				);
			} else if (req.url?.startsWith("/props")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ default_generation_settings: {}, models_autoload: false }));
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		await new Promise<void>((resolve) => mockServer!.listen(mockPort, "127.0.0.1", () => resolve()));
		process.env.LLAMA_BASE_URL = mockServerUrl;

		const factories = await getSdkBuiltinExtensionFactories();
		const services = await createAgentSessionServices({
			cwd: testCwd,
			agentDir: testAgentDir,
			resourceLoaderOptions: {
				disabledBuiltinExtensions: SDK_DISABLED_BUILTIN_EXTENSIONS,
				extensionFactories: factories,
			},
		});

		const mr = services.modelRuntime;
		await mr.refresh({ allowNetwork: true });

		const available = await mr.getAvailable();
		const llamaModels = available.filter((m) => m.provider === "llama.cpp");

		expect(llamaModels.length).toBeGreaterThan(0);
		expect(llamaModels[0].id).toBe("local-llama-3-8b-instruct");
		expect(llamaModels[0].provider).toBe("llama.cpp");
	});

	it("4. ModelAdminService 为 llama.cpp 保存密钥时自动补齐 LLAMA_BASE_URL 环境配置", async () => {
		const emitted: any[] = [];
		const mockHost: any = {
			agentDir: testAgentDir,
			emit: (msg: any) => emitted.push(msg),
			flushSnapshot: () => {},
			pushModels: async () => {},
			invalidatePiConfig: () => {},
			modelRuntime: () => null,
		};

		const admin = new ModelAdminService(mockHost);
		await admin.setProviderApiKey("llama.cpp", "test-key");

		const authFile = join(testAgentDir, "auth.json");
		const auth = JSON.parse(readFileSync(authFile, "utf8"));
		expect(auth["llama.cpp"]).toBeDefined();
		expect(auth["llama.cpp"].type).toBe("api_key");
		expect(auth["llama.cpp"].key).toBe("test-key");
		expect(auth["llama.cpp"].env?.LLAMA_BASE_URL).toBeDefined();
	});
});
