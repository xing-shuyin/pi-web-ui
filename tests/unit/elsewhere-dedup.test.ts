import { describe, expect, it, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { resolve } from "node:path";
import { fakeAgentService } from "../helpers/fake-session.js";

describe("elsewhere（「另一处」）排重与过户生命周期防护", () => {
	it("streamingSummariesAll: 同一 ClientSession 内多条会话具有相同 sessionFile 时去重", () => {
		const cs = Object.create(ClientSession.prototype) as any;
		cs.convs = new Map();
		cs.conversationStreaming = vi.fn().mockReturnValue(false);
		cs.shownInRunningList = vi.fn().mockReturnValue(true);
		cs.getPendingQuestionForConv = vi.fn().mockReturnValue(undefined);

		const fakePath = resolve("/fake/work/sessions/conv-1.json");
		const conv1 = {
			id: "c1",
			title: "同名测试对话",
			cwd: "/fake/work",
			isSubagent: false,
			session: { sessionFile: fakePath },
		} as any;
		const conv2 = {
			id: "c2",
			title: "同名测试对话",
			cwd: "/fake/work",
			isSubagent: false,
			session: { sessionFile: fakePath },
		} as any;

		cs.convs.set("c1", conv1);
		cs.convs.set("c2", conv2);

		const summaries = cs.streamingSummariesAll();
		expect(summaries.length).toBe(1);
		expect(summaries[0].title).toBe("同名测试对话");
		expect(summaries[0].convId).toBe("c1");
	});

	it("listExternalRunning: 排除当前客户端自己已持有的会话（相同 sessionFile 或相同 cwd+title）", () => {
		const svc = Object.create(AgentService.prototype) as any;
		svc.clients = new Map();

		const sharedFile = resolve("/fake/work/sessions/conv-shared.json");
		const currentClient = Object.create(ClientSession.prototype) as any;
		currentClient.takeoverBriefs = vi.fn().mockReturnValue([
			{
				id: "c_current",
				title: "我在手机端使用的对话",
				cwd: "/fake/work",
				sessionFile: sharedFile,
				isSubagent: false,
				isEphemeral: false,
			},
		]);

		const otherClient = Object.create(ClientSession.prototype) as any;
		otherClient.sinkCount = vi.fn().mockReturnValue(1);
		otherClient.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "我在手机端使用的对话",
				cwd: "/fake/work",
				isStreaming: false,
				convId: "c_other",
				hasQuestion: false,
				sessionFile: sharedFile,
			},
		]);

		svc.clients.set("client-current", currentClient);
		svc.clients.set("client-other", otherClient);

		// 当前客户端请求 elsewhere 列表：因为本机已经持有 sharedFile，不应返回
		const elsewhere = svc.listExternalRunning("client-current");
		expect(elsewhere.length).toBe(0);
	});

	it("listExternalRunning: 多个外部客户端上报同一会话时跨客户端去重，且优先保留 streaming / hasQuestion", () => {
		const svc = Object.create(AgentService.prototype) as any;
		svc.clients = new Map();

		const currentClient = Object.create(ClientSession.prototype) as any;
		currentClient.takeoverBriefs = vi.fn().mockReturnValue([]);
		svc.clients.set("client-current", currentClient);

		const sharedFile = resolve("/fake/work/sessions/conv-dup.json");

		// 客户端 A：空闲无问卷
		const clientA = Object.create(ClientSession.prototype) as any;
		clientA.sinkCount = vi.fn().mockReturnValue(1);
		clientA.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "堆积测试对话",
				cwd: "/fake/work",
				isStreaming: false,
				convId: "ca1",
				hasQuestion: false,
				sessionFile: sharedFile,
			},
		]);

		// 客户端 B：正在流式运行 (streaming: true)
		const clientB = Object.create(ClientSession.prototype) as any;
		clientB.sinkCount = vi.fn().mockReturnValue(1);
		clientB.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "堆积测试对话",
				cwd: "/fake/work",
				isStreaming: true,
				convId: "cb1",
				hasQuestion: false,
				sessionFile: sharedFile,
			},
		]);

		// 客户端 C：空闲无问卷
		const clientC = Object.create(ClientSession.prototype) as any;
		clientC.sinkCount = vi.fn().mockReturnValue(1);
		clientC.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "堆积测试对话",
				cwd: "/fake/work",
				isStreaming: false,
				convId: "cc1",
				hasQuestion: false,
				sessionFile: sharedFile,
			},
		]);

		svc.clients.set("client-a", clientA);
		svc.clients.set("client-b", clientB);
		svc.clients.set("client-c", clientC);

		const elsewhere = svc.listExternalRunning("client-current");
		// 3 个客户端持有同一个文件，必须去重为 1 条，并且胜出者必须是 streaming 的 clientB
		expect(elsewhere.length).toBe(1);
		expect(elsewhere[0].owner).toBe("client-b");
		expect(elsewhere[0].isStreaming).toBe(true);
	});

	it("insertTakeoverConvs: 过户时若 target 已残留相同 sessionFile 的旧会话，应清理旧残留", () => {
		const cs = Object.create(ClientSession.prototype) as any;
		cs.convs = new Map();
		cs.activeId = "c_active";
		cs.nextConversationId = vi.fn().mockReturnValue("c_new");
		cs.removeConversation = vi.fn((id: string) => cs.convs.delete(id));
		cs.getBaseToolWatchdogTimeoutMs = vi.fn().mockReturnValue(0);

		const sharedFile = resolve("/fake/work/sessions/conv-takeover.json");

		// target 本地已有旧实例 c_stale（不是 active）
		const staleConv = {
			id: "c_stale",
			title: "旧对话实例",
			cwd: "/fake/work",
			session: { sessionFile: sharedFile },
		} as any;
		cs.convs.set("c_stale", staleConv);

		const payload = {
			convs: [
				{
					id: "c_incoming",
					title: "新过户过来的对话",
					cwd: "/fake/work",
					session: {
						sessionFile: sharedFile,
						subscribe: vi.fn(),
					},
					terminals: {
						rebindEmit: vi.fn(),
					},
					toolStartTimes: new Map(),
					toolWatchdogs: new Map(),
				} as any,
			],
			questions: [],
			pageCalls: [],
			approvals: [],
		};

		cs.insertTakeoverConvs(payload);

		// 旧实例已被清理，新实例已插入
		expect(cs.removeConversation).toHaveBeenCalledWith("c_stale");
		expect(cs.convs.has("c_stale")).toBe(false);
		expect(cs.convs.has("c_incoming")).toBe(true);
	});

	it("pendingDetaches: 当连接在 attach 异步创建期间断开时，记录并在后续阻止 sink 泄漏", () => {
		// 集合字段（pending / pendingDetaches / sharedViewers …）由 fake-session 从生产
		// 源码推导，新增字段自动跟上，不再逐个手补。
		const svc = fakeAgentService({ clients: new Map(), pokeExternalRunning: vi.fn() }) as any;

		const sendMock = vi.fn();
		const clientId = "client-racing";

		// 模拟正在异步创建中
		svc.pending.set(clientId, Promise.resolve({} as any));

		// 连接中断，调用 detach
		svc.detach(clientId, sendMock);

		// pendingDetaches 中应记录该 send
		expect(svc.pendingDetaches.has(clientId)).toBe(true);
		expect(svc.pendingDetaches.get(clientId)?.has(sendMock)).toBe(true);
	});

	it("listExternalRunning: 断连残骸的离线行在宽限期内仍下发（标 ownerOffline，可过户）", () => {
		const svc = Object.create(AgentService.prototype) as any;
		svc.clients = new Map();
		svc.offlineSince = new Map([["phone-page", Date.now()]]);

		const current = Object.create(ClientSession.prototype) as any;
		current.takeoverBriefs = vi.fn().mockReturnValue([]);
		svc.clients.set("client-current", current);

		const dead = Object.create(ClientSession.prototype) as any;
		dead.sinkCount = vi.fn().mockReturnValue(0);
		dead.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "手机端发起的任务",
				cwd: "/fake/work",
				isStreaming: false,
				convId: "c1",
				hasQuestion: false,
				sessionFile: resolve("/fake/work/sessions/phone.json"),
				activity: Date.now(),
			},
		]);
		svc.clients.set("phone-page", dead);

		const elsewhere = svc.listExternalRunning("client-current");
		expect(elsewhere.length).toBe(1);
		expect(elsewhere[0].owner).toBe("phone-page");
		expect(elsewhere[0].ownerOffline).toBe(true);
		expect(elsewhere[0].convId).toBe("c1");
	});

	it("listExternalRunning: 离线行过了宽限期不再下发（#291 不永久占位）", () => {
		const svc = Object.create(AgentService.prototype) as any;
		svc.clients = new Map();
		const staleAt = Date.now() - 2 * 60 * 60 * 1000;
		svc.offlineSince = new Map([["phone-page", staleAt]]);

		const current = Object.create(ClientSession.prototype) as any;
		current.takeoverBriefs = vi.fn().mockReturnValue([]);
		svc.clients.set("client-current", current);

		const dead = Object.create(ClientSession.prototype) as any;
		dead.sinkCount = vi.fn().mockReturnValue(0);
		dead.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "两小时前关掉的那条",
				cwd: "/fake/work",
				isStreaming: false,
				convId: "c1",
				hasQuestion: false,
				sessionFile: resolve("/fake/work/sessions/old.json"),
				activity: staleAt,
			},
		]);
		svc.clients.set("phone-page", dead);

		expect(svc.listExternalRunning("client-current")).toEqual([]);
	});

	it("listExternalRunning: 同一会话同时有离线残骸与在线持有方时，保留在线行", () => {
		const svc = Object.create(AgentService.prototype) as any;
		svc.clients = new Map();
		svc.offlineSince = new Map([["dead-page", Date.now()]]);

		const current = Object.create(ClientSession.prototype) as any;
		current.takeoverBriefs = vi.fn().mockReturnValue([]);
		svc.clients.set("client-current", current);

		const shared = resolve("/fake/work/sessions/same.json");
		const dead = Object.create(ClientSession.prototype) as any;
		dead.sinkCount = vi.fn().mockReturnValue(0);
		dead.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "同一个对话",
				cwd: "/fake/work",
				isStreaming: false,
				convId: "c-dead",
				hasQuestion: false,
				sessionFile: shared,
				activity: Date.now(),
			},
		]);
		svc.clients.set("dead-page", dead);

		const live = Object.create(ClientSession.prototype) as any;
		live.sinkCount = vi.fn().mockReturnValue(1);
		live.streamingSummariesAll = vi.fn().mockReturnValue([
			{
				title: "同一个对话",
				cwd: "/fake/work",
				isStreaming: false,
				convId: "c-live",
				hasQuestion: false,
				sessionFile: shared,
				activity: Date.now(),
			},
		]);
		svc.clients.set("live-page", live);

		const elsewhere = svc.listExternalRunning("client-current");
		expect(elsewhere.length).toBe(1);
		expect(elsewhere[0].owner).toBe("live-page");
		expect(elsewhere[0].ownerOffline).toBeUndefined();
	});
});
