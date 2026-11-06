import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import wechatPlugin, {
	stripInternalMarkers,
	peerAccountId,
	assistantTextOf,
	encodeClientVersion,
	inboundTextOf,
	inboundPartsOf,
	inboundMediaKind,
	checkCwdValid,
	aesEcbPaddedSize,
	encryptAesEcb,
	decryptAesEcb,
	parseAesKey,
	buildMediaRef,
	buildImageItem,
	buildFileItem,
	buildMediaItem,
	buildCdnUploadUrl,
	buildCdnDownloadUrl,
	mimeOfPath,
	mediaKindOfMime,
	sniffImageExt,
} from "../../plugins/wechat-ilink/index.mjs";

describe("wechat-ilink: stripInternalMarkers", () => {
	it("剥离各类 pi-web-ui 内部控制 marker", () => {
		const input = [
			"好的，这就为您安排任务：",
			"[[plan:new:1=调研,2=实现,active=1]]",
			"[[todo:new:开始调研]]",
			"[[conv:rename:微信重命名测试]]",
			"[[notify:info:后台任务已开始]]",
			"我们开始第一步调研。",
		].join("\n");

		const output = stripInternalMarkers(input);
		expect(output).not.toContain("[[plan:");
		expect(output).not.toContain("[[todo:");
		expect(output).not.toContain("[[conv:");
		expect(output).not.toContain("[[notify:");
		expect(output).toBe("好的，这就为您安排任务：\n\n我们开始第一步调研。");
	});

	it("保留普通 wikilink 与数组", () => {
		const input = "请参考 [[Obsidian Note]] 以及矩阵 [[1, 2], [3, 4]]。";
		expect(stripInternalMarkers(input)).toBe(input);
	});

	it("处理 Windows \\r\\n 换行符与多余空行", () => {
		const input = "前言\r\n\r\n[[notify:这是一条通知]]\r\n\r\n\r\n\r\n结语";
		const output = stripInternalMarkers(input);
		expect(output).toBe("前言\n\n结语");
	});

	it("纯 marker 文本清理后为空字符串", () => {
		const input = "[[todo:new:买菜]][[notify:info:done]]";
		expect(stripInternalMarkers(input)).toBe("");
	});
});

describe("wechat-ilink: peerAccountId", () => {
	it("相同 peer 映射出的 accountId 恒定一致", () => {
		const a1 = peerAccountId("user_12345");
		const a2 = peerAccountId("user_12345");
		expect(a1).toBe(a2);
	});

	it("传入 seq > 0 时实现会话隔离，且默认 seq=0 与不传保持向后兼容", () => {
		const aDefault = peerAccountId("user_12345");
		const aZero = peerAccountId("user_12345", 0);
		expect(aDefault).toBe(aZero);

		const aSeq1 = peerAccountId("user_12345", 1);
		const aSeq2 = peerAccountId("user_12345", 2);
		expect(aSeq1).not.toBe(aDefault);
		expect(aSeq1).not.toBe(aSeq2);
		expect(aSeq1).toMatch(/^wx_[a-f0-9]{16}$/);
	});

	it("不同 peer 映射出的 accountId 互不相同", () => {
		const a1 = peerAccountId("wx_user_alpha");
		const a2 = peerAccountId("wx_user_beta");
		expect(a1).not.toBe(a2);
	});

	it("输出格式符合合规键名，长度 <= 64 且仅含安全字符", () => {
		const id = peerAccountId("wx_user_test_@123#xyz");
		expect(id).toMatch(/^wx_[a-f0-9]{16}$/);
		expect(id.length).toBeLessThanOrEqual(64);
		expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
	});

	it("空值安全回退", () => {
		expect(peerAccountId("")).toBe("wx_default");
		expect(peerAccountId("   ")).toBe("wx_default");
		expect(peerAccountId(null)).toBe("wx_default");
		expect(peerAccountId(undefined)).toBe("wx_default");
	});
});

describe("wechat-ilink: assistantTextOf", () => {
	it("提取 assistant 文本并过滤 marker", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "任务开始：\n[[todo:new:第一步]]" },
				{ type: "text", text: "已完成调研。\n[[notify:success:ok]]" },
			],
		};
		const text = assistantTextOf(msg as never);
		expect(text).toBe("任务开始：\n\n已完成调研。");
	});

	it("非 assistant 角色或非 text 块返回空", () => {
		expect(assistantTextOf({ role: "user", content: [{ type: "text", text: "hi" }] } as never)).toBe("");
		expect(assistantTextOf({ role: "assistant", content: [{ type: "image", dataUrl: "..." }] } as never)).toBe("");
		expect(assistantTextOf(null as never)).toBe("");
	});
});

describe("wechat-ilink: 完整入站、隔离与无竞态回包（issue #345）", () => {
	it("隔离 accountId、剥离 marker，并在 early run_end 下可靠发包", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_alice"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		interface SendMessagePayload {
			msg?: {
				to_user_id?: string;
				item_list?: Array<{ text_item?: { text: string } }>;
			};
		}
		let sentPayload: SendMessagePayload | null = null;
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_alice",
									context_token: "ctx_token_123",
									item_list: [{ type: 1, text_item: { text: "请制定计划" } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				sentPayload = JSON.parse(String(init?.body ?? "{}"));
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			if (urlStr.includes("getconfig")) {
				return { ok: true, json: async () => ({ typing_ticket: "ticket_1" }) } as Response;
			}
			if (urlStr.includes("sendtyping") || urlStr.includes("msg/")) {
				return { ok: true, json: async () => ({}) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			let chatResolve: (val: { conversationId: string; clientId: string }) => void = () => {};
			const chatPromise = new Promise<{ conversationId: string; clientId: string }>((resolve) => {
				chatResolve = resolve;
			});

			const hostChatSpy = vi.fn((_req: unknown) => chatPromise);

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);

			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});

			const firstCall = hostChatSpy.mock.calls[0] as unknown[] | undefined;
			const req = (firstCall?.[0] ?? {}) as { accountId?: string; text?: string };
			expect(req.accountId).toBe(peerAccountId("peer_alice"));
			expect(req.accountId).not.toBe("wx");
			expect(req.text).toContain("[微信:peer_alice]");

			const targetConvId = "conv_quick_test";
			expect(runHandler).toBeDefined();

			runHandler!({
				type: "message",
				conversationId: targetConvId,
				clientId: `plugin:wechat-ilink:${req.accountId}`,
				at: Date.now(),
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "计划已就绪：\n[[plan:new:1=方案,active=1]]\n[[todo:new:第一项]]\n请查阅方案详情。",
						},
					],
				},
			});

			runHandler!({
				type: "run_end",
				conversationId: targetConvId,
				clientId: `plugin:wechat-ilink:${req.accountId}`,
				at: Date.now(),
			});

			expect(sentPayload).toBeNull();

			chatResolve({
				conversationId: targetConvId,
				clientId: `plugin:wechat-ilink:${req.accountId}`,
			});

			await vi.waitFor(() => {
				expect(sentPayload).not.toBeNull();
			});

			const payload = sentPayload as unknown as SendMessagePayload;
			expect(payload?.msg?.to_user_id).toBe("peer_alice");
			const outText = payload?.msg?.item_list?.[0]?.text_item?.text ?? "";

			expect(outText).not.toContain("[[plan:");
			expect(outText).not.toContain("[[todo:");
			expect(outText).toBe("计划已就绪：\n\n请查阅方案详情。");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("encodeClientVersion 与 inboundTextOf 正常运行", () => {
		expect(encodeClientVersion("0.1.0")).toBe(String(0x00000100));
		expect(inboundTextOf([{ text_item: { text: "你好" } }])).toBe("你好");
		expect(inboundTextOf([{ image_item: {} }])).toBe("[图片]");
	});
});

describe("wechat-ilink: checkCwdValid", () => {
	it("空路径与空白返回错误", () => {
		expect(checkCwdValid("").ok).toBe(false);
		expect(checkCwdValid("   ").ok).toBe(false);
	});

	it("不存在的目录返回错误", () => {
		const r = checkCwdValid("/non/existent/path/xyz-12345");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("不存在或不是");
	});

	it("存在的目录返回绝对路径", () => {
		const r = checkCwdValid(process.cwd());
		expect(r.ok).toBe(true);
		expect(typeof r.abs).toBe("string");
	});

	if (process.platform === "win32") {
		it("Windows 下拒绝在系统根目录执行", () => {
			const sysRoot = process.env.SystemRoot || "C:\\Windows";
			const r = checkCwdValid(sysRoot);
			expect(r.ok).toBe(false);
			expect(r.error).toContain("拒绝在系统目录执行");
		});
	}
});

describe("wechat-ilink: 斜杠快捷指令 (Slash Commands)", () => {
	it("支持 /help、/status、/cwd、/model、/clear、/new、/stop 及全角 ／ 容错", async () => {
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "wx_bot_tester", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["user_bob"]);

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token_slash" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const replies: string[] = [];
		const mockQueue: Array<{
			message_type: number;
			from_user_id: string;
			item_list: Array<{ type: number; text_item?: { text: string } }>;
		}> = [];
		let waitingResolver: (() => void) | null = null;
		function enqueueMsg(text: string) {
			mockQueue.push({
				message_type: 1,
				from_user_id: "user_bob",
				item_list: [{ type: 1, text_item: { text } }],
			});
			if (waitingResolver) {
				const r = waitingResolver;
				waitingResolver = null;
				r();
			}
		}

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				if (mockQueue.length === 0) {
					await new Promise<void>((r) => {
						waitingResolver = r;
						setTimeout(r, 2000);
					});
				}
				const msgs = mockQueue.splice(0, mockQueue.length);
				return { ok: true, json: async () => ({ ret: 0, msgs }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				const txt = body?.msg?.item_list?.[0]?.text_item?.text ?? "";
				replies.push(txt);
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		const hostChatSpy = vi.fn(async () => ({
			conversationId: "conv_test_123",
			clientId: "client_test",
			runId: "pr-wechat-stop",
		}));
		const hostAbortSpy = vi.fn(async () => ({ ok: true }));
		const hostExecCommandSpy = vi.fn(async (name: string, args: string) => {
			if (name === "todo") return { ok: true, result: `✅ 已加入待办：${args}` };
			return { ok: false, error: "not found" };
		});
		const hostGetPluginCommandsSpy = vi.fn(() => [{ name: "todo", description: "加一条待办", argumentHint: "<内容>" }]);
		const hostReloadSpy = vi.fn(async () => {});

		const host = {
			getSettings: () => ({ autoDrive: true, typing: false, model: "gpt-4o" }),
			onSettingsChanged: () => () => {},
			storage: mockStorage,
			secrets: mockSecrets,
			cwd: process.cwd(),
			log: vi.fn(),
			notify: vi.fn(),
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			onRunEvent: () => () => {},
			onMessage: () => () => {},
			onAttach: () => () => {},
			registerAgentTool: vi.fn(),
			registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
			chat: hostChatSpy,
			abortRun: hostAbortSpy,
			execCommand: hostExecCommandSpy,
			getPluginCommands: hostGetPluginCommandsSpy,
			reload: hostReloadSpy,
		};

		const cleanup = wechatPlugin.activate(host as never);

		try {
			enqueueMsg("/help");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(1));
			const lastHelp = replies[replies.length - 1];
			expect(lastHelp).toContain("可直接发送 /序号（如 /1 或 /2 <提示>）快捷操作：");
			expect(lastHelp).toContain("1/cwd : 查看或切换当前项目根目录");
			expect(lastHelp).toContain("2/new : 清空上下文开启全新会话 [提示]");
			expect(lastHelp).toContain("5/thinking : 设置思考强度");
			expect(lastHelp).toContain("6/plan : 开启或关闭计划模式");
			expect(lastHelp).toContain("11/todo : 加一条待办 <内容>");
			expect(hostChatSpy).not.toHaveBeenCalled();

			enqueueMsg("/h");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(2));
			const hReply = replies[replies.length - 1];
			expect(hReply).toContain("1/cwd : 查看或切换当前项目根目录");
			expect(hReply).toContain("10/help : 显示全部命令 (或发 /)");

			enqueueMsg("/");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(3));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			enqueueMsg("／");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(4));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			enqueueMsg("/?");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(5));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			enqueueMsg("／status");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(6));
			const lastStatus = replies[replies.length - 1];
			expect(lastStatus).toContain("微信通道运行状态");
			expect(lastStatus).toContain("wx_bot_tester");
			expect(lastStatus).toContain("已接收消息：");
			expect(hostChatSpy).not.toHaveBeenCalled();

			enqueueMsg("/cwd");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(7));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			enqueueMsg(`/cwd ${process.cwd()}`);
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(8));
			expect(replies[replies.length - 1]).toContain("已将项目根目录切换为：");

			enqueueMsg("/cwd default");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(9));
			expect(replies[replies.length - 1]).toContain("已恢复跟随全局根目录");

			enqueueMsg("/model");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(10));
			expect(replies[replies.length - 1]).toContain("当前模型：");

			enqueueMsg("/model deepseek/deepseek-chat");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(11));
			expect(replies[replies.length - 1]).toContain("已将模型切换为：deepseek/deepseek-chat");

			enqueueMsg("/clear");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(12));
			expect(replies[replies.length - 1]).toContain("对话上下文已清空，已为您开启全新会话！");

			enqueueMsg("/new 请帮我写一段测试代码");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(13));
			expect(replies[replies.length - 1]).toContain("已为您开启全新会话，正在执行指令…");
			await vi.waitFor(() => expect(hostChatSpy).toHaveBeenCalled());
			const firstChatCall = hostChatSpy.mock.calls[0] as unknown[] | undefined;
			const chatArgs = (firstChatCall?.[0] ?? {}) as { text?: string; model?: string };
			expect(chatArgs.text).toContain("请帮我写一段测试代码");
			expect(chatArgs.model).toBe("deepseek/deepseek-chat");

			enqueueMsg("/stop");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(14));
			expect(replies[replies.length - 1]).toContain("已中止当前正在执行的任务");
			expect(hostAbortSpy).toHaveBeenCalledWith("pr-wechat-stop");

			hostChatSpy.mockClear();
			enqueueMsg("/unknown_magic_cmd 参数测试");
			await vi.waitFor(() => expect(hostChatSpy).toHaveBeenCalled());
			const unknownChatCall = hostChatSpy.mock.calls[0] as unknown[] | undefined;
			const unknownChatArgs = (unknownChatCall?.[0] ?? {}) as { text?: string };
			expect(unknownChatArgs.text).toContain("/unknown_magic_cmd 参数测试");

			enqueueMsg("/1");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(15));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			enqueueMsg("/一");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(16));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			enqueueMsg("/2");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(17));
			expect(replies[replies.length - 1]).toContain("对话上下文已清空，已为您开启全新会话！");

			enqueueMsg("/3");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(18));
			expect(replies[replies.length - 1]).toContain("微信通道运行状态");

			enqueueMsg("/4");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(19));
			expect(replies[replies.length - 1]).toContain("当前模型：");

			enqueueMsg("1/cwd");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(20));
			expect(replies[replies.length - 1]).toContain("当前项目根目录：");

			enqueueMsg("/5 high");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(21));
			expect(replies[replies.length - 1]).toContain("已将思考强度设置为：high");

			enqueueMsg("/6 on");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(22));
			expect(replies[replies.length - 1]).toContain("计划模式已开启");

			enqueueMsg("/9");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(23));
			expect(replies[replies.length - 1]).toContain("已重新加载扩展、技能与提示模板");
			expect(hostReloadSpy).toHaveBeenCalled();

			enqueueMsg("/10");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(24));
			expect(replies[replies.length - 1]).toContain("1/cwd : 查看或切换当前项目根目录");

			enqueueMsg("/todo 买菜 明天18:00");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(25));
			expect(replies[replies.length - 1]).toBe("✅ 已加入待办：买菜 明天18:00");

			enqueueMsg("/11 买水果");
			await vi.waitFor(() => expect(replies.length).toBeGreaterThanOrEqual(26));
			expect(replies[replies.length - 1]).toBe("✅ 已加入待办：买水果");
		} finally {
			cleanup?.();
			globalThis.fetch = origFetch;
		}
	});

	it("配对成功后自动向微信用户发送简洁命令使用指南", async () => {
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "wx_bot_tester", loginAt: Date.now() });
		storageMap.set("allowedPeers", []);
		storageMap.set("pendingPeers", ["new_user_charlie"]);
		storageMap.set("peerCtx", { new_user_charlie: "token_charlie_123" });

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		let messageHandler: ((payload: unknown, from?: string) => void) | undefined;
		interface SendMessagePayload {
			msg?: {
				to_user_id?: string;
				item_list?: Array<{ text_item?: { text: string } }>;
			};
		}
		let pairWelcomePayload: SendMessagePayload | null = null;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				pairWelcomePayload = JSON.parse(String(init?.body ?? "{}"));
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		const host = {
			getSettings: () => ({ autoDrive: true, typing: false }),
			onSettingsChanged: () => () => {},
			storage: mockStorage,
			secrets: mockSecrets,
			cwd: process.cwd(),
			log: vi.fn(),
			notify: vi.fn(),
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			onRunEvent: () => () => {},
			onMessage: (h: (payload: unknown, from?: string) => void) => {
				messageHandler = h;
				return () => {};
			},
			onAttach: () => () => {},
			registerAgentTool: vi.fn(),
			registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
			chat: vi.fn(),
		};

		const cleanup = wechatPlugin.activate(host as never);

		try {
			expect(messageHandler).toBeDefined();
			messageHandler!({ action: "allow", peer: "new_user_charlie" });

			await vi.waitFor(() => {
				expect(pairWelcomePayload).not.toBeNull();
			});

			const sent = pairWelcomePayload as unknown as SendMessagePayload;
			expect(sent?.msg?.to_user_id).toBe("new_user_charlie");
			const text = sent?.msg?.item_list?.[0]?.text_item?.text ?? "";
			expect(text).toContain("🎉 配对成功！");
			expect(text).toContain("1/cwd : 查看或切换当前项目根目录");
			expect(text).toContain("2/new : 清空上下文开启全新会话");
			expect(text).toContain("8/stop : 中止当前正在执行的任务");
			expect(text).toContain("10/help : 显示全部命令 (或发 /)");
		} finally {
			cleanup?.();
			globalThis.fetch = origFetch;
		}
	});

	it("多客户端同名 conversationId 时严格基于 clientId 隔离，绝不串台发送其他会话的消息", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_bob"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const sentMessages: string[] = [];
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_bob",
									context_token: "ctx_bob_1",
									item_list: [{ type: 1, text_item: { text: "你好" } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				const text = body?.msg?.item_list?.[0]?.text_item?.text ?? "";
				sentMessages.push(text);
				return { ok: true, json: async () => ({ ret: 0, message_id: "123456" }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			const targetConvId = "c1";
			const wechatClientId = `plugin:wechat-ilink:${peerAccountId("peer_bob")}`;
			const browserClientId = "client_browser_tab1";

			const hostChatSpy = vi.fn(async (_req: unknown) => {
				return { conversationId: targetConvId, clientId: wechatClientId };
			});

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false, bindActive: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				cwd: process.cwd(),
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);

			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});

			expect(runHandler).toBeDefined();

			runHandler!({
				type: "message",
				conversationId: targetConvId,
				clientId: browserClientId,
				at: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "这是电脑网页端正在处理项目新功能的大段代码与输出..." }],
				},
			});
			runHandler!({
				type: "run_end",
				conversationId: targetConvId,
				clientId: browserClientId,
				at: Date.now(),
			});

			await new Promise((r) => setTimeout(r, 50));
			expect(sentMessages.length).toBe(0);

			runHandler!({
				type: "message",
				conversationId: targetConvId,
				clientId: wechatClientId,
				at: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "你好！我是微信助手，请问有什么可以帮您？" }],
				},
			});
			runHandler!({
				type: "run_end",
				conversationId: targetConvId,
				clientId: wechatClientId,
				at: Date.now(),
			});

			await vi.waitFor(() => {
				expect(sentMessages.length).toBe(1);
			});

			expect(sentMessages[0]).toBe("你好！我是微信助手，请问有什么可以帮您？");
			expect(sentMessages[0]).not.toContain("项目新功能");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("对话被过户到网页端（clientId 变 + 撞 id 改名）后仍按 runId 认领回包", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_dave"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};
		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const sentMessages: string[] = [];
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_dave",
									context_token: "ctx_dave_1",
									item_list: [{ type: 1, text_item: { text: "查一下磁盘占用" } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				sentMessages.push(body?.msg?.item_list?.[0]?.text_item?.text ?? "");
				return { ok: true, json: async () => ({ ret: 0, message_id: "123456" }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			const wechatClientId = `plugin:wechat-ilink:${peerAccountId("peer_dave")}`;
			const browserClientId = "client_browser_tab9";
			const runId = "pr-5f3c1a";

			const hostChatSpy = vi.fn(async (_req: unknown) => {
				return { conversationId: "c1", clientId: wechatClientId, runId };
			});

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false, bindActive: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				cwd: process.cwd(),
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);
			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});
			expect(runHandler).toBeDefined();

			runHandler!({
				type: "turn_end",
				conversationId: "c7",
				clientId: browserClientId,
				runId,
				at: Date.now(),
			});
			runHandler!({
				type: "message",
				conversationId: "c7",
				clientId: browserClientId,
				runId,
				at: Date.now(),
				message: { role: "assistant", content: [{ type: "text", text: "磁盘还剩 42GB。" }] },
			});
			runHandler!({
				type: "run_end",
				conversationId: "c7",
				clientId: browserClientId,
				runId,
				at: Date.now(),
			});

			await vi.waitFor(() => {
				expect(sentMessages.length).toBe(1);
			});
			expect(sentMessages[0]).toBe("磁盘还剩 42GB。");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("bindActive 连发两条指令时只回传末条正文（run_end 只来一次）", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_frank"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};
		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const sentMessages: string[] = [];
		let firstTextEmitted = false;
		let delivered = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				const text = delivered === 0 ? "第一条" : delivered === 1 && firstTextEmitted ? "第二条" : "";
				if (text) {
					delivered++;
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_frank",
									context_token: `ctx_frank_${delivered}`,
									item_list: [{ type: 1, text_item: { text } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 50));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				sentMessages.push(body?.msg?.item_list?.[0]?.text_item?.text ?? "");
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			const browserClientId = "client_browser_tab7";
			let seq = 0;
			const hostChatSpy = vi.fn(async (_req: unknown) => {
				seq++;
				return { conversationId: "c1", clientId: browserClientId, runId: `pr-bind-${seq}` };
			});

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false, bindActive: true }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				cwd: process.cwd(),
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				getActiveConversation: () => ({ conversationId: "c1" }),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);

			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});
			expect(runHandler).toBeDefined();
			runHandler!({
				type: "message",
				conversationId: "c1",
				clientId: browserClientId,
				runId: "pr-bind-1",
				at: Date.now(),
				message: { role: "assistant", content: [{ type: "text", text: "答复第一条" }] },
			});
			firstTextEmitted = true;

			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(2);
			});
			runHandler!({
				type: "message",
				conversationId: "c1",
				clientId: browserClientId,
				runId: "pr-bind-2",
				at: Date.now(),
				message: { role: "assistant", content: [{ type: "text", text: "答复第二条" }] },
			});
			runHandler!({
				type: "run_end",
				conversationId: "c1",
				clientId: browserClientId,
				runId: "pr-bind-2",
				at: Date.now(),
			});

			await vi.waitFor(() => {
				expect(sentMessages.length).toBe(1);
			});
			expect(sentMessages[0]).not.toContain("答复第一条");
			expect(sentMessages[0]).toContain("答复第二条");

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("runId 不同则不认领（不会把别处的运行回合错发给微信）", async () => {
		let runHandler: ((ev: unknown) => void) | undefined;
		const storageMap = new Map<string, unknown>();
		storageMap.set("account", { base: "https://ilinkai.weixin.qq.com", botId: "bot1", loginAt: Date.now() });
		storageMap.set("allowedPeers", ["peer_erin"]);

		const mockSecrets = {
			get: vi.fn((k) => (k === "bot_token" ? "fake_token" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};
		const mockStorage = {
			get: vi.fn((k, def) => (storageMap.has(k) ? storageMap.get(k) : def)),
			set: vi.fn((k, v) => storageMap.set(k, v)),
		};

		const sentMessages: string[] = [];
		let pollCount = 0;

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				pollCount++;
				if (pollCount === 1) {
					return {
						ok: true,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "peer_erin",
									context_token: "ctx_erin_1",
									item_list: [{ type: 1, text_item: { text: "在吗" } }],
								},
							],
						}),
					} as Response;
				}
				await new Promise((r) => setTimeout(r, 5000));
				return { ok: true, json: async () => ({ ret: 0, msgs: [] }) } as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				sentMessages.push(body?.msg?.item_list?.[0]?.text_item?.text ?? "");
				return { ok: true, json: async () => ({ ret: 0 }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		try {
			const wechatClientId = `plugin:wechat-ilink:${peerAccountId("peer_erin")}`;
			const hostChatSpy = vi.fn(async (_req: unknown) => {
				return { conversationId: "c1", clientId: wechatClientId, runId: "pr-mine" };
			});

			const host = {
				getSettings: () => ({ autoDrive: true, typing: false, bindActive: false }),
				onSettingsChanged: () => () => {},
				storage: mockStorage,
				secrets: mockSecrets,
				cwd: process.cwd(),
				log: vi.fn(),
				notify: vi.fn(),
				broadcast: vi.fn(),
				sendTo: vi.fn(),
				onRunEvent: (h: (ev: unknown) => void) => {
					runHandler = h;
					return () => {};
				},
				onMessage: () => () => {},
				onAttach: () => () => {},
				registerAgentTool: vi.fn(),
				registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
				chat: hostChatSpy,
			};

			const cleanup = wechatPlugin.activate(host as never);
			await vi.waitFor(() => {
				expect(hostChatSpy).toHaveBeenCalledTimes(1);
			});
			expect(runHandler).toBeDefined();

			runHandler!({
				type: "message",
				conversationId: "c1",
				clientId: wechatClientId,
				runId: "pr-someone-else",
				at: Date.now(),
				message: { role: "assistant", content: [{ type: "text", text: "不该发给微信的内容" }] },
			});
			runHandler!({
				type: "run_end",
				conversationId: "c1",
				clientId: wechatClientId,
				runId: "pr-someone-else",
				at: Date.now(),
			});
			await new Promise((r) => setTimeout(r, 50));
			expect(sentMessages.length).toBe(0);

			cleanup?.();
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});

describe("wechat-ilink: 回执与入站边界行为", () => {
	async function runInbound(
		messages: Record<string, unknown>[],
		chatImpl?: (req: any, emit: (ev: any) => void) => any,
		options: { bindActive?: boolean; storage?: Map<string, unknown> } = {},
	) {
		const replies: string[] = [];
		let emit = (_ev: any) => {};
		let polled = false;
		let deliver: ((messages: Record<string, unknown>[]) => void) | undefined;
		const storage = options.storage ?? new Map<string, unknown>();
		const original = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
			if (String(url).includes("getupdates")) {
				if (!polled) {
					polled = true;
					return { ok: true, json: async () => ({ ret: 0, msgs: messages }) } as Response;
				}
				const next = await new Promise<Record<string, unknown>[]>((resolve) => {
					deliver = resolve;
					init?.signal?.addEventListener("abort", () => resolve([]), { once: true });
				});
				return { ok: true, json: async () => ({ ret: 0, msgs: next }) } as Response;
			}
			if (String(url).includes("sendmessage"))
				replies.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item?.text ?? "");
			return { ok: true, json: async () => ({ ret: 0 }) } as Response;
		});
		const chat = vi.fn(async (req: any) =>
			chatImpl ? chatImpl(req, emit) : { conversationId: "real-conv", clientId: "real-client", runId: "pr-stable-run" },
		);
		const abortRun = vi.fn(async (_id: string) => ({ ok: true }));
		const host = {
			getSettings: () => ({
				autoDrive: true,
				typing: false,
				allowFrom: "*",
				respondGroups: true,
				bindActive: options.bindActive,
			}),
			getActiveConversation: () => ({ conversationId: "web-current" }),
			onSettingsChanged: () => () => {},
			storage: {
				get: (k: string, d: unknown) => (storage.has(k) ? storage.get(k) : d),
				set: (k: string, v: unknown) => storage.set(k, v),
			},
			secrets: { get: () => "token", set: vi.fn(), delete: vi.fn() },
			cwd: process.cwd(),
			log: vi.fn(),
			notify: vi.fn(),
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			onRunEvent: (fn: typeof emit) => {
				emit = fn;
				return () => {};
			},
			onMessage: () => () => {},
			onAttach: () => () => {},
			registerAgentTool: vi.fn(),
			registerBackgroundTask: () => ({ update: vi.fn(), unregister: vi.fn() }),
			chat,
			abortRun,
		};
		const cleanup = wechatPlugin.activate(host as never);
		return {
			chat,
			abortRun,
			replies,
			storage,
			enqueue: async (next: Record<string, unknown>[]) => {
				await vi.waitFor(() => expect(deliver).toBeDefined());
				const receive = deliver!;
				deliver = undefined;
				receive(next);
			},
			emit: (ev: any) => emit(ev),
			close: () => {
				cleanup?.();
				globalThis.fetch = original;
			},
		};
	}
	it("网页续聊跨 owner 迁移后依 sessionId 回传，重复结束只发送一次", async () => {
		const h = await runInbound([msg({ context_token: "ctx-a" })], () => ({
			conversationId: "c1",
			clientId: "wx-owner",
			sessionId: "sdk-a",
			runId: "wx-run",
		}));
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledOnce());
			await Promise.resolve();
			h.emit({ type: "run_end", runId: "wx-run", sessionId: "sdk-a", clientId: "wx-owner", conversationId: "c1" });
			await vi.waitFor(() => expect(h.replies).toHaveLength(1));
			const ev = { sessionId: "sdk-a", clientId: "web-owner", conversationId: "c7" };
			h.emit({ ...ev, type: "run_start" });
			h.emit({
				...ev,
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "网页继续的回答" }] },
			});
			h.emit({ ...ev, type: "run_end" });
			h.emit({ ...ev, type: "run_end" });
			await vi.waitFor(() => expect(h.replies).toHaveLength(2));
			expect(h.replies[1]).toBe("网页继续的回答");
		} finally {
			h.close();
		}
	});
	it("旧宿主只按完整 owner 匹配，禁止纯 c1 或不同 session 认领", async () => {
		const h = await runInbound([msg()], () => ({ conversationId: "c1", clientId: "owner", runId: "first" }));
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledOnce());
			await Promise.resolve();
			h.emit({ type: "run_end", runId: "first", clientId: "owner", conversationId: "c1" });
			await vi.waitFor(() => expect(h.replies).toHaveLength(1));
			for (const ev of [
				{ conversationId: "c1" },
				{ clientId: "other", conversationId: "c1" },
				{ clientId: "owner", conversationId: "c1", sessionId: "unknown" },
			])
				h.emit({ ...ev, type: "run_end", runId: "foreign" });
			expect(h.replies).toHaveLength(1);
			h.emit({ type: "run_start", clientId: "owner", conversationId: "c1" });
			h.emit({ type: "run_end", clientId: "owner", conversationId: "c1" });
			await vi.waitFor(() => expect(h.replies).toHaveLength(2));
		} finally {
			h.close();
		}
	});
	it("/new 使旧 session 路由失效，dispose 后迟到事件无副作用", async () => {
		const h = await runInbound([msg()], () => ({
			conversationId: "c1",
			clientId: "owner",
			sessionId: "sdk-old",
			runId: "first",
		}));
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledOnce());
			await Promise.resolve();
			h.emit({ type: "run_end", runId: "first" });
			await h.enqueue([msg({ item_list: [{ type: 1, text_item: { text: "/new" } }] })]);
			await vi.waitFor(() => expect(h.storage.get("peerSessionSeq")).toEqual({ "same-user": 1 }));
			const count = h.replies.length;
			h.emit({ type: "run_end", sessionId: "sdk-old", clientId: "owner", conversationId: "c1", runId: "late" });
			expect(h.replies).toHaveLength(count);
			h.close();
			h.emit({ type: "run_end", sessionId: "sdk-old", runId: "disposed" });
			expect(h.replies).toHaveLength(count);
		} finally {
			h.close();
		}
	});
	it.each([false, true])("工具前言不作为最终正文（有 final=%s）", async (hasFinal) => {
		const h = await runInbound([msg()], (_req, emit) => {
			const ev = { runId: "early-final", clientId: "owner", conversationId: "c1", sessionId: "sdk-final" };
			emit({
				...ev,
				type: "message",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "text", text: "工具前言" },
						{ type: "toolCall", name: "read" },
					],
				},
			});
			if (hasFinal)
				emit({ ...ev, type: "message", message: { role: "assistant", content: [{ type: "text", text: "最终回答" }] } });
			emit({ ...ev, type: "run_end" });
			return ev;
		});
		try {
			await vi.waitFor(() => expect(h.replies).toHaveLength(1));
			expect(h.replies[0]).toBe(hasFinal ? "最终回答" : "任务完成（无文本输出）。");
		} finally {
			h.close();
		}
	});
	it("bindActive 多 peer 共用会话后网页轮次不猜收件人", async () => {
		let calls = 0;
		const h = await runInbound(
			[msg(), msg({ from_user_id: "other-user" })],
			() => ({
				conversationId: "shared",
				clientId: "web",
				sessionId: "sdk-shared",
				runId: `wx-${++calls}`,
			}),
			{ bindActive: true },
		);
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledTimes(2));
			await Promise.resolve();
			h.emit({ type: "run_end", runId: "wx-2", sessionId: "sdk-shared" });
			const count = h.replies.length;
			const ev = { sessionId: "sdk-shared", clientId: "web", conversationId: "shared" };
			h.emit({ ...ev, type: "run_start" });
			h.emit({ ...ev, type: "run_end" });
			expect(h.replies).toHaveLength(count);
		} finally {
			h.close();
		}
	});
	it("已有精确插件 account 会话可在 reload 后恢复网页回复路由", async () => {
		const storage = new Map<string, unknown>([
			["peerCtx", { "same-user": "ctx-old" }],
			["allowedPeers", ["same-user"]],
		]);
		const h = await runInbound([], undefined, { storage });
		try {
			const ev = {
				sessionId: "existing-sdk",
				clientId: `plugin:wechat-ilink:${peerAccountId("same-user")}`,
				conversationId: "c1",
			};
			h.emit({ ...ev, type: "run_start" });
			h.emit({ ...ev, type: "message", message: { role: "assistant", content: [{ type: "text", text: "已有会话" }] } });
			h.emit({ ...ev, type: "run_end" });
			await vi.waitFor(() => expect(h.replies).toEqual(["已有会话"]));
			expect(storage.get("sessionRoutes")).toEqual(
				expect.arrayContaining([
					["session:existing-sdk", expect.objectContaining({ to: "same-user", ctx: "ctx-old" })],
				]),
			);
		} finally {
			h.close();
		}
	});
	const msg = (extra = {}) => ({
		message_type: 1,
		from_user_id: "same-user",
		item_list: [{ type: 1, text_item: { text: "你好" } }],
		...extra,
	});
	it.each(["/stop", "/abort", "/8", "／ABORT", "/new", "/clear", "/reset", "/2", "2/new", "/2/new", "／NEW"])(
		"%s 中止优先回执中的稳定 runId",
		async (command) => {
			const h = await runInbound([msg(), msg({ item_list: [{ type: 1, text_item: { text: command } }] })]);
			try {
				await vi.waitFor(() => expect(h.abortRun).toHaveBeenCalledWith("pr-stable-run"));
				expect(h.abortRun).not.toHaveBeenCalledWith("real-conv");
			} finally {
				h.close();
			}
		},
	);
	it.each([
		"/new",
		"/clear",
		"/reset",
		"/2",
		"2/new",
		"/2/new",
		"／NEW",
		`/cwd ${process.cwd()}`,
		`/workspace ${process.cwd()}`,
		`/1 ${process.cwd()}`,
		"/cwd default",
		"/model provider/test",
		"/model default",
		"/4 provider/test",
		"/thinking high",
		"/thinking default",
		"/5 high",
	])("%s 后不再投递回旧网页会话，且只影响当前微信用户", async (command) => {
		const h = await runInbound(
			[
				msg(),
				msg({ item_list: [{ type: 1, text_item: { text: command } }] }),
				msg(),
				msg(),
				msg({ from_user_id: "other-user" }),
			],
			undefined,
			{ bindActive: true },
		);
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledTimes(4));
			const requests = h.chat.mock.calls.map(([req]) => req);
			expect(requests[0].conversationId).toBe("web-current");
			expect(requests[1].conversationId).toBeUndefined();
			expect(requests[2].conversationId).toBeUndefined();
			expect(requests[1].accountId).not.toBe(requests[0].accountId);
			expect(requests[2].accountId).toBe(requests[1].accountId);
			expect(requests[3].conversationId).toBe("web-current");
		} finally {
			h.close();
		}
	});
	it.each(["/new", "/reset", "/8", "/model default", "/thinking high"])(
		"%s 后迟到的媒体运行回执不会认领旧会话",
		async (command) => {
			let complete!: (receipt: any) => void;
			const h = await runInbound(
				[msg({ item_list: [{ type: 3, voice_item: {} }] })],
				() =>
					new Promise((resolve) => {
						complete = resolve;
					}),
			);
			try {
				await vi.waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
				await h.enqueue([msg({ item_list: [{ type: 1, text_item: { text: command } }] })]);
				await vi.waitFor(() => expect(h.replies.length).toBe(2));
				complete({ conversationId: "stale-conv", runId: "stale-run" });
				await vi.waitFor(() => expect(h.abortRun).toHaveBeenCalledWith("stale-run"));
				h.emit({
					type: "message",
					conversationId: "stale-conv",
					runId: "stale-run",
					message: { role: "assistant", content: "旧结果" },
				});
				h.emit({ type: "run_end", conversationId: "stale-conv", runId: "stale-run" });
				expect(h.replies.join("\n")).not.toContain("旧结果");
			} finally {
				h.close();
			}
		},
	);
	it.each(["rejected", "throw"])("重置后迟到回执无法中止时明确告知用户：%s", async (failure) => {
		let complete!: (receipt: any) => void;
		const h = await runInbound(
			[msg({ item_list: [{ type: 3, voice_item: {} }] })],
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
			h.abortRun.mockImplementation(async () => {
				if (failure === "throw") throw new Error("abort failed");
				return { ok: false };
			});
			await h.enqueue([msg({ item_list: [{ type: 1, text_item: { text: "/reset" } }] })]);
			await vi.waitFor(() => expect(h.replies.length).toBe(2));
			complete({ conversationId: "stale-conv", runId: "stale-run" });
			await vi.waitFor(() => expect(h.replies.join("\n")).toContain("旧任务未能确认停止"));
		} finally {
			h.close();
		}
	});
	it("/new 带提示直接投递到全新会话，重载插件后保持独立模式", async () => {
		const h = await runInbound([msg({ item_list: [{ type: 1, text_item: { text: "/new 新任务" } }] })], undefined, {
			bindActive: true,
		});
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
			expect(h.chat.mock.calls[0]![0].conversationId).toBeUndefined();
			expect(h.chat.mock.calls[0]![0].text).toContain("新任务");
		} finally {
			h.close();
		}
		const reloaded = await runInbound([msg()], undefined, { bindActive: true, storage: h.storage });
		try {
			await vi.waitFor(() => expect(reloaded.chat).toHaveBeenCalledTimes(1));
			expect(reloaded.chat.mock.calls[0]![0].conversationId).toBeUndefined();
			expect(reloaded.chat.mock.calls[0]![0].accountId).toBe(h.chat.mock.calls[0]![0].accountId);
		} finally {
			reloaded.close();
		}
	});
	it.each(["/new", "/clear", `/cwd ${process.cwd()}`])("%s 后下一次 host.chat 使用独立 accountId", async (command) => {
		const h = await runInbound([msg(), msg({ item_list: [{ type: 1, text_item: { text: command } }] }), msg()]);
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledTimes(2));
			expect(h.chat.mock.calls[0]![0].accountId).not.toBe(h.chat.mock.calls[1]![0].accountId);
		} finally {
			h.close();
		}
	});
	it("媒体下载未完成时 /stop 立即响应，下载完成也不再发起运行", async () => {
		const original = globalThis.fetch;
		const h = await runInbound([
			msg({ item_list: [{ type: 2, image_item: { media: { full_url: "https://slow-media.test/image" } } }] }),
			msg({ item_list: [{ type: 1, text_item: { text: "/stop" } }] }),
		]);
		const network = globalThis.fetch;
		let finish: ((response: Response) => void) | undefined;
		globalThis.fetch = vi.fn((url: any, init?: RequestInit) =>
			String(url).startsWith("https://slow-media.test")
				? new Promise<Response>((r) => {
						finish = r;
					})
				: network(url, init),
		);
		try {
			await vi.waitFor(() => expect(h.replies).toContain("当前没有正在执行的任务。"));
			expect(h.chat).not.toHaveBeenCalled();
			finish?.({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response);
			await new Promise((r) => setTimeout(r, 20));
			expect(h.chat).not.toHaveBeenCalled();
		} finally {
			h.close();
			globalThis.fetch = original;
		}
	});
	it("仅私聊：同用户群/thread 不创建运行且不污染私聊", async () => {
		const h = await runInbound([msg({ group_id: "g1" }), msg({ group_id: "g2" }), msg({ thread_id: "t1" }), msg()]);
		try {
			await vi.waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
			expect(h.chat.mock.calls[0]![0].accountId).toBe(peerAccountId("same-user"));
		} finally {
			h.close();
		}
	});
	it("回执前完成的稳定 runId 事件在真实会话回执后只回复一次", async () => {
		const h = await runInbound([msg()], (req, emit) => {
			const ev = { conversationId: "real-conv", clientId: `plugin:wechat-ilink:${req.accountId}`, runId: "stable-run" };
			emit({
				...ev,
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "早到的真实结果" }] },
			});
			emit({ ...ev, type: "run_end" });
			return { conversationId: "real-conv", clientId: ev.clientId, runId: "stable-run" };
		});
		try {
			await vi.waitFor(() => expect(h.replies).toEqual(["早到的真实结果"]));
		} finally {
			h.close();
		}
	});
	it("宿主拒绝不静默成功，语音无 ASR 直接诚实告知", async () => {
		const h = await runInbound([msg({ item_list: [{ type: 3, voice_item: {} }] })], () => ({
			ok: false,
			error: "attachment unsupported",
		}));
		try {
			await vi.waitFor(() => expect(h.replies.some((t) => t.includes("执行失败：attachment unsupported"))).toBe(true));
			expect(h.replies.some((t) => t.includes("未接入语音识别（ASR）"))).toBe(true);
			expect(h.chat.mock.calls[0]![0].text).toContain("无法听取内容");
		} finally {
			h.close();
		}
	});
});

describe("wechat-ilink: 媒体收发纯函数", () => {
	it("aesEcbPaddedSize 按 PKCS#7 向上对齐（含整块多一个字节）", () => {
		expect(aesEcbPaddedSize(0)).toBe(16);
		expect(aesEcbPaddedSize(1)).toBe(16);
		expect(aesEcbPaddedSize(15)).toBe(16);
		expect(aesEcbPaddedSize(16)).toBe(32);
		expect(aesEcbPaddedSize(1000)).toBe(1008);
	});

	it("AES-128-ECB 加解密可往返（密文长度 = 填充后长度）", () => {
		const key = randomBytes(16);
		const plain = Buffer.from("pi-web-ui 微信通道图片载荷", "utf8");
		const cipher = encryptAesEcb(plain, key);
		expect(cipher.length).toBe(aesEcbPaddedSize(plain.length));
		expect(decryptAesEcb(cipher, key).equals(plain)).toBe(true);
	});

	it("parseAesKey 兼容 hex 裸串 / base64(16 字节) / base64(hex 串) / 非法输入", () => {
		const key = randomBytes(16);
		const hex = key.toString("hex");
		expect(parseAesKey(hex)?.equals(key)).toBe(true);
		expect(parseAesKey(key.toString("base64"))?.equals(key)).toBe(true);
		expect(parseAesKey(Buffer.from(hex).toString("base64"))?.equals(key)).toBe(true);
		expect(parseAesKey("")).toBeNull();
		expect(parseAesKey("!!!")).toBeNull();
	});

	it("buildMediaRef / buildImageItem 与协议口径一致", () => {
		const hex = "00112233445566778899aabbccddeeff";
		const ref = buildMediaRef({ downloadParam: "dp-1", aeskeyHex: hex });
		expect(ref.encrypt_query_param).toBe("dp-1");
		expect(ref.aes_key).toBe(Buffer.from(hex).toString("base64"));
		expect(ref.encrypt_type).toBe(1);

		const item = buildImageItem({ downloadParam: "dp-2", aeskeyHex: hex, cipherSize: 2048 });
		expect(item.type).toBe(2);
		expect(item.image_item.media.encrypt_query_param).toBe("dp-2");
		expect(item.image_item.mid_size).toBe(2048);
	});

	it("buildFileItem 的 len 是明文字节数的十进制字符串", () => {
		const item = buildFileItem({ downloadParam: "dp", aeskeyHex: "00", fileName: "报告.pdf", rawSize: 12345 });
		expect(item.type).toBe(4);
		expect(item.file_item.len).toBe("12345");
		expect(item.file_item.file_name).toBe("报告.pdf");
	});

	it("buildMediaItem 按 kind 分流到 image/video/file", () => {
		const base = { downloadParam: "dp", aeskeyHex: "00", cipherSize: 16, fileName: "a.bin", rawSize: 3 };
		expect(buildMediaItem({ ...base, kind: "image" }).type).toBe(2);
		expect(buildMediaItem({ ...base, kind: "video" }).type).toBe(5);
		expect(buildMediaItem({ ...base, kind: "file" }).type).toBe(4);
	});

	it("CDN URL 拼接与 MIME / 扩展名分流", () => {
		expect(buildCdnUploadUrl({ cdnBase: "https://cdn.example/c2c/", uploadParam: "a b", filekey: "k1" })).toBe(
			"https://cdn.example/c2c/upload?encrypted_query_param=a%20b&filekey=k1",
		);
		expect(buildCdnDownloadUrl({ cdnBase: "https://cdn.example/c2c", encryptQueryParam: "x y" })).toBe(
			"https://cdn.example/c2c/download?encrypted_query_param=x%20y",
		);
		expect(mimeOfPath("/tmp/a.JPG")).toBe("image/jpeg");
		expect(mediaKindOfMime("image/jpeg")).toBe("image");
		expect(mediaKindOfMime("video/mp4")).toBe("video");
		expect(mediaKindOfMime("application/pdf")).toBe("file");
	});

	it("sniffImageExt 只认魔数，认不出回空串", () => {
		expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(".jpg");
		expect(sniffImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(".png");
		expect(sniffImageExt(Buffer.from("GIF89a"))).toBe(".gif");
		expect(sniffImageExt(Buffer.from("hello"))).toBe("");
	});

	it("inboundPartsOf 按 type 字段识别媒体，文本不被 JSON 嗅探误判", () => {
		const parts = inboundPartsOf([
			{ type: 1, text_item: { text: "看这张 image 图" } },
			{ type: 2, image_item: {} },
			{ image_item: { media: {} } },
			{ type: 4, file_item: { file_name: "a.pdf" } },
			{ type: 5, video_item: {} },
			{ type: 3, voice_item: {} },
			{ type: 99 },
		]);
		expect(parts.map((p) => p.kind)).toEqual(["text", "image", "image", "file", "video", "voice", "unknown"]);
		expect(inboundTextOf([{ type: 2 }, { type: 4 }])).toBe("[图片]\n[文件]");
		expect(inboundMediaKind({ type: 5 })).toBe("video");
		expect(inboundMediaKind({ file_item: {} })).toBe("file");
	});
});

describe("wechat-ilink: 媒体双向链路（CDN 上传/下载）", () => {
	it("出站发图：getuploadurl → AES 加密上传 → image_item；入站图片解密落地供 agent 读取", async () => {
		const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const workdir = mkdtempSync(join(tmpdir(), "wx-media-"));

		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		const imgPath = join(workdir, "cat.png");
		writeFileSync(imgPath, png);

		const inboundKey = randomBytes(16);
		const inboundCipher = encryptAesEcb(png, inboundKey);

		const storageMap = new Map<string, unknown>();
		const mockStorage = {
			get: vi.fn((k: string, d: unknown) => (storageMap.has(k) ? storageMap.get(k) : d)),
			set: vi.fn((k: string, v: unknown) => storageMap.set(k, v)),
		};
		const mockSecrets = {
			get: vi.fn((k: string) => (k === "bot_token" ? "fake_token_media" : undefined)),
			set: vi.fn(),
			delete: vi.fn(),
		};

		const uploadCalls: Array<{ url: string; body: unknown; raw: Buffer }> = [];
		const sendMessageItems: unknown[] = [];
		const chatPrompts: string[] = [];
		const registeredTools: Array<{ execute: (id: string, p: Record<string, unknown>) => Promise<string> }> = [];
		const inboundQueue: Array<Record<string, unknown>> = [];
		const ctl = { wake: null as (() => void) | null };

		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("getupdates")) {
				if (!inboundQueue.length) {
					await new Promise<void>((r) => {
						ctl.wake = r;
						setTimeout(r, 1500);
					});
				}
				const msgs = inboundQueue.splice(0, inboundQueue.length);
				return { ok: true, json: async () => ({ ret: 0, msgs }) } as Response;
			}
			if (urlStr.includes("getuploadurl")) {
				return {
					ok: true,
					json: async () => ({ upload_full_url: "https://cdn.test/upload/full" }),
				} as Response;
			}
			if (urlStr === "https://cdn.test/upload/full") {
				const raw = Buffer.from((init?.body as Uint8Array) ?? new Uint8Array());
				uploadCalls.push({ url: urlStr, body: init?.body, raw });
				return {
					status: 200,
					ok: true,
					headers: new Headers({ "x-encrypted-param": "dp-out-1" }),
					text: async () => "",
				} as unknown as Response;
			}
			if (urlStr.startsWith("https://cdn.test/download")) {
				return {
					ok: true,
					arrayBuffer: async () =>
						inboundCipher.buffer.slice(inboundCipher.byteOffset, inboundCipher.byteOffset + inboundCipher.byteLength),
				} as unknown as Response;
			}
			if (urlStr.includes("sendmessage")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				sendMessageItems.push(body?.msg?.item_list?.[0]);
				return { ok: true, json: async () => ({ ret: 0, message_id: "m1" }) } as Response;
			}
			return { ok: true, json: async () => ({}) } as Response;
		});

		const host = {
			getSettings: () => ({ autoDrive: true, typing: false, allowFrom: "*", workspace: workdir }),
			onSettingsChanged: () => () => {},
			storage: mockStorage,
			secrets: mockSecrets,
			cwd: workdir,
			log: vi.fn(),
			notify: vi.fn(),
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			onRunEvent: () => () => {},
			onMessage: () => () => {},
			onAttach: () => () => {},
			registerAgentTool: vi.fn((tool: never) => {
				registeredTools.push(
					tool as unknown as { execute: (id: string, p: Record<string, unknown>) => Promise<string> },
				);
				return () => {};
			}),
			registerBackgroundTask: vi.fn(() => ({ update: vi.fn(), unregister: vi.fn() })),
			chat: vi.fn(async (req: { text: string }) => {
				chatPrompts.push(req.text);
				return { conversationId: "conv_media_1", clientId: "client_media_1" };
			}),
		};

		const cleanup = wechatPlugin.activate(host as never);
		try {
			await vi.waitFor(() => expect(registeredTools.length).toBeGreaterThan(0));

			const res = await registeredTools[0]!.execute("t1", { to: "peer_zed", text: "看猫", image: imgPath });
			expect(res).toContain("已发送给 peer_zed");

			expect(uploadCalls.length).toBe(1);
			expect(uploadCalls[0]!.raw.length).toBe(aesEcbPaddedSize(png.length));
			expect(uploadCalls[0]!.raw.equals(png)).toBe(false);

			const items = sendMessageItems.filter(Boolean) as Array<Record<string, never>>;
			const imageItem = items.find((it: Record<string, unknown>) => it.type === 2) as
				{ image_item: { media: { encrypt_query_param: string; aes_key: string }; mid_size: number } } | undefined;
			expect(imageItem).toBeTruthy();
			expect(imageItem!.image_item.media.encrypt_query_param).toBe("dp-out-1");
			const decodedKey = Buffer.from(imageItem!.image_item.media.aes_key, "base64").toString("latin1");
			expect(decodedKey).toMatch(/^[0-9a-f]{32}$/);
			expect(decryptAesEcb(uploadCalls[0]!.raw, Buffer.from(decodedKey, "hex")).equals(png)).toBe(true);
			expect(imageItem!.image_item.mid_size).toBe(aesEcbPaddedSize(png.length));

			inboundQueue.push({
				message_type: 1,
				from_user_id: "peer_zed",
				item_list: [
					{
						type: 2,
						image_item: {
							media: { full_url: "https://cdn.test/download?x=1", aes_key: inboundKey.toString("base64") },
							aeskey: inboundKey.toString("hex"),
						},
					},
				],
			});
			ctl.wake?.();
			await vi.waitFor(() => expect(chatPrompts.length).toBe(1));

			const prompt = chatPrompts[0]!;
			expect(prompt).toContain("图片已保存");
			const savedPath = /图片已保存：(.+?)（/.exec(prompt)?.[1] ?? "";
			expect(savedPath).toContain(".pi-wechat-media");
			expect(existsSync(savedPath)).toBe(true);
			expect(readFileSync(savedPath).equals(png)).toBe(true);
			expect(host.chat).toHaveBeenLastCalledWith(
				expect.objectContaining({
					attachments: [
						expect.objectContaining({ path: "", imageData: png.toString("base64"), mimeType: "image/png" }),
					],
				}),
			);
			for (const [type, kind] of [
				[4, "file"],
				[5, "video"],
			] as const) {
				inboundQueue.push({
					message_type: 1,
					from_user_id: "peer_zed",
					item_list: [
						{
							type,
							[`${kind}_item`]: {
								file_name: "clip.mp4",
								media: { full_url: "https://cdn.test/download?x=1", aes_key: inboundKey.toString("base64") },
							},
						},
					],
				});
				ctl.wake?.();
				await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(type === 4 ? 2 : 3));
				expect(host.chat).toHaveBeenLastCalledWith(
					expect.objectContaining({
						attachments: [
							expect.objectContaining({
								mode: "reference",
								name: expect.any(String),
								path: expect.stringContaining(".pi-wechat-media"),
							}),
						],
					}),
				);
			}
		} finally {
			cleanup?.();
			globalThis.fetch = origFetch;
		}
	});
});
