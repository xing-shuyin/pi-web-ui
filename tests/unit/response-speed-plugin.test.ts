import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import responseSpeedPlugin, { calcStats, formatDuration } from "../../plugins/response-speed/index.mjs";
import { validatePluginManifest } from "../../server/plugin-manifest-validate.js";

describe("response-speed 插件测试", () => {
	describe("纯函数: formatDuration", () => {
		it("正确格式化非法或空输入", () => {
			expect(formatDuration(-1)).toBe("--");
			expect(formatDuration(NaN)).toBe("--");
			expect(formatDuration(null as any)).toBe("--");
			expect(formatDuration(undefined as any)).toBe("--");
		});

		it("正确格式化毫秒级时间 (<1000ms)", () => {
			expect(formatDuration(0)).toBe("0ms");
			expect(formatDuration(450)).toBe("450ms");
			expect(formatDuration(999)).toBe("999ms");
			expect(formatDuration(820.4)).toBe("820ms");
		});

		it("正确格式化秒级时间 (1s ~ 60s)", () => {
			expect(formatDuration(1000)).toBe("1s");
			expect(formatDuration(1250)).toBe("1.25s");
			expect(formatDuration(5600)).toBe("5.6s");
			expect(formatDuration(15000)).toBe("15s");
		});

		it("正确格式化分钟级时间 (>=60s)", () => {
			expect(formatDuration(60000)).toBe("1m");
			expect(formatDuration(125000)).toBe("2.1m");
		});
	});

	describe("纯函数: calcStats", () => {
		it("空列表或无效列表返回默认空统计", () => {
			expect(calcStats([])).toEqual({
				count: 0,
				avgMs: null,
				minMs: null,
				maxMs: null,
				latestMs: null,
				recent: [],
			});

			expect(calcStats(null as any)).toEqual({
				count: 0,
				avgMs: null,
				minMs: null,
				maxMs: null,
				latestMs: null,
				recent: [],
			});
		});

		it("过滤负数或非数字的非法记录", () => {
			const raw = [{ latencyMs: -100 }, { latencyMs: NaN }, { latencyMs: 0 }, { latencyMs: 500 }];
			const stats = calcStats(raw as any);
			expect(stats.count).toBe(1);
			expect(stats.avgMs).toBe(500);
			expect(stats.minMs).toBe(500);
			expect(stats.maxMs).toBe(500);
			expect(stats.latestMs).toBe(500);
		});

		it("正确计算多轮响应的平均值、最快、最慢与最新耗时", () => {
			const records = [
				{ latencyMs: 400, timestamp: 1000 },
				{ latencyMs: 1200, timestamp: 2000 },
				{ latencyMs: 800, timestamp: 3000 },
			];
			const stats = calcStats(records);
			expect(stats.count).toBe(3);
			// (400 + 1200 + 800) / 3 = 800
			expect(stats.avgMs).toBe(800);
			expect(stats.minMs).toBe(400);
			expect(stats.maxMs).toBe(1200);
			expect(stats.latestMs).toBe(800);
			expect(stats.recent.length).toBe(3);
			expect(stats.recent[0].latencyMs).toBe(800); // 倒序排在首位
		});
	});

	describe("manifest 校验", () => {
		it("manifest.json 完全符合宿主规范且无 errors", () => {
			const manifestPath = join(process.cwd(), "plugins", "response-speed", "manifest.json");
			const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
			const validation = validatePluginManifest(raw, "response-speed");

			expect(validation.errors).toEqual([]);
			expect(validation.apiVersion).toBe(2);
			expect(raw.version).toBe("0.3.3");
			expect(validation.permissions).toContain("ui");
			expect(validation.permissions).toContain("http");
			expect(validation.permissions).toContain("storage");
			expect(raw.preload).toBe(true);
			expect(raw.view).toBe(false);
			expect(raw.ui.bottombar).toBeDefined();
			expect(raw.ui.bottombar[0].id).toBe("response-speed-badge");
			expect(raw.ui.bottombar[0].label).toBe("--/--");
			expect(raw.ui.bottombar[0].labelEn).toBe("--/--");
		});
	});

	describe("服务端插件生命周期与状态栏更新", () => {
		it("activate 初始化存储、注册路由、更新底栏并响应请求", () => {
			const storageMap = new Map<string, any>();
			const uiUpdates = new Map<string, any>();
			const routes = new Map<string, (req: any, res: any) => void>();
			const broadcasted: any[] = [];

			const mockHost = {
				storage: {
					get: vi.fn((k: string) => storageMap.get(k)),
					set: vi.fn((k: string, v: any) => storageMap.set(k, v)),
				},
				ui: {
					update: vi.fn((id: string, patch: any) => uiUpdates.set(id, patch)),
				},
				route: vi.fn((method: string, path: string, handler: any) => {
					routes.set(`${method} ${path}`, handler);
					return () => {};
				}),
				broadcast: vi.fn((payload: any) => broadcasted.push(payload)),
				onAttach: vi.fn(),
				onRunEvent: vi.fn(),
				onConversationChanged: vi.fn(),
				getActiveConversation: vi.fn(() => ({ conversationId: "conv-1" })),
				onUiAction: vi.fn(),
			};

			const cleanup = responseSpeedPlugin.activate(mockHost as any);
			expect(typeof cleanup).toBe("function");

			// 初始底栏应为 --/--，且提示文案严格遵守宿主 ≤200 字符限制（避免触发诊断警告）
			const initialBadge = uiUpdates.get("response-speed-badge");
			expect(initialBadge).toBeDefined();
			expect(initialBadge.label).toBe("--/--");
			expect(initialBadge.labelEn).toBe("--/--");
			expect(initialBadge.hint?.length).toBeLessThanOrEqual(200);
			expect(initialBadge.hintEn?.length).toBeLessThanOrEqual(200);

			// 测试 GET /stats 路由
			const getStats = routes.get("GET /stats");
			expect(getStats).toBeDefined();
			let statsJson: any = null;
			getStats!(
				{ query: { conversationId: "conv-1" } },
				{
					json: (val: any) => {
						statsJson = val;
					},
				},
			);
			expect(statsJson.ok).toBe(true);
			expect(statsJson.conversationId).toBe("conv-1");
			expect(statsJson.stats.count).toBe(0);

			// 测试 POST /record 路由（上报首字响应）
			const postRecord = routes.get("POST /record");
			expect(postRecord).toBeDefined();
			let recordJson: any = null;
			postRecord!(
				{ body: { latencyMs: 650, model: "gpt-4o", conversationId: "conv-1" } },
				{
					json: (val: any) => {
						recordJson = val;
					},
				},
			);
			expect(recordJson.ok).toBe(true);
			expect(recordJson.record.latencyMs).toBe(650);
			expect(recordJson.conversationId).toBe("conv-1");
			expect(recordJson.stats.count).toBe(1);
			expect(recordJson.stats.avgMs).toBe(650);

			// 底栏应已刷新为 0.7/0.7（650ms 换算为秒，一位小数），且更新后的提示文案严格 ≤200 字符
			const updatedBadge = uiUpdates.get("response-speed-badge");
			expect(updatedBadge.label).toBe("0.7/0.7");
			expect(updatedBadge.labelEn).toBe("0.7/0.7");
			expect(updatedBadge.hint?.length).toBeLessThanOrEqual(200);
			expect(updatedBadge.hintEn?.length).toBeLessThanOrEqual(200);

			// 上报非法数据应返回 400
			let errorStatus = 0;
			let errorJson: any = null;
			postRecord!(
				{ body: { latencyMs: -10 } },
				{
					status: (s: number) => {
						errorStatus = s;
						return {
							json: (val: any) => {
								errorJson = val;
							},
						};
					},
				},
			);
			expect(errorStatus).toBe(400);

			// 测试 POST /reset 路由
			const postReset = routes.get("POST /reset");
			expect(postReset).toBeDefined();
			let resetJson: any = null;
			postReset!(
				{ body: { conversationId: "conv-1" } },
				{
					json: (val: any) => {
						resetJson = val;
					},
				},
			);
			expect(resetJson.ok).toBe(true);
			expect(resetJson.conversationId).toBe("conv-1");

			// 底栏应复位为 --/--
			const resetBadge = uiUpdates.get("response-speed-badge");
			expect(resetBadge.label).toBe("--/--");

			cleanup!();
		});

		it("不显示响应中，直接显示上一次的时间，并且支持 AI 自循环每一次独立测速", () => {
			const storageMap = new Map<string, any>();
			const uiUpdates = new Map<string, any>();
			let runEventHandler: ((ev: any) => void) | null = null;

			const mockHost = {
				storage: {
					get: vi.fn((k: string) => storageMap.get(k)),
					set: vi.fn((k: string, v: any) => storageMap.set(k, v)),
				},
				ui: {
					update: vi.fn((id: string, patch: any) => uiUpdates.set(id, patch)),
				},
				route: vi.fn(() => () => {}),
				broadcast: vi.fn(),
				onAttach: vi.fn(),
				onConversationChanged: vi.fn(),
				getActiveConversation: vi.fn(() => ({ conversationId: "conv-1" })),
				onRunEvent: vi.fn((fn: any) => {
					runEventHandler = fn;
					return () => {};
				}),
				onUiAction: vi.fn(),
			};

			const cleanup = responseSpeedPlugin.activate(mockHost as any);
			expect(runEventHandler).toBeDefined();

			// 1. 首轮回合开始（用户刚发完提问）
			// 【关键需求】：不要显示响应中！直接显示上一次的时间（初始为 --/--）
			runEventHandler!({
				type: "turn_start",
				conversationId: "conv-1",
				at: 1000,
			});
			expect(uiUpdates.get("response-speed-badge").label).toBe("--/--");

			// 2. 首轮大模型首包返回（耗时 400ms）
			runEventHandler!({
				type: "turn_first_token",
				conversationId: "conv-1",
				at: 1400,
				durationMs: 400,
			});
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.4/0.4");

			// 3. 模型执行工具并结束第一回合
			runEventHandler!({
				type: "turn_end",
				conversationId: "conv-1",
				at: 2000,
			});
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.4/0.4");

			// 4. 【关键需求】：AI 进入自循环（工具执行完毕后进入第二回合）
			// 此时不要显示“响应中…”，而是直接显示上一次的时间 0.4/0.4
			runEventHandler!({
				type: "turn_start",
				conversationId: "conv-1",
				at: 2500,
			});
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.4/0.4");

			// 5. 自循环第二回合首包返回（耗时 600ms）
			runEventHandler!({
				type: "turn_first_token",
				conversationId: "conv-1",
				at: 3100,
				durationMs: 600,
			});
			// 最新为 600ms (0.6s)，均速为 (400 + 600) / 2 = 500ms (0.5s)
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.6/0.5");

			// 6. 第二回合结束，任务完成
			runEventHandler!({
				type: "turn_end",
				conversationId: "conv-1",
				at: 3500,
			});
			runEventHandler!({
				type: "run_end",
				conversationId: "conv-1",
				at: 3600,
			});
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.6/0.5");

			cleanup!();
		});

		it("每个对话独立记录，切换对话时底栏自动刷新对应对话的数据且互不干扰", () => {
			const storageMap = new Map<string, any>();
			const uiUpdates = new Map<string, any>();
			const routes = new Map<string, (req: any, res: any) => void>();
			let runEventHandler: ((ev: any) => void) | null = null;
			let conversationChangeHandler: (() => void) | null = null;
			let currentActiveConvId = "conv-A";

			const mockHost = {
				storage: {
					get: vi.fn((k: string) => storageMap.get(k)),
					set: vi.fn((k: string, v: any) => storageMap.set(k, v)),
				},
				ui: {
					update: vi.fn((id: string, patch: any) => uiUpdates.set(id, patch)),
				},
				route: vi.fn((method: string, path: string, handler: any) => {
					routes.set(`${method} ${path}`, handler);
					return () => {};
				}),
				broadcast: vi.fn(),
				onAttach: vi.fn(),
				onConversationChanged: vi.fn((fn: any) => {
					conversationChangeHandler = fn;
					return () => {};
				}),
				getActiveConversation: vi.fn(() => ({ conversationId: currentActiveConvId })),
				onRunEvent: vi.fn((fn: any) => {
					runEventHandler = fn;
					return () => {};
				}),
				onUiAction: vi.fn(),
			};

			const cleanup = responseSpeedPlugin.activate(mockHost as any);
			expect(conversationChangeHandler).toBeDefined();

			// 1. conv-A 回合执行（耗时 300ms）
			runEventHandler!({
				type: "turn_start",
				conversationId: "conv-A",
				at: 1000,
			});
			runEventHandler!({
				type: "turn_first_token",
				conversationId: "conv-A",
				at: 1300,
				durationMs: 300,
			});
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.3/0.3");

			// 2. 用户在界面上切换到了 conv-B（新对话，尚无记录）
			currentActiveConvId = "conv-B";
			conversationChangeHandler!();
			expect(uiUpdates.get("response-speed-badge").label).toBe("--/--");

			// 3. conv-B 产生提问与首包响应（耗时 900ms）
			runEventHandler!({
				type: "turn_start",
				conversationId: "conv-B",
				at: 2000,
			});
			// turn_start 时不显示响应中，仍为上一次时间（conv-B 之前无记录，所以是 --/--）
			expect(uiUpdates.get("response-speed-badge").label).toBe("--/--");

			runEventHandler!({
				type: "turn_first_token",
				conversationId: "conv-B",
				at: 2900,
				durationMs: 900,
			});
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.9/0.9");

			// 4. 用户切回 conv-A
			currentActiveConvId = "conv-A";
			conversationChangeHandler!();
			// 底栏应立即无缝恢复为 conv-A 的独立统计：0.3/0.3
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.3/0.3");

			// 5. 在 conv-A 执行 reset 清空
			const postReset = routes.get("POST /reset");
			postReset!(
				{ body: { conversationId: "conv-A" } },
				{
					json: () => {},
				},
			);
			expect(uiUpdates.get("response-speed-badge").label).toBe("--/--");

			// 6. 再切回 conv-B，验证 conv-B 的统计数据未受 conv-A 重置的影响
			currentActiveConvId = "conv-B";
			conversationChangeHandler!();
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.9/0.9");

			cleanup!();
		});

		it("兼容旧版单一 records 存储结构并平滑迁移", () => {
			const storageMap = new Map<string, any>();
			// 模拟旧版本存储数据
			storageMap.set("records", [
				{ latencyMs: 500, timestamp: 1000, conversationId: "legacy-conv" },
				{ latencyMs: 700, timestamp: 2000, conversationId: "legacy-conv" },
			]);

			const uiUpdates = new Map<string, any>();
			const mockHost = {
				storage: {
					get: vi.fn((k: string) => storageMap.get(k)),
					set: vi.fn((k: string, v: any) => storageMap.set(k, v)),
				},
				ui: {
					update: vi.fn((id: string, patch: any) => uiUpdates.set(id, patch)),
				},
				route: vi.fn(() => () => {}),
				broadcast: vi.fn(),
				onAttach: vi.fn(),
				onConversationChanged: vi.fn(),
				getActiveConversation: vi.fn(() => ({ conversationId: "legacy-conv" })),
				onRunEvent: vi.fn(),
				onUiAction: vi.fn(),
			};

			const cleanup = responseSpeedPlugin.activate(mockHost as any);
			// legacy-conv 数据已迁移生效：(500 + 700) / 2 = 600ms -> 最新 700ms (0.7s) / 均速 600ms (0.6s)
			expect(uiUpdates.get("response-speed-badge").label).toBe("0.7/0.6");

			cleanup!();
		});
	});
});
