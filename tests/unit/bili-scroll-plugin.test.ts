import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("bili-scroll plugin 2.0 verification", () => {
	const pluginDir = join(process.cwd(), "plugins", "bili-scroll");

	it("manifest.json and package.json have matching version", () => {
		const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
		const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));

		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.version).toBe(manifest.version);
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.permissions).toContain("tools");
		expect(manifest.permissions).toContain("ui");
		expect(manifest.permissions).toContain("http");
	});

	it("contains all essential 2.0 modules and prompts", () => {
		const files = [
			"index.mjs",
			"bilibili-api.mjs",
			"credentials.mjs",
			"duty.mjs",
			"prompts/duty.md",
			"lib/uid.mjs",
			"lib/dm.mjs",
			"lib/verify.mjs",
			"lib/uvfetch.mjs",
			"lib/favops.mjs",
			"lib/asr.py",
			"client/entry.mjs",
		];

		for (const f of files) {
			expect(existsSync(join(pluginDir, f)), `File ${f} must exist`).toBe(true);
		}
	});

	it("catalog.json 正确收录 bili-scroll 插件", () => {
		const raw = readFileSync(join(process.cwd(), "plugins", "catalog.json"), "utf8");
		const catalog = JSON.parse(raw);
		const item = catalog.find((p: any) => p.id === "bili-scroll");
		expect(item).toBeDefined();
		expect(item.name).toBe("bili-scroll");
		expect(item.source).toContain("bili-scroll");
		expect(item.icon).toBe("📺");
	});

	it("duty.md includes 2.0 charter principles", () => {
		const charter = readFileSync(join(pluginDir, "prompts", "duty.md"), "utf8");
		expect(charter).toContain("AGENTS.md");
		expect(charter).toContain("### BV");
		expect(charter).toContain("dmMode");
		expect(charter).toContain("bili_send_message");
		expect(charter).toContain("值得看");
	});

	it("activates successfully in host mock and registers tools", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-test-bili-"));
		const mod = await import(join(pluginDir, "index.mjs"));
		const registeredTools: string[] = [];
		const mockHost = {
			dataDir: tempDir,
			log: () => {},
			route: () => () => {},
			getSettings: () => ({ perDay: 5, dmMode: "only" }),
			registerAgentTool: (tool: { name: string }) => {
				registeredTools.push(tool.name);
				return () => {};
			},
			onClientMessage: () => () => {},
		};

		try {
			const cleanup = mod.default.activate(mockHost);
			expect(typeof cleanup).toBe("function");

			expect(registeredTools).toContain("bili_whoami");
			expect(registeredTools).toContain("bili_search");
			expect(registeredTools).toContain("bili_subtitle");
			expect(registeredTools).toContain("bili_video_content");
			expect(registeredTools).toContain("bili_dm_sessions");
			expect(registeredTools).toContain("bili_dm_messages");
			expect(registeredTools).toContain("bili_send_message");
			expect(registeredTools).toContain("bili_status");
			expect(registeredTools).toContain("bili_duty_run");
			expect(registeredTools).toContain("bili_resolve_uid");
			expect(registeredTools).toContain("bili_fav_folders");
			expect(registeredTools).toContain("bili_fav_add");

			cleanup();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("/open 路由严格拦截非法或注入 URL", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-test-bili-open-"));
		const mod = await import(join(pluginDir, "index.mjs"));
		const routes = new Map<string, Function>();
		const mockHost = {
			dataDir: tempDir,
			log: () => {},
			route: (_method: string, path: string, handler: Function) => {
				routes.set(path, handler);
				return () => {};
			},
			getSettings: () => ({ perDay: 5, dmMode: "only" }),
			registerAgentTool: () => () => {},
			onClientMessage: () => () => {},
		};

		try {
			const cleanup = mod.default.activate(mockHost);
			const openHandler = routes.get("/open")!;
			expect(openHandler).toBeTruthy();

			let resp: any;
			const fakeRes = {
				json: (d: any) => {
					resp = d;
				},
			};
			openHandler({ body: { what: "url", u: "http://example.com & calc.exe" } }, fakeRes);
			expect(resp?.ok).toBe(false);
			expect(resp?.error).toContain("合法");

			openHandler({ body: { what: "url", u: "file:///etc/passwd" } }, fakeRes);
			expect(resp?.ok).toBe(false);

			cleanup();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("_fetch() 统一注入 15s 超时信号，并优先保留调用方指定的 signal", async () => {
		const { BilibiliApiClient } = await import(join(pluginDir, "bilibili-api.mjs"));
		const client = new BilibiliApiClient({ getHeaders: () => ({}) });

		let capturedSignal: AbortSignal | undefined;
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async (_url: any, opts: any) => {
				capturedSignal = opts?.signal;
				return new Response(JSON.stringify({ code: 0 }));
			}) as any;

			await (client as any)._fetch("https://api.bilibili.com/test");
			expect(capturedSignal).toBeDefined();
			expect(capturedSignal instanceof AbortSignal).toBe(true);

			const customController = new AbortController();
			await (client as any)._fetch("https://api.bilibili.com/test", { signal: customController.signal });
			expect(capturedSignal).toBe(customController.signal);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
