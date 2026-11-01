/**
 * image-toolkit 一体化合并单测 —— AI 生图与图像处理无缝流转。
 *
 * 覆盖：
 *   - manifest 规范校验与 catalog 一致性；
 *   - 7 个 AI 工具完整注册与纯英文/长度合规性；
 *   - 支持当下主流生图模型预设（通义万相 Wanx 2.1、FLUX.1、Seedream 4.0、CogView-4、Imagen 3 等）；
 *   - AI 可配置生图供应商配置（image_config_service 的 list/get/upsert/probe/fetch_models/set_default/delete）；
 *   - 生图产物与图像处理工具链的无缝流转协同（image_generate → image_transform → image_compress → references 图生图）；
 *   - 反激活注销。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import { validatePluginManifest } from "../../server/plugin-manifest-validate.js";
import imageToolkit from "../../plugins/image-toolkit/index.mjs";
import { PRESETS } from "../../plugins/image-toolkit/core/gen-config.mjs";
import { encodeImage } from "../../plugins/image-toolkit/core/codec.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, "plugins", "image-toolkit", "manifest.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(ROOT, "plugins", "catalog.json"), "utf8")) as Array<
	Record<string, unknown>
>;

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.unstubAllGlobals();
	while (cleanups.length) cleanups.pop()?.();
});

function pngBytes(n = 96) {
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);
}

function jsonRes(obj: unknown, status = 200) {
	const text = JSON.stringify(obj);
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: "OK",
		headers: { get: (k: string) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
		arrayBuffer: async () => Uint8Array.from(Buffer.from(text, "utf8")).buffer,
	};
}

function stubFetch(routes: Array<[string, (url: string, init: any) => unknown]>) {
	const calls: Array<{ url: string; init: any }> = [];
	const fetchImpl = async (url: string, init: any) => {
		calls.push({ url, init });
		for (const [needle, handler] of routes) {
			if (url.includes(needle)) return handler(url, init);
		}
		throw new Error(`fetch stub 未覆盖：${url}`);
	};
	vi.stubGlobal("fetch", fetchImpl);
	return calls;
}

function makeEnv() {
	const dir = mkdtempSync(join(tmpdir(), "pi-img-merge-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const files = new Map<string, Buffer>();
	const fsImpl = {
		read: async (rel: string) => {
			const b = files.get(rel);
			if (!b) throw new Error(`ENOENT ${rel}`);
			return b;
		},
		readText: async (rel: string) => {
			const b = files.get(rel);
			if (!b) throw new Error(`ENOENT ${rel}`);
			return b.toString("utf8");
		},
		write: async (rel: string, data: Uint8Array) => {
			files.set(rel, Buffer.from(data));
		},
		mkdir: async () => {},
		list: async (d = "") =>
			[...files.keys()]
				.filter((k) => (d ? k.startsWith(d) : true))
				.map((k) => ({ name: k.split("/").pop()!, type: "file" as const })),
		stat: async (rel: string) => {
			const b = files.get(rel);
			if (!b) throw new Error(`ENOENT ${rel}`);
			return { name: rel, type: "file" as const, size: b.length, mtime: 0 };
		},
		remove: async (rel: string) => {
			files.delete(rel);
		},
	};
	const host = createMockHost({ cwd: "E:/ws", dir, dataDir: dir, fs: fsImpl }) as any;
	cleanups.push(() => host.deactivate?.());
	return { host, dir, files };
}

function toolOf(host: any, name: string) {
	const t = host.mock.agentTools.find((x: any) => x.name === name);
	if (!t) throw new Error(`tool not found: ${name}`);
	return t;
}

describe("image-toolkit manifest 与插件注册", () => {
	it("manifest 过校验且 catalog 记录同步，图标沿用 AI 生图图标（🎨）", () => {
		const v = validatePluginManifest(manifest, "image-toolkit");
		expect(v.errors).toEqual([]);
		expect(manifest.version).toBe("0.2.4");
		expect(manifest.icon).toBe("🎨");
		expect(manifest.iconSvg).toContain('path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"');
		expect(manifest.permissions).toContain("tools");
		expect(manifest.permissions).toContain("storage");
		expect(manifest.permissions).toContain("secrets");

		const entry = catalog.find((e) => e.id === "image-toolkit");
		expect(entry).toBeTruthy();
		expect(entry?.icon).toBe("🎨");
		expect(entry?.iconSvg).toBe(manifest.iconSvg);
		expect(entry?.description).toContain("一体化 AI 生图与图像处理工作台");
	});

	it("activate 注册 8 个一体化 AI 工具与全部路由", () => {
		const { host } = makeEnv();
		imageToolkit.activate(host);
		const tools = host.mock.agentTools.map((t: any) => t.name).sort();
		expect(tools).toEqual([
			"image_compress",
			"image_config_service",
			"image_generate",
			"image_info",
			"image_pick_color",
			"image_services",
			"image_transform",
			"image_watermark",
		]);

		const routes = host.mock.routes.map((r: any) => `${r.method} ${r.path}`);
		expect(routes).toContain("GET /ws/settings");
		expect(routes).toContain("POST /ws/save");
		expect(routes).toContain("GET /ws/pick-color");
		expect(routes).toContain("GET /gen/config");
		expect(routes).toContain("POST /gen/generate");
	});

	it("所有 8 个工具提示词规范且纯英文", () => {
		const { host } = makeEnv();
		imageToolkit.activate(host);
		const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;
		for (const tool of host.mock.agentTools) {
			expect(tool.description.length).toBeLessThanOrEqual(600);
			expect(CJK.test(tool.description)).toBe(false);
			expect(tool.promptSnippet.length).toBeLessThanOrEqual(80);
			expect(CJK.test(tool.promptSnippet)).toBe(false);
			expect(tool.promptSnippet.startsWith(tool.name)).toBe(false);
			for (const g of tool.promptGuidelines ?? []) {
				expect(CJK.test(g)).toBe(false);
			}
		}
	});
});

describe("主流生图模型预设支持", () => {
	it("包含通义万相、FLUX、豆包 Seedream、CogView-4、Google Imagen 3 等主流预设", () => {
		const presetIds = PRESETS.map((p) => p.id);
		expect(presetIds).toContain("dashscope");
		expect(presetIds).toContain("siliconflow");
		expect(presetIds).toContain("ark");
		expect(presetIds).toContain("zhipu");
		expect(presetIds).toContain("google");
		expect(presetIds).toContain("openai");
		expect(presetIds).toContain("stability");
		expect(presetIds).toContain("comfyui");

		const wanx = PRESETS.find((p) => p.id === "dashscope")!;
		expect(wanx.service.models).toContain("wanx2.1-t2i-turbo");
		expect(wanx.service.models).toContain("wanx2.1-t2i-plus");

		const sf = PRESETS.find((p) => p.id === "siliconflow")!;
		expect(sf.service.models).toContain("black-forest-labs/FLUX.1-schnell");

		const ark = PRESETS.find((p) => p.id === "ark")!;
		expect(ark.service.models).toContain("doubao-seedream-4-0-t2i");

		const google = PRESETS.find((p) => p.id === "google")!;
		expect(google.service.models).toContain("imagen-3.0-generate-002");
	});
});

describe("AI 配置生图服务商（image_config_service）", () => {
	it("完整支持 list, upsert, get, probe, fetch_models, set_default, delete 操作", async () => {
		stubFetch([
			[
				"/models",
				() =>
					jsonRes({
						data: [
							{ id: "black-forest-labs/FLUX.1-schnell" },
							{ id: "black-forest-labs/FLUX.1-dev" },
							{ id: "stabilityai/stable-diffusion-3-5-large" },
						],
					}),
			],
		]);

		const { host } = makeEnv();
		imageToolkit.activate(host);
		const cfgTool = toolOf(host, "image_config_service");

		// 1. list
		const listRes: any = await cfgTool.execute("t1", { action: "list" });
		expect(listRes.details.presets.length).toBeGreaterThan(6);
		expect(listRes.content[0].text).toContain("Configured services");

		// 2. upsert 添加硅基流动服务
		const upsertRes: any = await cfgTool.execute("t2", {
			action: "upsert",
			id: "siliconflow-main",
			preset: "siliconflow",
			apiKey: "sk-siliconflow-secret",
			defaultModel: "black-forest-labs/FLUX.1-schnell",
			setDefault: true,
		});
		expect(upsertRes.content[0].text).toContain("Added service 'siliconflow-main'");
		expect(upsertRes.details.service.hasKey).toBe(true);
		expect(host.secrets.get("svc:siliconflow-main")).toBe("sk-siliconflow-secret");

		// 3. get
		const getRes: any = await cfgTool.execute("t3", { action: "get", id: "siliconflow-main" });
		expect(getRes.details.service.id).toBe("siliconflow-main");
		expect(getRes.details.service.defaultModel).toBe("black-forest-labs/FLUX.1-schnell");

		// 4. probe
		const probeRes: any = await cfgTool.execute("t4", { action: "probe", id: "siliconflow-main" });
		expect(probeRes.details.ok).toBe(true);
		expect(probeRes.details.models.length).toBeGreaterThan(0);

		// 5. fetch_models 并保存
		const fetchRes: any = await cfgTool.execute("t5", {
			action: "fetch_models",
			id: "siliconflow-main",
			saveModels: true,
		});
		expect(fetchRes.details.saved).toBe(true);
		expect(fetchRes.details.models).toContain("black-forest-labs/FLUX.1-schnell");

		// 6. 添加通义万相并 set_default
		await cfgTool.execute("t6", {
			action: "upsert",
			id: "wanx-ai",
			preset: "dashscope",
		});
		const defRes: any = await cfgTool.execute("t7", { action: "set_default", id: "wanx-ai" });
		expect(defRes.details.defaultService).toBe("wanx-ai");

		// 7. delete
		const delRes: any = await cfgTool.execute("t8", { action: "delete", id: "siliconflow-main" });
		expect(delRes.details.removedId).toBe("siliconflow-main");
		expect(host.secrets.has("svc:siliconflow-main")).toBe(false);
	});
});

describe("图像生成与图像处理无缝流转", () => {
	it("image_generate 产出可无缝流转至 image_transform 与 image_compress，并作为 references 回流", async () => {
		const rawPng = await encodeImage(
			{
				width: 80,
				height: 60,
				data: new Uint8Array(80 * 60 * 4).fill(200),
				hasAlpha: false,
				format: "png",
			},
			"png",
		);

		stubFetch([
			[
				"/images/generations",
				() =>
					jsonRes({
						data: [{ b64_json: rawPng.toString("base64") }],
					}),
			],
			[
				"/images/edits",
				() =>
					jsonRes({
						data: [{ b64_json: rawPng.toString("base64") }],
					}),
			],
		]);

		const { host, files } = makeEnv();
		imageToolkit.activate(host);

		// 1. 配置生图服务
		const cfgTool = toolOf(host, "image_config_service");
		await cfgTool.execute("c1", {
			action: "upsert",
			id: "test-openai",
			preset: "openai",
			apiKey: "sk-mock-key",
			setDefault: true,
		});

		// 2. 调用 image_generate 出图
		const genTool = toolOf(host, "image_generate");
		const genRes: any = await genTool.execute("g1", { prompt: "A cozy studio desk" });
		expect(genRes.details.files.length).toBe(1);
		const genFilePath = genRes.details.files[0].path;
		expect(files.has(genFilePath)).toBe(true);
		expect(genRes.content[0].text).toContain(
			"Workflow hint: You can now pass these generated images to `image_transform`",
		);

		// 3. 将生图产物无缝送入 image_info 查看元数据
		const infoTool = toolOf(host, "image_info");
		const infoRes: any = await infoTool.execute("i1", { path: genFilePath });
		const parsedInfo = JSON.parse(infoRes.content[0].text);
		expect(parsedInfo[0].size).toBe("80×60");

		// 4. 将生图产物无缝送入 image_transform 进行裁剪与缩放
		const transformTool = toolOf(host, "image_transform");
		const transRes: any = await transformTool.execute("tr1", {
			path: genFilePath,
			resize: { width: 40, height: 30 },
			suffix: "-thumb",
		});
		expect(transRes.details.results[0].error).toBeUndefined();
		const transFilePath = transRes.details.results[0].outRel;
		expect(files.has(transFilePath)).toBe(true);

		// 5. 将处理产物送入 image_compress 进一步压缩体积
		const compressTool = toolOf(host, "image_compress");
		const compRes: any = await compressTool.execute("cp1", {
			path: transFilePath,
			format: "png",
			suffix: "-tiny",
		});
		expect(compRes.details.results[0].error).toBeUndefined();
		const compFilePath = compRes.details.results[0].outRel;
		expect(files.has(compFilePath)).toBe(true);

		// 6. 将加工优化后的图片作为 references 回传入 image_generate 执行图生图（Img2Img）
		const editRes: any = await genTool.execute("g2", {
			prompt: "Watercolor version",
			references: [compFilePath],
		});
		expect(editRes.details.files.length).toBe(1);
		expect(files.has(editRes.details.files[0].path)).toBe(true);

		// 7. AI 像素取色并获取局部放大截图（image_pick_color）
		const pickTool = toolOf(host, "image_pick_color");
		const pickRes: any = await pickTool.execute("pc1", {
			path: genFilePath,
			x: 10,
			y: 10,
			cropSize: 32,
			zoom: 4,
			marker: true,
			out: "crops/picked.png",
		});
		expect(pickRes.content.length).toBe(2);
		expect(pickRes.content[0].type).toBe("text");
		expect(pickRes.content[0].text).toContain("Picked color at (10, 10)");
		expect(pickRes.content[0].text).toContain("HEX:");
		expect(pickRes.content[0].text).toContain("Location crop:");
		expect(pickRes.content[1].type).toBe("image");
		expect(pickRes.content[1].mimeType).toBe("image/png");
		expect(typeof pickRes.content[1].data).toBe("string");
		expect(pickRes.details.coords).toEqual({ x: 10, y: 10 });
		expect(pickRes.details.color.hex).toBeDefined();
		expect(files.has("crops/picked.png")).toBe(true);

		// 坐标越界时给出明确友好的错误提示
		await expect(
			pickTool.execute("pc2", {
				path: genFilePath,
				x: 9999,
				y: 9999,
			}),
		).rejects.toThrow(/超出图片尺寸/);
	});
});

describe("image-toolkit 反激活", () => {
	it("注销后全部路由与 8 个 AI 工具清空", () => {
		const { host } = makeEnv();
		const off = imageToolkit.activate(host) as (() => void) | undefined;
		expect(host.mock.routes.length).toBeGreaterThan(0);
		expect(host.mock.agentTools.length).toBe(8);
		off?.();
		expect(host.mock.routes).toEqual([]);
		expect(host.mock.agentTools).toEqual([]);
	});
});
