import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ModelAdminService,
	ensureCredentialFilePermissions,
	writeCredentialFile,
	type ModelAdminHost,
} from "../../server/model-admin.js";
import type { ServerMessage } from "../../server/protocol.js";

const isWin = process.platform === "win32";
const modeOf = (p: string): number => statSync(p).mode & 0o777;

let agentDir = "";

function makeRuntime(): ModelRuntime {
	return {
		getProviders: () => [],
		getProvider: () => undefined,
		getProviderAuthStatus: () => ({ configured: false }),
		isUsingOAuth: () => false,
		setRuntimeApiKey: async () => {},
		removeRuntimeApiKey: async () => {},
		refresh: async () => {},
	} as unknown as ModelRuntime;
}

function makeHost(dir: string) {
	const messages: ServerMessage[] = [];
	const host = {
		agentDir: dir,
		emit: (m: ServerMessage) => messages.push(m),
		flushSnapshot: () => {},
		isDisposed: () => false,
		modelRuntime: () => makeRuntime(),
		invalidatePiConfig: () => {},
		pushModels: async () => {},
	} satisfies ModelAdminHost;
	return { host, messages };
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-credperm-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe.skipIf(isWin)("credential file permissions", () => {
	it("setProviderApiKey creates provider-keys.json + auth.json at 0600", async () => {
		const { host } = makeHost(agentDir);
		const svc = new ModelAdminService(host);
		await svc.setProviderApiKey("deepseek", "sk-A");
		expect(modeOf(join(agentDir, "provider-keys.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "auth.json"))).toBe(0o600);
	});

	it("add + activate + remove keep 0600", async () => {
		const { host } = makeHost(agentDir);
		const svc = new ModelAdminService(host);
		await svc.setProviderApiKey("deepseek", "sk-A");
		await svc.addProviderKey("deepseek", "sk-B", "备用");
		expect(modeOf(join(agentDir, "provider-keys.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "auth.json"))).toBe(0o600);
		await svc.activateProviderKey("deepseek", "备用");
		expect(modeOf(join(agentDir, "provider-keys.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "auth.json"))).toBe(0o600);
		await svc.removeProviderKey("deepseek", "备用");
		expect(modeOf(join(agentDir, "provider-keys.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "auth.json"))).toBe(0o600);
	});

	it("clearProviderApiKey keeps 0600", async () => {
		const { host } = makeHost(agentDir);
		const svc = new ModelAdminService(host);
		await svc.setProviderApiKey("deepseek", "sk-A");
		await svc.clearProviderApiKey("deepseek");
		expect(modeOf(join(agentDir, "provider-keys.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "auth.json"))).toBe(0o600);
	});

	it("write chmods a pre-existing 0644 file (no readable window on rewrite)", async () => {
		const { host } = makeHost(agentDir);
		const svc = new ModelAdminService(host);
		await svc.setProviderApiKey("deepseek", "sk-A");
		chmodSync(join(agentDir, "provider-keys.json"), 0o644);
		chmodSync(join(agentDir, "auth.json"), 0o644);
		await svc.addProviderKey("deepseek", "sk-B", "备用");
		expect(modeOf(join(agentDir, "provider-keys.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "auth.json"))).toBe(0o600);
	});

	it("constructor repairs existing 0644 files (startup repair)", () => {
		writeFileSync(join(agentDir, "provider-keys.json"), "{}\n");
		writeFileSync(join(agentDir, "auth.json"), "{}\n");
		writeFileSync(join(agentDir, "models.json"), '{"providers":{}}\n');
		chmodSync(join(agentDir, "provider-keys.json"), 0o644);
		chmodSync(join(agentDir, "auth.json"), 0o644);
		chmodSync(join(agentDir, "models.json"), 0o644);
		const { host } = makeHost(agentDir);
		new ModelAdminService(host);
		expect(modeOf(join(agentDir, "provider-keys.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "auth.json"))).toBe(0o600);
		expect(modeOf(join(agentDir, "models.json"))).toBe(0o600);
	});

	it("writeCredentialFile creates 0600 even under umask 022", () => {
		const p = join(agentDir, "provider-keys.json");
		writeCredentialFile(p, "{}\n");
		expect(modeOf(p)).toBe(0o600);
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({});
	});

	it("ensureCredentialFilePermissions fixes 0644 (shared by DSH auth.json path)", () => {
		const a = join(agentDir, "auth.json");
		const k = join(agentDir, "provider-keys.json");
		const m = join(agentDir, "models.json");
		writeFileSync(a, "{}\n");
		writeFileSync(k, "{}\n");
		writeFileSync(m, '{"providers":{}}\n');
		chmodSync(a, 0o644);
		chmodSync(k, 0o644);
		chmodSync(m, 0o644);
		ensureCredentialFilePermissions(agentDir);
		expect(modeOf(a)).toBe(0o600);
		expect(modeOf(k)).toBe(0o600);
		expect(modeOf(m)).toBe(0o600);
	});
});

describe.skipIf(isWin)("models.json credential permissions", () => {
	it("saveModelConfig creates models.json at 0600 with apiKey intact", async () => {
		const { host } = makeHost(agentDir);
		const svc = new ModelAdminService(host);
		await svc.saveModelConfig("custom1", {
			providerId: "custom1",
			api: "openai-completions",
			baseUrl: "https://example.com/v1",
			apiKey: "sk-secret",
			models: [{ id: "m1" }],
		});
		const p = join(agentDir, "models.json");
		expect(modeOf(p)).toBe(0o600);
		expect(JSON.parse(readFileSync(p, "utf8")).providers.custom1.apiKey).toBe("sk-secret");
	});

	it("save rewrites a pre-existing 0644 models.json to 0600", async () => {
		const { host } = makeHost(agentDir);
		const svc = new ModelAdminService(host);
		await svc.saveModelConfig("custom1", {
			providerId: "custom1",
			baseUrl: "https://example.com/v1",
			models: [{ id: "m1" }],
		});
		chmodSync(join(agentDir, "models.json"), 0o644);
		await svc.saveModelConfig("custom1", {
			providerId: "custom1",
			baseUrl: "https://example.com/v1",
			models: [{ id: "m1" }, { id: "m2" }],
		});
		expect(modeOf(join(agentDir, "models.json"))).toBe(0o600);
	});

	it("deleteModelConfig keeps 0600", async () => {
		const { host } = makeHost(agentDir);
		const svc = new ModelAdminService(host);
		await svc.saveModelConfig("custom1", {
			providerId: "custom1",
			baseUrl: "https://example.com/v1",
			models: [{ id: "m1" }],
		});
		await svc.saveModelConfig("custom2", {
			providerId: "custom2",
			baseUrl: "https://example.com/v1",
			models: [{ id: "m1" }],
		});
		await svc.deleteModelConfig("custom1");
		expect(modeOf(join(agentDir, "models.json"))).toBe(0o600);
	});

	it("appendBuiltinModel keeps 0600", async () => {
		const messages: ServerMessage[] = [];
		const runtime = {
			...makeRuntime(),
			getProvider: () => ({ id: "openai" }),
		} as unknown as ModelRuntime;
		const host = {
			agentDir,
			emit: (m: ServerMessage) => messages.push(m),
			flushSnapshot: () => {},
			isDisposed: () => false,
			modelRuntime: () => runtime,
			invalidatePiConfig: () => {},
			pushModels: async () => {},
		} satisfies ModelAdminHost;
		const svc = new ModelAdminService(host);
		await svc.appendBuiltinModel("openai", { id: "hand-added" }, 1);
		expect(modeOf(join(agentDir, "models.json"))).toBe(0o600);
	});

	it("graduate path (refreshBuiltinModels) keeps 0600", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { openai: { models: [{ id: "new-model" }] } } }),
		);
		chmodSync(join(agentDir, "models.json"), 0o644);
		writeFileSync(
			join(agentDir, "models-store.json"),
			JSON.stringify({ openai: { models: [{ id: "new-model", api: "openai-completions" }] } }),
		);
		const runtime = {
			...makeRuntime(),
			refresh: async () => ({ errors: new Map() }),
		} as unknown as ModelRuntime;
		const host = {
			agentDir,
			emit: () => {},
			flushSnapshot: () => {},
			isDisposed: () => false,
			modelRuntime: () => runtime,
			invalidatePiConfig: () => {},
			pushModels: async () => {},
		} satisfies ModelAdminHost;
		const svc = new ModelAdminService(host);
		chmodSync(join(agentDir, "models.json"), 0o644);
		await svc.refreshBuiltinModels(1);
		expect(modeOf(join(agentDir, "models.json"))).toBe(0o600);
	});
});
