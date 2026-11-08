/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n.js";
import { LeftPanel } from "../../web/src/components/LeftPanel.js";
import { setAppGlobals } from "../../web/src/app-globals.js";
import { clearAllUnread, markConversationUnread } from "../../web/src/unread-conversations.js";
import { conversationOrder, recordUserPrompt } from "../../web/src/conversation-order.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

let root: Root | null = null;
afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	clearAllUnread();
	conversationOrder.clear();
});

function stubZhStorage() {
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		value: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, String(v)),
			removeItem: (k: string) => void store.delete(k),
			clear: () => store.clear(),
		} as unknown as Storage,
		writable: true,
	});
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(overrides: Record<string, unknown> = {}) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	const panelSend = (msg: unknown) => {
		sent.push(msg);
		return true;
	};
	const props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [],
		projects: [{ path: "/test", lastUsed: Date.now() }],
		activeConversationId: "",
		panelSend,
		...overrides,
	};
	const rerender = (nextOverrides: Record<string, unknown>) => {
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					createElement(LeftPanel as any, { ...props, ...nextOverrides }),
				),
			);
		});
	};
	rerender({});
	return { container, sent, rerender };
}

describe("左栏会话位置与纯背景高亮守卫", () => {
	it("项目头激活态采用蓝色系背景且无边框线/无内阴影边框", () => {
		const match = CSS.match(/\.lp-project-head-row\.active[\s\S]*?\{([^}]*)\}/);
		expect(match).toBeTruthy();
		const body = match![1];
		expect(body).toContain("var(--blue");
		expect(body).toMatch(/border:\s*none/);
		expect(body).toMatch(/box-shadow:\s*none/);
	});

	it("项目头操作按钮绝对定位，hover 时不引起行内按钮宽度缩进或边框抖动", () => {
		const match = CSS.match(/\.lp-project-actions\s*\{([^}]*)\}/);
		expect(match).toBeTruthy();
		const body = match![1];
		expect(body).toContain("position: absolute");
		expect(body).toContain("right: 6px");
	});

	it("临时对话具备专用的临时胶囊标识样式且无刺眼实体边框", () => {
		expect(CSS).toMatch(/\.ephemeral-badge\s*\{[^}]*display:\s*inline-flex/);
		expect(CSS).toMatch(/\.ephemeral-badge\s*\{[^}]*var\(--amber/);
	});

	it("运行与完成未查看的会话仅通过右侧状态图标提示，不添加背景高亮", () => {
		const runningMatch = CSS.match(/\.lp-tree-session-item\.is-running\s*\{([^}]*)\}/);
		expect(runningMatch).toBeTruthy();
		expect(runningMatch![1]).toMatch(/background:\s*transparent/);
		expect(runningMatch![1]).toMatch(/box-shadow:\s*none/);

		expect(CSS).not.toMatch(/\.is-unread[^{}]*\{[^}]*\b(?:background|box-shadow)\s*:/);
	});

	it("仅仅打开历史会话查看时，不进入顶部活动列表，保留在历史列表中并展示时间戳", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const historyTime = Date.now() - 3600000;
		const sessions = [
			{ path: "/test/session-new.jsonl", sessionId: "s-new", name: "最新会话", modified: Date.now() },
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "历史会话", modified: historyTime },
		];
		const conversations = [
			{
				id: "c-old",
				sessionId: "s-old",
				sessionFile: "/test/session-old.jsonl",
				cwd: "/test",
				title: "历史会话",
				messageCount: 5,
				isStreaming: false,
				isSubagent: false,
			},
		];

		const { container } = mountLeftPanel({
			sessions,
			conversations,
			activeConversationId: "c-old",
			sessionFile: "/test/session-old.jsonl",
		});

		const sessionRows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		expect(sessionRows.length).toBe(2);

		const titles = Array.from(sessionRows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles[0]).toBe("最新会话");
		expect(titles[1]).toBe("历史会话");

		const timeEl = sessionRows[1].querySelector(".conv-time");
		expect(timeEl).toBeTruthy();
		expect(timeEl?.textContent?.trim()).toBeTruthy();
	});

	it.each(["local", "history", "elsewhere"] as const)("%s 仅在当前查看的对话标题前显示当前标识", (source) => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const modified = Date.now();
		const { container } = mountLeftPanel({
			conversations: [
				{
					id: "current-conv",
					sessionId: "current-session",
					cwd: "/test",
					title: "正在查看的对话",
					messageCount: 3,
					modified,
					isStreaming: false,
					isSubagent: false,
					...(source === "history" ? { sessionFile: "/test/current.jsonl" } : {}),
					...(source === "elsewhere" ? { elsewhere: true, owner: "other-window", convId: "current-conv" } : {}),
				},
				{
					id: "other-conv",
					cwd: "/test",
					title: "其他对话",
					messageCount: 2,
					modified: modified - 60_000,
					isStreaming: false,
					isSubagent: false,
				},
			],
			activeConversationId: "current-conv",
			sharedConversationOwner: source === "elsewhere" ? "other-window" : undefined,
			sessionFile: source === "history" ? "/test/current.jsonl" : null,
			sessions:
				source === "history"
					? [{ path: "/test/current.jsonl", sessionId: "current-session", name: "正在查看的对话", modified }]
					: [],
		});

		const badges = container.querySelectorAll(".conv-current-badge");
		expect(badges).toHaveLength(1);
		expect(badges[0].textContent).toBe("当前");
		const currentRow = badges[0].closest(".lp-tree-session-item")!;
		expect(currentRow.classList.contains("active")).toBe(true);
		expect(currentRow.querySelector(".conv-title-text")?.previousElementSibling).toBe(badges[0]);
		expect(currentRow.querySelector(".conv-title-text")?.textContent).toBe("正在查看的对话");
		expect(currentRow.querySelector(".conv-meta-zone .conv-time")).toBeTruthy();
		expect(currentRow.querySelector(".conv-meta-zone .conv-current-badge")).toBeNull();
	});

	it("首次加载按更新时间排列全部会话，运行状态不优先于较新的历史会话", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [
			{ path: "/test/session-new.jsonl", sessionId: "s-new", name: "最新会话", modified: Date.now() },
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "历史会话", modified: Date.now() - 3600000 },
		];
		const conversations = [
			{
				id: "c-old",
				sessionId: "s-old",
				sessionFile: "/test/session-old.jsonl",
				cwd: "/test",
				title: "历史会话",
				messageCount: 6,
				isStreaming: true,
				isSubagent: false,
			},
		];

		const { container } = mountLeftPanel({
			sessions,
			conversations,
			activeConversationId: "c-old",
			sessionFile: "/test/session-old.jsonl",
		});

		const sessionRows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		expect(sessionRows.length).toBe(2);

		const titles = Array.from(sessionRows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles).toEqual(["最新会话", "历史会话"]);

		expect(sessionRows[1].querySelector(".status-spinner-right")).toBeTruthy();
		expect(sessionRows[1].querySelector(".conv-time")).toBeNull();
		expect(sessionRows[0].querySelector(".conv-time")).toBeTruthy();
	});

	it.each(
		(["local", "elsewhere", "history"] as const).flatMap((source) =>
			(["idle", "unread", "streaming", "question", "error"] as const)
				.filter((state) => source !== "history" || (state !== "streaming" && state !== "question"))
				.map((state) => ({ source, state })),
		),
	)("$source 会话 $state 状态与时间共用最右侧位置", ({ source, state }) => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const modified = Date.now() - 60_000;
		const conversation = {
			id: "status-row",
			sessionId: "status-session",
			cwd: "/test",
			title: "状态对齐",
			messageCount: 3,
			modified,
			isSubagent: false,
			isStreaming: state === "streaming",
			hasQuestion: state === "question",
			error: state === "error" ? "运行失败" : undefined,
			agentPreset: "reviewer",
			...(source === "history" ? { sessionFile: "/test/status.jsonl" } : {}),
			...(source === "elsewhere" ? { elsewhere: true, owner: "other-window", convId: "status-row" } : {}),
		};
		if (state === "unread") markConversationUnread(conversation);
		const { container } = mountLeftPanel({
			conversations: [conversation],
			sessions:
				source === "history"
					? [{ path: "/test/status.jsonl", sessionId: conversation.sessionId, name: conversation.title, modified }]
					: [],
		});

		const row = container.querySelector(".lp-project-tree-children .lp-row");
		expect(row).toBeTruthy();
		const meta = row!.querySelector(".conv-meta-zone")!;
		if (state === "idle") {
			expect(meta.querySelector(".conv-indicator-slot")).toBeNull();
			expect(meta.lastElementChild?.classList.contains("conv-time")).toBe(true);
		} else {
			const selector = {
				unread: ".status-unread-right",
				streaming: ".status-spinner-right",
				question: ".status-question-right",
				error: ".status-error-right",
			}[state];
			expect(meta.querySelector(".conv-time")).toBeNull();
			expect(meta.lastElementChild?.classList.contains("conv-indicator-slot")).toBe(true);
			expect(meta.lastElementChild?.querySelector(selector)).toBeTruthy();
		}
	});

	it("历史会话切换转圈占用时间位置，不同时显示进度时间", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			sessions: [{ path: "/test/loading.jsonl", name: "正在打开", modified: Date.now() }],
			transition: { kind: "session", target: "/test/loading.jsonl", progress: 45 },
		});
		const meta = container.querySelector(".session-item .conv-meta-zone")!;
		expect(meta.querySelector(".conv-time")).toBeNull();
		expect(meta.lastElementChild?.querySelector(".status-spinner-right")).toBeTruthy();
	});

	it("所有运行中的对话（包括无修改时间的新建对话和有修改时间的老对话）均不显示时间，确保右侧圆圈完全对齐", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "老对话", modified: Date.now() - 3600000 },
			{ path: "/test/session-idle.jsonl", sessionId: "s-idle", name: "闲置对话", modified: Date.now() - 7200000 },
		];
		const conversations = [
			{
				id: "c-new",
				cwd: "/test",
				title: "新建对话",
				messageCount: 1,
				isStreaming: true,
				isSubagent: false,
			},
			{
				id: "c-old",
				sessionId: "s-old",
				sessionFile: "/test/session-old.jsonl",
				cwd: "/test",
				title: "老对话",
				modified: Date.now() - 3600000,
				messageCount: 5,
				isStreaming: true,
				isSubagent: false,
			},
		];

		const { container } = mountLeftPanel({
			sessions,
			conversations,
			activeConversationId: "c-new",
		});

		const rows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		const runningSpinners = container.querySelectorAll(".lp-project-tree-children .status-spinner-right");
		expect(runningSpinners.length).toBe(2);

		const newConvTime = rows[0].querySelector(".conv-time");
		const oldConvTime = rows[1].querySelector(".conv-time");
		expect(newConvTime).toBeNull();
		expect(oldConvTime).toBeNull();

		const idleConvTime = rows[2].querySelector(".conv-time");
		expect(idleConvTime).toBeTruthy();
	});

	it("临时对话应当带有明确的临时徽标（.ephemeral-badge）且统一放置在右侧元数据区", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const conversations = [
			{
				id: "c-ephemeral",
				cwd: "/test",
				title: "临时测试对话",
				messageCount: 1,
				isStreaming: false,
				isSubagent: false,
				isEphemeral: true,
				pinned: true,
			},
		];

		const { container } = mountLeftPanel({
			conversations,
			activeConversationId: "c-ephemeral",
		});

		const badge = container.querySelector(".ephemeral-badge");
		expect(badge).toBeTruthy();
		expect(badge?.textContent).toContain("临时");

		expect(badge?.closest(".conv-meta-zone")).toBeTruthy();
		expect(container.querySelector(".conv-title-text .ephemeral-badge")).toBeNull();

		const pin = container.querySelector(".pin-badge");
		expect(pin).toBeTruthy();
		expect(pin?.closest(".conv-meta-zone")).toBeTruthy();
		expect(container.querySelector(".conv-title-text .pin-badge")).toBeNull();
	});

	it("项目内层按钮为纯透明背景，杜绝双层背景叠加", () => {
		const match = CSS.match(/\.lp-project-head-row \.lp-project-header-item[\s\S]*?\{([^}]*)\}/);
		expect(match).toBeTruthy();
		expect(match![1]).toMatch(/background:\s*transparent/);
	});

	it("历史会话折叠区带有现代 CSS Grid 平滑过渡动画样式", () => {
		const match = CSS.match(/\.lp-history-collapsible\s*\{([^}]*)\}/);
		expect(match).toBeTruthy();
		expect(match![1]).toContain("grid-template-rows: 1fr");
		expect(match![1]).toContain("transition:");

		const chevronMatch = CSS.match(/\.lp-project-header-item \.lp-project-chevron\s*\{([^}]*)\}/);
		expect(chevronMatch).toBeTruthy();
		expect(chevronMatch![1]).toMatch(/transition:[\s\S]*?transform/);
	});

	it("打开新项目时不会自动折叠已展开的其他项目", () => {
		setAppGlobals({ cwd: "/proj1", ready: true, status: "open", workspaceRoots: [] });
		const projects = [
			{ path: "/proj1", lastUsed: Date.now() },
			{ path: "/proj2", lastUsed: Date.now() - 1000 },
		];
		const projectSessions = {
			"/proj1": [{ path: "/proj1/s1.jsonl", name: "S1", modified: Date.now() }],
			"/proj2": [{ path: "/proj2/s2.jsonl", name: "S2", modified: Date.now() }],
		};

		const { container } = mountLeftPanel({
			projects,
			projectSessions,
		});

		const nodes = container.querySelectorAll(".lp-project-node");
		expect(nodes.length).toBe(2);

		const proj2Chevron = nodes[1].querySelector<HTMLElement>(".lp-project-chevron");
		expect(proj2Chevron).toBeTruthy();
		act(() => proj2Chevron!.click());

		const head1 = nodes[0].querySelector(".lp-project-head-row");
		const head2 = nodes[1].querySelector(".lp-project-head-row");
		expect(head1?.classList.contains("is-expanded")).toBe(true);
		expect(head2?.classList.contains("is-expanded")).toBe(true);
	});

	it("打开项目的加载圆圈与运行对话一致放置在右侧元数据区相同位置，左侧不残留 spinner", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			projects: [{ path: "/test", lastUsed: Date.now() }],
			transition: { kind: "cwd", target: "/test", progress: 45 },
		});

		const projectHeader = container.querySelector(".lp-project-header-item");
		expect(projectHeader).toBeTruthy();

		const leftSpinner = projectHeader!.querySelector(".project-icon.spin");
		expect(leftSpinner).toBeNull();

		const metaZone = projectHeader!.querySelector(".conv-meta-zone");
		expect(metaZone).toBeTruthy();
		const rightSpinner = metaZone!.querySelector(".status-spinner-right");
		expect(rightSpinner).toBeTruthy();

		const timeEl = metaZone!.querySelector(".project-time.switching-pct");
		expect(timeEl).toBeTruthy();
		expect(timeEl?.textContent).toContain("45%");
	});

	it("打开的项目折叠历史对话时子树保持挂载，容器平滑收拢（collapsed），杜绝瞬间卸载消失", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [{ path: "/test/s1.jsonl", sessionId: "s1", name: "对话 1", modified: Date.now() }];
		const { container } = mountLeftPanel({
			projects: [{ path: "/test", lastUsed: Date.now() }],
			sessions,
		});

		const chevron = container.querySelector<HTMLElement>(".lp-project-chevron");
		expect(chevron).toBeTruthy();

		const collapsible = container.querySelector(".lp-history-collapsible");
		expect(collapsible).toBeTruthy();
		expect(collapsible?.classList.contains("expanded")).toBe(true);

		act(() => chevron!.click());

		const treeChildren = container.querySelector(".lp-project-tree-children");
		expect(treeChildren).toBeTruthy();
		expect(treeChildren?.classList.contains("is-collapsed")).toBe(true);

		const collapsibleAfter = container.querySelector(".lp-history-collapsible");
		expect(collapsibleAfter).toBeTruthy();
		expect(collapsibleAfter?.classList.contains("collapsed")).toBe(true);
	});

	it("会话行包含稳定的 data-session-key 用于支撑移动到顶部的 FLIP 平滑补间过渡动画", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [{ path: "/test/session-a.jsonl", sessionId: "s-a", name: "会话 A", modified: Date.now() }];
		const { container } = mountLeftPanel({
			sessions,
			conversations: [],
		});

		const row = container.querySelector<HTMLElement>(".lp-row[data-session-key]");
		expect(row).toBeTruthy();
		expect(row?.getAttribute("data-session-key")).toContain("session-a.jsonl");
	});

	it("样式守卫：.lp-history-collapsible-inner 包含 min-height: 0，svg.status-spinner-right 去除 border", () => {
		expect(CSS).toMatch(/\.lp-history-collapsible-inner\s*\{[^}]*min-height:\s*0/);
		expect(CSS).toMatch(/svg\.status-spinner-right\s*\{[^}]*border:\s*none/);
		expect(CSS).toMatch(/\.session-row-promoting\s*\{/);
	});

	it("打开运行中的对话时，不改变运行对话的原有顺序，绝不因为查看/激活而随意置顶移动", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const now = Date.now();
		const conversations = [
			{
				id: "c-1",
				cwd: "/test",
				title: "任务 1（较新）",
				messageCount: 3,
				isStreaming: true,
				isSubagent: false,
				modified: now,
			},
			{
				id: "c-2",
				cwd: "/test",
				title: "任务 2（较旧）",
				messageCount: 2,
				isStreaming: true,
				isSubagent: false,
				modified: now - 10000,
			},
		];

		const { container } = mountLeftPanel({
			conversations,
			activeConversationId: "c-2",
		});

		const rows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		expect(rows.length).toBe(2);

		const titles = Array.from(rows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles[0]).toBe("任务 1（较新）");
		expect(titles[1]).toBe("任务 2（较旧）");
	});

	it("用户发送只提升所属项目内的会话，常驻标记与项目最近使用时间不改变顺序", () => {
		setAppGlobals({ cwd: "/first", ready: true, status: "open", workspaceRoots: [] });
		const conversations = [
			{ id: "first", cwd: "/first", title: "第一个项目的对话", messageCount: 1, modified: 2000 },
			{ id: "older", cwd: "/second", title: "较旧的对话", messageCount: 1, isStreaming: true, modified: 1000 },
			{ id: "pinned", cwd: "/second", title: "置顶的对话", messageCount: 1, pinned: true, modified: 500 },
		];
		const { container, rerender } = mountLeftPanel({
			projects: [
				{ path: "/first", lastUsed: 2000 },
				{ path: "/second", lastUsed: 1000 },
			],
			conversations,
			activeConversationId: "first",
		});
		const projectOrder = () =>
			Array.from(container.querySelectorAll(".lp-project-header-item")).map((node) =>
				node.getAttribute("data-project-path"),
			);
		expect(projectOrder()).toEqual(["/first", "/second"]);

		setAppGlobals({ cwd: "/second", ready: true, status: "open", workspaceRoots: [] });
		act(() => recordUserPrompt({ cwd: "/second", conversationId: "new" }, conversations));
		rerender({
			projects: [
				{ path: "/second", lastUsed: 3000 },
				{ path: "/first", lastUsed: 2000 },
			],
			conversations: [
				...conversations,
				{ id: "new", cwd: "/second", title: "新对话", messageCount: 1, isStreaming: true, modified: 3000 },
			],
			activeConversationId: "new",
		});

		expect(projectOrder()).toEqual(["/first", "/second"]);
		const secondProject = container.querySelector('[data-project-path="/second"]')!.closest(".lp-project-node")!;
		const titles = Array.from(secondProject.querySelectorAll(".conv-title-text")).map((node) =>
			node.textContent?.trim(),
		);
		expect(titles).toEqual(["新对话", "较旧的对话", "置顶的对话"]);
	});

	it("页面初始化等待最新历史摘要替换缓存，之后冻结顺序", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const cached = [
			{ path: "/test/a.jsonl", sessionId: "a", name: "缓存较新", modified: 200 },
			{ path: "/test/b.jsonl", sessionId: "b", name: "后来更新", modified: 100 },
		];
		const { container, rerender } = mountLeftPanel({ sessions: cached, projectSessions: {} });
		const titles = () =>
			Array.from(container.querySelectorAll(".lp-project-tree-children .conv-title-text"), (node) => node.textContent);
		expect(titles()).toEqual(["缓存较新", "后来更新"]);
		const live = [{ ...cached[1], modified: 500 }, cached[0]];
		rerender({ sessions: live, projectSessions: { "/test": live } });
		expect(titles()).toEqual(["后来更新", "缓存较新"]);
		const background = [{ ...cached[0], modified: 9000 }, ...live.slice(0, 1)];
		rerender({ sessions: background, projectSessions: { "/test": background } });
		expect(titles()).toEqual(["后来更新", "缓存较新"]);
	});

	it("状态、修改时间、常驻、后台未读和活动/历史切换都不移动会话", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [
			{ path: "/test/new.jsonl", sessionId: "new", name: "较新", modified: 300 },
			{ path: "/test/middle.jsonl", sessionId: "middle", name: "中间", modified: 200 },
			{ path: "/test/old.jsonl", sessionId: "old", name: "较旧", modified: 100 },
		];
		const middle = {
			id: "middle-conv",
			sessionId: "middle",
			sessionFile: sessions[1].path,
			cwd: "/test",
			title: "中间",
			messageCount: 3,
			modified: 200,
		};
		const { container, rerender } = mountLeftPanel({
			sessions,
			conversations: [middle],
			activeConversationId: middle.id,
		});
		const titles = () =>
			Array.from(container.querySelectorAll(".lp-project-tree-children .conv-title-text"), (node) => node.textContent);
		expect(titles()).toEqual(["较新", "中间", "较旧"]);
		for (const status of [
			{ isStreaming: true },
			{ completionPending: true },
			{ hasQuestion: true },
			{ error: "failed" },
			{ pinned: true },
			{},
		]) {
			rerender({
				conversations: [{ ...middle, ...status, modified: 9000 }],
				sessions: [...sessions]
					.reverse()
					.map((session) => ({ ...session, modified: session.sessionId === "old" ? 10000 : session.modified })),
			});
			expect(titles()).toEqual(["较新", "中间", "较旧"]);
		}
		act(() => markConversationUnread({ id: middle.id, sessionId: "middle" }));
		expect(titles()).toEqual(["较新", "中间", "较旧"]);
		rerender({ conversations: [] });
		expect(titles()).toEqual(["较新", "中间", "较旧"]);
	});

	it("创建、运行和移除工作树子代理时父对话保留位置，直接发送给子代理才提升父树", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [
			{ path: "/test/new.jsonl", sessionId: "new", name: "较新", modified: 300 },
			{ path: "/test/parent.jsonl", sessionId: "parent", name: "父对话", modified: 200 },
		];
		const parent = {
			id: "parent-conv",
			sessionId: "parent",
			sessionFile: sessions[1].path,
			cwd: "/test",
			title: "父对话",
			messageCount: 3,
			modified: 200,
		};
		const { container, rerender } = mountLeftPanel({ sessions, conversations: [parent] });
		const titles = () =>
			Array.from(container.querySelectorAll(".lp-project-tree-children .conv-title-text"), (node) => node.textContent);
		const child = {
			id: "child",
			parentId: parent.id,
			cwd: "/worktree",
			title: "子代理",
			messageCount: 1,
			isSubagent: true,
			isStreaming: true,
			modified: 9999,
		};
		rerender({ conversations: [{ ...parent, isStreaming: true, modified: 9999 }, child] });
		expect(titles()).toEqual(["较新", "父对话", "子代理"]);
		expect(container.querySelectorAll(".lp-project-header-item")).toHaveLength(1);
		rerender({ conversations: [parent, { ...child, isStreaming: false, modified: 19999 }] });
		expect(titles()).toEqual(["较新", "父对话", "子代理"]);
		act(() => recordUserPrompt({ cwd: "/worktree", conversationId: child.id }, [parent, child]));
		expect(titles()).toEqual(["父对话", "子代理", "较新"]);
		rerender({ conversations: [parent] });
		expect(titles()).toEqual(["父对话", "较新"]);
	});

	it("用户发送时立即把历史会话提升到所有活动/历史会话上方，下一次发送才再次重排", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = Array.from({ length: 10 }, (_, index) => ({
			path: `/test/s${index}.jsonl`,
			sessionId: `s${index}`,
			name: `会话${index}`,
			modified: index + 1,
		}));
		const older = {
			id: "older",
			sessionId: "s0",
			sessionFile: sessions[0].path,
			cwd: "/test",
			title: "会话0",
			messageCount: 2,
			modified: 1,
		};
		const active = {
			id: "active",
			sessionId: "s8",
			sessionFile: sessions[8].path,
			cwd: "/test",
			title: "会话8",
			messageCount: 2,
			isStreaming: true,
			modified: 9,
		};
		const conversations = [older, active];
		const { container, rerender } = mountLeftPanel({ sessions, conversations, activeConversationId: older.id });
		const titles = () =>
			Array.from(container.querySelectorAll(".lp-project-tree-children .conv-title-text"), (node) => node.textContent);
		expect(titles().slice(0, 2)).toEqual(["会话9", "会话8"]);
		expect(titles()).not.toContain("会话0");
		act(() => recordUserPrompt({ cwd: "/test", conversationId: older.id, sessionId: "s0" }, conversations));
		expect(titles().slice(0, 3)).toEqual(["会话0", "会话9", "会话8"]);
		rerender({
			conversations: [
				{ ...active, modified: 999 },
				{ ...older, isStreaming: true, modified: 999 },
			],
		});
		expect(titles().slice(0, 3)).toEqual(["会话0", "会话9", "会话8"]);
		act(() => recordUserPrompt({ cwd: "/test", conversationId: active.id, sessionId: "s8" }, conversations));
		expect(titles().slice(0, 3)).toEqual(["会话8", "会话0", "会话9"]);
	});

	it("新建但未发送消息的会话追加到末尾，不因后台快照插到项目顶部", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const existing = { id: "existing", cwd: "/test", title: "已有会话", messageCount: 1, modified: 100 };
		const { container, rerender } = mountLeftPanel({ conversations: [existing] });
		rerender({
			conversations: [{ id: "created", cwd: "/test", title: "新会话", messageCount: 1, modified: 9999 }, existing],
		});
		expect(Array.from(container.querySelectorAll(".conv-title-text"), (node) => node.textContent)).toEqual([
			"已有会话",
			"新会话",
		]);
	});

	it("新建 CLI 对话在历史摘要尚未返回且没有 SDK 消息时仍显示在所属项目", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			conversations: [
				{
					id: "cli-new",
					cwd: "/test",
					title: "新建 CLI 对话",
					messageCount: 0,
					nativeCli: true,
					sessionFile: "/test/cli-new.jsonl",
				},
			],
			activeConversationId: "cli-new",
			projectSessions: { "/test": [] },
		});
		expect(container.querySelector(".lp-project-tree-children .conv-title-text")?.textContent).toBe("新建 CLI 对话");
		expect(container.querySelector(".lp-project-empty-tip")).toBeNull();
	});

	it("显示运行中 CLI 对话的运行状态指示、高亮样式与运行中计数", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, rerender } = mountLeftPanel({
			conversations: [
				{
					id: "cli-run",
					cwd: "/test",
					title: "运行中 CLI",
					messageCount: 0,
					nativeCli: {
						config: { preset: "agy" },
						terminalId: "term-1",
						status: { phase: "running", updatedAt: Date.now() },
					},
					sessionFile: "/test/cli-run.jsonl",
				},
			],
			activeConversationId: "other",
			projectSessions: { "/test": [] },
		});
		const item = container.querySelector(".lp-tree-session-item");
		expect(item?.classList.contains("is-running")).toBe(true);
		expect(container.querySelector(".status-spinner-right")).toBeTruthy();
		expect(container.querySelector(".native-cli-conversation-icon")?.classList.contains("is-running")).toBe(true);

		rerender({
			conversations: [
				{
					id: "cli-run",
					cwd: "/test",
					title: "等待输入 CLI",
					messageCount: 0,
					nativeCli: {
						config: { preset: "agy" },
						terminalId: "term-1",
						status: { phase: "waiting_input", updatedAt: Date.now() },
					},
					sessionFile: "/test/cli-run.jsonl",
				},
			],
			activeConversationId: "other",
			projectSessions: { "/test": [] },
		});
		expect(container.querySelector(".status-question-right")).toBeTruthy();
		expect(container.querySelector(".native-cli-conversation-icon")?.classList.contains("is-waiting")).toBe(true);

		rerender({
			conversations: [
				{
					id: "cli-run",
					cwd: "/test",
					title: "已退出 CLI",
					messageCount: 0,
					nativeCli: {
						config: { preset: "agy" },
						terminalId: "term-1",
						status: { phase: "exited", exitCode: 0, updatedAt: Date.now() },
					},
					sessionFile: "/test/cli-run.jsonl",
				},
			],
			activeConversationId: "other",
			projectSessions: { "/test": [] },
		});
		expect(container.querySelector(".status-spinner-right")).toBeNull();
		expect(container.querySelector(".native-cli-conversation-icon")?.classList.contains("is-exited")).toBe(true);
	});

	it("项目分隔线覆盖整个项目节点，仅出现在相邻项目之间", () => {
		const separator = CSS.match(/\.lp-project-node\s*\+\s*\.lp-project-node\s*\{([^}]*)\}/);
		expect(separator).toBeTruthy();
		expect(separator![1]).toMatch(/border-top:\s*1px solid var\(--border\)/);
		expect(separator![1]).toMatch(/padding-top:\s*[1-9]/);
	});

	it("工作区加号下拉菜单中包含新建当前项目对话选项，点击后发送 new_chat", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel();

		const plusBtn = container.querySelector<HTMLButtonElement>(".lp-section-actions .lp-project-action");
		expect(plusBtn).toBeTruthy();
		act(() => {
			plusBtn!.click();
		});

		const menu = container.querySelector(".lp-workspace-menu");
		expect(menu).toBeTruthy();
		const newChatBtn = menu?.querySelector<HTMLButtonElement>(".lp-new-chat-btn");
		expect(newChatBtn).toBeTruthy();
		expect(newChatBtn?.textContent).toContain("新建对话");

		act(() => {
			newChatBtn!.click();
		});
		expect(sent).toContainEqual({ type: "new_chat" });
	});
});
