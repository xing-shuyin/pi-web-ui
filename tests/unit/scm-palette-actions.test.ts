import { describe, expect, it, vi } from "vitest";
import {
	buildScmPaletteActions,
	type ScmPaletteContext,
	type ScmPaletteHandlers,
	type ScmPaletteStatus,
} from "../../web/src/scm-palette-actions.js";
import type { Translate } from "../../web/src/i18n.js";

/**
 * Git 操作面板（⌘⇧G）动作表守卫。
 *
 * 面板是"唯一入口"，所以两件事必须钉死：分组顺序稳定（否则肌肉记忆失效），
 * 以及禁用条件跟着仓库状态走（否则点下去才发现不行，等于回到那个平铺菜单）。
 */

// 假 t：直接回 key，断言里就能读到 key 名，不用维护一份翻译。
const t = ((key: string) => key) as unknown as Translate;

function handlers(): ScmPaletteHandlers {
	return {
		pull: vi.fn(),
		push: vi.fn(),
		fetch: vi.fn(),
		branchCreate: vi.fn(),
		branchRename: vi.fn(),
		branchCheckout: vi.fn(),
		commit: vi.fn(),
		commitAll: vi.fn(),
		amend: vi.fn(),
		genMessage: vi.fn(),
		stageAll: vi.fn(),
		unstageAll: vi.fn(),
		stashSave: vi.fn(),
		stashOpen: vi.fn(),
		discardSelected: vi.fn(),
		toggleBlame: vi.fn(),
		openTerminal: vi.fn(),
		refresh: vi.fn(),
		createTag: vi.fn(),
		pushTags: vi.fn(),
	};
}

const cleanStatus: ScmPaletteStatus = {
	branch: "main",
	detached: false,
	upstream: "origin/main",
	ahead: 0,
	behind: 0,
	upstreamGone: false,
};

function context(patch: Partial<ScmPaletteContext> = {}): ScmPaletteContext {
	return {
		t,
		notRepo: false,
		status: cleanStatus,
		branches: [
			{ name: "main", current: true },
			{ name: "feat/scm", current: false },
			{ name: "origin/main", current: false, remote: "origin" },
		],
		fileCount: 3,
		stagedCount: 2,
		commitMsg: "feat(scm): 分组暂存",
		selectedPath: "web/src/components/SCMPanel.tsx",
		showBlame: false,
		handlers: handlers(),
		...patch,
	};
}

const byId = (actions: ReturnType<typeof buildScmPaletteActions>, id: string) => {
	const found = actions.find((a) => a.id === id);
	if (!found) throw new Error(`missing action ${id}`);
	return found;
};

describe("buildScmPaletteActions", () => {
	it("分组顺序固定：同步 → 分支 → 提交 → 更改 → 查看 → 远端", () => {
		const actions = buildScmPaletteActions(context());
		const seen: string[] = [];
		for (const action of actions) if (seen[seen.length - 1] !== action.group) seen.push(action.group);
		expect(seen).toEqual([
			"scmGroupSync",
			"scmGroupBranch",
			"scmPaletteCheckout",
			"scmGroupCommit",
			"scmGroupChange",
			"scmGroupView",
			"scmGroupRemote",
		]);
	});

	it("每个动作都有唯一 id（React key 与搜索定位都靠它）", () => {
		const ids = buildScmPaletteActions(context()).map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("提交：没写信息 / 没暂存文件时不可点", () => {
		const none = context({ commitMsg: "", stagedCount: 0 });
		expect(byId(buildScmPaletteActions(none), "commit.staged").disabled).toBe(true);
		const ready = buildScmPaletteActions(context({ stagedCount: 1 }));
		expect(byId(ready, "commit.staged").disabled).toBe(false);
		expect(byId(ready, "commit.staged").badge).toBe("1");
	});

	it("同步：没上游时 pull/push 不可点，fetch 仍可用", () => {
		const actions = buildScmPaletteActions(context({ status: { ...cleanStatus, upstream: null } }));
		expect(byId(actions, "sync.pull").disabled).toBe(true);
		expect(byId(actions, "sync.push").disabled).toBe(true);
		expect(byId(actions, "sync.fetch").disabled).toBe(false);
	});

	it("同步：ahead / behind 落到 badge，0 时不显示", () => {
		const diverged = buildScmPaletteActions(context({ status: { ...cleanStatus, ahead: 2, behind: 1 } }));
		expect(byId(diverged, "sync.push").badge).toBe("↑2");
		expect(byId(diverged, "sync.pull").badge).toBe("↓1");
		const clean = buildScmPaletteActions(context());
		expect(byId(clean, "sync.push").badge).toBeUndefined();
	});

	it("切换分支：当前分支不可点，点击带上分支名", () => {
		const ctx = context();
		const actions = buildScmPaletteActions(ctx);
		expect(byId(actions, "branch.checkout.main").disabled).toBe(true);
		expect(byId(actions, "branch.checkout.feat/scm").disabled).toBe(false);
		byId(actions, "branch.checkout.feat/scm").run();
		expect(ctx.handlers.branchCheckout).toHaveBeenCalledWith("feat/scm");
	});

	it("分支超过 30 个只列前 30（其余走切分支下拉）", () => {
		const branches = Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, current: false }));
		const actions = buildScmPaletteActions(context({ branches }));
		expect(actions.filter((a) => a.group === "scmPaletteCheckout")).toHaveLength(30);
	});

	it("没选中文件时不出现「放弃所选文件」，选中时出现且是危险色", () => {
		const none = buildScmPaletteActions(context({ selectedPath: null }));
		expect(none.some((a) => a.id === "change.discard-selected")).toBe(false);
		const picked = buildScmPaletteActions(context());
		expect(byId(picked, "change.discard-selected").tone).toBe("danger");
		// 没选中时 blame 也不可点
		expect(byId(none, "view.blame").disabled).toBe(true);
	});

	it("stash 两个变体分别传 false / true", () => {
		const ctx = context();
		const actions = buildScmPaletteActions(ctx);
		byId(actions, "change.stash").run();
		byId(actions, "change.stash-untracked").run();
		expect(ctx.handlers.stashSave).toHaveBeenNthCalledWith(1, false);
		expect(ctx.handlers.stashSave).toHaveBeenNthCalledWith(2, true);
	});

	it("非 Git 仓库时写操作全禁用", () => {
		const actions = buildScmPaletteActions(context({ notRepo: true, status: null, fileCount: 0, stagedCount: 0 }));
		for (const id of [
			"sync.pull",
			"sync.push",
			"commit.staged",
			"commit.all",
			"change.stage-all",
			"remote.tag-create",
		]) {
			expect(byId(actions, id).disabled, id).toBe(true);
		}
		expect(byId(actions, "view.terminal").disabled).toBe(false);
	});

	it("detached HEAD 时分支重命名禁用；删除当前分支不进面板（git 也不允许）", () => {
		const actions = buildScmPaletteActions(context({ status: { ...cleanStatus, detached: true } }));
		expect(byId(actions, "branch.rename").disabled).toBe(true);
		expect(actions.some((a) => a.id === "branch.delete")).toBe(false);
	});

	it("推送标签不要求当前分支有 upstream，有远端分支就允许", () => {
		const noUpstream = buildScmPaletteActions(
			context({
				status: { ...cleanStatus, upstream: null },
				branches: [
					{ name: "main", current: true },
					{ name: "origin/main", current: false, remote: "origin" },
				],
			}),
		);
		expect(byId(noUpstream, "remote.tag-push").disabled).toBe(false);
		const noRemote = buildScmPaletteActions(
			context({ status: { ...cleanStatus, upstream: null }, branches: [{ name: "main", current: true }] }),
		);
		expect(byId(noRemote, "remote.tag-push").disabled).toBe(true);
	});
});
