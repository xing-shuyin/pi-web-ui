import { describe, expect, it, vi } from "vitest";
import approvalGatePlugin from "../../plugins/approval-gate/index.mjs";
import { isLoopbackHost } from "../../server/host-guard.js";
import { ClientSession } from "../../server/agent-service.js";

describe("审批归属、部署姿态与拍板插件安全加固 (Issue #723)", () => {
	describe("1. 部署姿态：非回环主机判定 (host-guard)", () => {
		it("正确识别回环地址", () => {
			expect(isLoopbackHost("127.0.0.1")).toBe(true);
			expect(isLoopbackHost("127.0.0.2")).toBe(true);
			expect(isLoopbackHost("localhost")).toBe(true);
			expect(isLoopbackHost("my.localhost")).toBe(true);
			expect(isLoopbackHost("::1")).toBe(true);
			expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
		});

		it("正确识别非回环地址（需要告警或 token 保护）", () => {
			expect(isLoopbackHost("0.0.0.0")).toBe(false);
			expect(isLoopbackHost("::")).toBe(false);
			expect(isLoopbackHost("192.168.1.100")).toBe(false);
			expect(isLoopbackHost("10.0.0.5")).toBe(false);
			expect(isLoopbackHost("example.com")).toBe(false);
		});
	});

	describe("2. approval-gate 插件：会话标识符校验与存在性检查", () => {
		function createMockHost(mockConversations: Array<{ id: string; title: string }> = []) {
			const routes = new Map<string, Function>();
			const storage = new Map<string, unknown>();

			return {
				log: vi.fn(),
				broadcast: vi.fn(),
				onClientMessage: vi.fn(() => vi.fn()),
				storage: {
					get: (k: string) => storage.get(k),
					set: (k: string, v: unknown) => storage.set(k, v),
				},
				conversations: {
					list: vi.fn(async () => mockConversations),
					get: vi.fn((id: string) => mockConversations.find((c) => c.id === id) || null),
				},
				route: (method: string, path: string, handler: Function) => {
					routes.set(`${method} ${path}`, handler);
					return () => routes.delete(`${method} ${path}`);
				},
				_invoke: async (method: string, path: string, body?: unknown) => {
					const fn = routes.get(`${method} ${path}`);
					if (!fn) throw new Error(`Route not found: ${method} ${path}`);
					let statusCode = 200;
					let jsonResult: any = null;
					const req = { body };
					const res = {
						status: (code: number) => {
							statusCode = code;
							return res;
						},
						json: (data: any) => {
							jsonResult = data;
							return res;
						},
					};
					await fn(req, res);
					return { status: statusCode, body: jsonResult };
				},
			};
		}

		it("拒绝包含路径穿越符 '..' 或危险字符的 conversationId", async () => {
			const host = createMockHost([{ id: "c1", title: "Valid Conv" }]);
			approvalGatePlugin.activate(host);

			const registerRes = await host._invoke("POST", "/register", {
				task: "test-task",
				title: "test-title",
				conversationId: "../../etc/shadow",
			});
			expect(registerRes.status).toBe(404);
			expect(registerRes.body.ok).toBe(false);

			// 尝试更新已存在的项
			const validRegister = await host._invoke("POST", "/register", {
				task: "test-task-2",
				title: "test-title-2",
			});
			expect(validRegister.status).toBe(200);
			const itemId = validRegister.body.item.id;

			const updateRes = await host._invoke("POST", "/update", {
				id: itemId,
				conversationId: "../../../etc/passwd",
			});
			expect(updateRes.status).toBe(404);
			expect(updateRes.body.ok).toBe(false);
		});

		it("当宿主存在会话列表时，拒绝不存在的 conversationId", async () => {
			const host = createMockHost([
				{ id: "c1", title: "Main Chat" },
				{ id: "/path/to/sessions/2026-10-24_session-abc.jsonl", title: "History Session" },
			]);
			approvalGatePlugin.activate(host);

			const res = await host._invoke("POST", "/register", {
				task: "test-task",
				title: "test-title",
				conversationId: "non-existent-conv",
			});
			expect(res.status).toBe(404);
			expect(res.body.ok).toBe(false);
			expect(res.body.error).toContain("未找到关联会话");
		});

		it("接受宿主列表中匹配的活跃会话或历史会话路径/UUID", async () => {
			const host = createMockHost([
				{ id: "c1", title: "Main Chat" },
				{ id: "/path/to/sessions/2026-10-24_uuid-998877.jsonl", title: "History Session" },
			]);
			approvalGatePlugin.activate(host);

			// 匹配 c1
			const res1 = await host._invoke("POST", "/register", {
				task: "task-1",
				title: "title-1",
				conversationId: "c1",
			});
			expect(res1.status).toBe(200);
			expect(res1.body.item.conversationId).toBe("c1");

			// 子串匹配 session uuid
			const res2 = await host._invoke("POST", "/update", {
				id: res1.body.item.id,
				conversationId: "uuid-998877",
			});
			expect(res2.status).toBe(200);
			expect(res2.body.item.conversationId).toBe("uuid-998877");
		});

		it("宿主会话列表为空（如无活跃客户端连接的 Cron/CLI 场景）时宽容降级", async () => {
			const host = createMockHost([]); // 空列表
			approvalGatePlugin.activate(host);

			const res = await host._invoke("POST", "/register", {
				task: "cron-task",
				title: "cron-title",
				conversationId: "session-new-from-cron",
			});
			expect(res.status).toBe(200);
			expect(res.body.item.conversationId).toBe("session-new-from-cron");
		});
	});

	describe("3. 审批答复与策略归属安全 (ClientSession 审批归属门禁)", () => {
		function createFakeClientSession() {
			const cs = Object.create(ClientSession.prototype) as any;
			cs.convs = new Map();
			cs.activeId = "conv-main";
			cs.pendingApprovals = new Map();
			cs.auditLogger = { record: vi.fn() };
			cs.settingsSvc = { push: vi.fn(), current: { toolApprovalEnabled: true } };
			cs.emit = vi.fn();
			cs.flushSnapshot = vi.fn();
			return cs;
		}

		it("resolveToolApproval 当所属对话不存在于当前客户端会话时拒绝放行", () => {
			const cs = createFakeClientSession();
			const resolveFn = vi.fn();

			cs.pendingApprovals.set("appr-1", {
				id: "appr-1",
				toolCallId: "call-1",
				toolName: "bash",
				params: { command: "ls" },
				conversationId: "ghost-conv",
				resolve: resolveFn,
				createdAt: Date.now(),
			});

			const res = cs.resolveToolApproval("appr-1", "approve", undefined, undefined, "once");
			expect(res).toBe(false);
			expect(resolveFn).toHaveBeenCalledWith({
				decision: "deny",
				reason: "所属对话不存在或已关闭",
			});
			expect(cs.pendingApprovals.has("appr-1")).toBe(false);
		});

		it("approveCoveredPending 只批量放行属于同一 conversationId 的待审批项，绝不收编其他对话", () => {
			const cs = createFakeClientSession();
			const resolveA1 = vi.fn();
			const resolveA2 = vi.fn();
			const resolveB = vi.fn();

			cs.convs.set("conv-A", { id: "conv-A", title: "Conversation A" });
			cs.convs.set("conv-B", { id: "conv-B", title: "Conversation B" });
			cs.activeId = "conv-A";

			cs.pendingApprovals.set("appr-a1", {
				id: "appr-a1",
				toolCallId: "call-a1",
				toolName: "bash",
				params: { command: "echo 1" },
				conversationId: "conv-A",
				resolve: resolveA1,
				createdAt: Date.now(),
			});
			cs.pendingApprovals.set("appr-a2", {
				id: "appr-a2",
				toolCallId: "call-a2",
				toolName: "bash",
				params: { command: "echo 2" },
				conversationId: "conv-A",
				resolve: resolveA2,
				createdAt: Date.now(),
			});
			cs.pendingApprovals.set("appr-b", {
				id: "appr-b",
				toolCallId: "call-b",
				toolName: "bash",
				params: { command: "rm -rf /something" },
				conversationId: "conv-B",
				resolve: resolveB,
				createdAt: Date.now(),
			});

			const policy = { allowAll: true, categories: new Map() };
			const approvedCount = cs.approveCoveredPending("conv-A", policy);

			expect(approvedCount).toBe(2);
			expect(resolveA1).toHaveBeenCalledWith({ decision: "approve" });
			expect(resolveA2).toHaveBeenCalledWith({ decision: "approve" });
			// conv-B 的审批项绝不应被收编或自动放行！
			expect(resolveB).not.toHaveBeenCalled();
			expect(cs.pendingApprovals.has("appr-b")).toBe(true);
		});

		it("setApprovalPolicy 拒绝篡改子代理对话与不存在的对话策略", () => {
			const cs = createFakeClientSession();
			const subConv = { id: "sub-1", isSubagent: true, approvalPolicy: undefined };
			cs.convs.set("sub-1", subConv);

			cs.setApprovalPolicy({ conversationId: "sub-1", allowAll: true });
			expect(subConv.approvalPolicy).toBeUndefined();

			cs.setApprovalPolicy({ conversationId: "does-not-exist", allowAll: true });
			expect(cs.convs.has("does-not-exist")).toBe(false);
		});
	});
});
