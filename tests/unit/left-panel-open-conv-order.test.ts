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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

let root: Root | null = null;
afterEach(() => {
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
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
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, props),
			),
		);
	});
	return { container, sent };
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

	it("会话运行态杜绝使用背景色高亮与边框线，仅通过右侧转圈指示器体现", () => {
		const runningMatch = CSS.match(/\.lp-tree-session-item\.is-running\s*\{([^}]*)\}/);
		expect(runningMatch).toBeTruthy();
		expect(runningMatch![1]).toMatch(/background:\s*transparent/);
		expect(runningMatch![1]).toMatch(/box-shadow:\s*none/);

		const unreadMatch = CSS.match(/\.lp-tree-session-item\.is-unread\s*\{([^}]*)\}/);
		expect(unreadMatch).toBeTruthy();
		expect(unreadMatch![1]).toMatch(/box-shadow:\s*none/);
	});

	it("仅仅打开历史会话查看时，不进入顶部活动列表，保留在历史列表中并展示时间戳", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const historyTime = Date.now() - 3600000;
		const sessions = [
			{ path: "/test/session-new.jsonl", sessionId: "s-new", name: "最新会话", modified: Date.now() },
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "历史会话", modified: historyTime },
		];
		// 用户仅仅打开了 s-old 进行查看（后端已加载入内存 convs，但没有开始聊：非 streaming、非 question）
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

		// 检查渲染出来的会话列表
		const sessionRows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		expect(sessionRows.length).toBe(2);

		// 第一行应依然是最新会话（最新时间），第二行应是历史会话，打开操作没有颠倒其原本相对位置
		const titles = Array.from(sessionRows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles[0]).toBe("最新会话");
		expect(titles[1]).toBe("历史会话");

		// 历史会话行右侧应依然显示其时间戳，没有因为打开而消失
		const timeEl = sessionRows[1].querySelector(".conv-time");
		expect(timeEl).toBeTruthy();
		expect(timeEl?.textContent?.trim()).toBeTruthy();
	});

	it("只有在会话开始运行/交互（如流式输出）时，才将其提升到顶部活动列表", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [
			{ path: "/test/session-new.jsonl", sessionId: "s-new", name: "最新会话", modified: Date.now() },
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "历史会话", modified: Date.now() - 3600000 },
		];
		// 历史会话发起了提问，开始对话（isStreaming = true）
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

		// 开始对话后，历史会话被提到最顶部
		const titles = Array.from(sessionRows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles[0]).toBe("历史会话");
		expect(titles[1]).toBe("最新会话");

		// 并且第一行正在运行，带有流式 spinner 指示器，且运行中不显示时间戳（确保与无时间的新建会话圆圈对齐）
		expect(sessionRows[0].querySelector(".status-spinner-right")).toBeTruthy();
		expect(sessionRows[0].querySelector(".conv-time")).toBeNull();
		// 第二行未运行的历史会话正常显示时间戳
		expect(sessionRows[1].querySelector(".conv-time")).toBeTruthy();
	});

	it("所有运行中的对话（包括无修改时间的新建对话和有修改时间的老对话）均不显示时间，确保右侧圆圈完全对齐", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const sessions = [
			{ path: "/test/session-old.jsonl", sessionId: "s-old", name: "老对话", modified: Date.now() - 3600000 },
			{ path: "/test/session-idle.jsonl", sessionId: "s-idle", name: "闲置对话", modified: Date.now() - 7200000 },
		];
		const conversations = [
			// 新建对话：无 sessionFile，无 modified 时间，正在运行
			{
				id: "c-new",
				cwd: "/test",
				title: "新建对话",
				messageCount: 1,
				isStreaming: true,
				isSubagent: false,
			},
			// 老对话：有 sessionFile，有 modified 时间，正在运行
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
		// 正在运行的两个对话（c-new 和 c-old）带有 spinner
		const runningSpinners = container.querySelectorAll(".lp-project-tree-children .status-spinner-right");
		expect(runningSpinners.length).toBe(2);

		// 所有运行中的对话都不显示时间，圆圈位于最右侧统一对齐
		const newConvTime = rows[0].querySelector(".conv-time");
		const oldConvTime = rows[1].querySelector(".conv-time");
		expect(newConvTime).toBeNull();
		expect(oldConvTime).toBeNull();

		// 闲置的历史会话正常显示时间戳
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

		// 标志统一放置在右侧元数据区（.conv-meta-zone），左侧标题区（.conv-title-text）不残留任何前置标志
		expect(badge?.closest(".conv-meta-zone")).toBeTruthy();
		expect(container.querySelector(".conv-title-text .ephemeral-badge")).toBeNull();

		// 置顶标志也统一放置在右侧元数据区
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

		// 两个项目初始时，/proj1 作为当前项目已展开
		const nodes = container.querySelectorAll(".lp-project-node");
		expect(nodes.length).toBe(2);

		// 点击 /proj2 的 chevron 展开 /proj2
		const proj2Chevron = nodes[1].querySelector<HTMLElement>(".lp-project-chevron");
		expect(proj2Chevron).toBeTruthy();
		act(() => proj2Chevron!.click());

		// 检查两个项目的头部：proj1 仍保持展开（is-expanded），proj2 也展开（is-expanded）
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

		// 左侧不应该再出现 project-icon spin 元素挤占项目名
		const leftSpinner = projectHeader!.querySelector(".project-icon.spin");
		expect(leftSpinner).toBeNull();

		// 右侧 conv-meta-zone 内部必须包含与会话状态完全相同的 status-spinner-right 等待圆圈
		const metaZone = projectHeader!.querySelector(".conv-meta-zone");
		expect(metaZone).toBeTruthy();
		const rightSpinner = metaZone!.querySelector(".status-spinner-right");
		expect(rightSpinner).toBeTruthy();

		// 进度百分比必须在右侧元数据区内与 spinner 协同展示
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

		// 初始展开状态下包含 expanded
		const collapsible = container.querySelector(".lp-history-collapsible");
		expect(collapsible).toBeTruthy();
		expect(collapsible?.classList.contains("expanded")).toBe(true);

		// 点击折叠
		act(() => chevron!.click());

		// 折叠后，子节点仍然驻留 DOM，但带有 collapsed 类以执行 CSS Grid 平滑收缩过渡，杜绝瞬间卸载
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
		// 两个都在运行中的会话，c-1 的最后修改时间比 c-2 新
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

		// 用户点击打开任务 2（activeConversationId 变为 c-2）
		const { container } = mountLeftPanel({
			conversations,
			activeConversationId: "c-2",
		});

		const rows = container.querySelectorAll(".lp-project-tree-children .lp-row");
		expect(rows.length).toBe(2);

		// 虽然 c-2 是激活状态，但因为没有发送新消息产生更新的时间戳，列表不应颠倒移动，c-1 依然排第一位
		const titles = Array.from(rows).map((r) => r.querySelector(".conv-title-text")?.textContent?.trim());
		expect(titles[0]).toBe("任务 1（较新）");
		expect(titles[1]).toBe("任务 2（较旧）");
	});

	it("工作区加号下拉菜单中包含新建当前项目对话选项，点击后发送 new_chat", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel();

		// 打开加号菜单
		const plusBtn = container.querySelector<HTMLButtonElement>(".lp-section-actions .lp-project-action");
		expect(plusBtn).toBeTruthy();
		act(() => {
			plusBtn!.click();
		});

		// 检查菜单内的新建对话按钮
		const menu = container.querySelector(".lp-workspace-menu");
		expect(menu).toBeTruthy();
		const newChatBtn = menu?.querySelector<HTMLButtonElement>(".lp-new-chat-btn");
		expect(newChatBtn).toBeTruthy();
		expect(newChatBtn?.textContent).toContain("新建对话");

		// 点击新建对话
		act(() => {
			newChatBtn!.click();
		});
		expect(sent).toContainEqual({ type: "new_chat" });
	});
});
