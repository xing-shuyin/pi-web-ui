/**
 * Git 操作面板（⌘⇧G）的动作表：把原本平铺在「更多」菜单里的十几项收成可搜索的分组条目。
 *
 * 这里只做"有哪些动作、什么时候不可点"的判断，不碰 DOM、不发命令：真正执行走传入的 handlers。
 * 好处是这份表可以被单测直接覆盖（禁用条件、分组顺序、badge 文案），SCMPanel 只负责接线。
 */
import type { Translate } from "./i18n";

export interface ScmPaletteAction {
	id: string;
	group: string;
	label: string;
	hint?: string;
	badge?: string;
	tone?: "danger";
	disabled?: boolean;
	run: () => void;
}

export interface ScmPaletteStatus {
	branch: string;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	upstreamGone: boolean;
}

export interface ScmPaletteBranch {
	name: string;
	current: boolean;
	remote?: string | boolean;
}

export interface ScmPaletteHandlers {
	pull: () => void;
	push: () => void;
	fetch: () => void;
	branchCreate: () => void;
	branchRename: () => void;
	branchCheckout: (name: string) => void;
	commit: () => void;
	commitAll: () => void;
	amend: () => void;
	genMessage: () => void;
	stageAll: () => void;
	unstageAll: () => void;
	stashSave: (includeUntracked: boolean) => void;
	stashOpen: () => void;
	discardSelected: () => void;
	toggleBlame: () => void;
	openTerminal: () => void;
	refresh: () => void;
	createTag: () => void;
	pushTags: () => void;
}

export interface ScmPaletteContext {
	t: Translate;
	notRepo: boolean;
	status: ScmPaletteStatus | null;
	branches: readonly ScmPaletteBranch[];
	fileCount: number;
	stagedCount: number;
	commitMsg: string;
	selectedPath: string | null;
	showBlame: boolean;
	handlers: ScmPaletteHandlers;
}

/** 分支多的时候不做"全部塞进面板"：超出部分靠搜索以外的入口（切分支下拉）解决。 */
const MAX_BRANCH_ACTIONS = 30;

export function buildScmPaletteActions(ctx: ScmPaletteContext): ScmPaletteAction[] {
	const { t, status, handlers: h, notRepo } = ctx;
	const hasUpstream = !!status?.upstream && !status.upstreamGone;
	const detached = !!status?.detached;
	const hasMsg = ctx.commitMsg.trim().length > 0;
	const out: ScmPaletteAction[] = [];

	const sync = t("scmGroupSync");
	out.push(
		{
			id: "sync.pull",
			group: sync,
			label: t("scmPull"),
			hint: "git pull",
			badge: status && status.behind > 0 ? `↓${status.behind}` : undefined,
			disabled: notRepo || !hasUpstream || detached,
			run: h.pull,
		},
		{
			id: "sync.push",
			group: sync,
			label: t("scmPush"),
			hint: "git push",
			badge: status && status.ahead > 0 ? `↑${status.ahead}` : undefined,
			disabled: notRepo || !hasUpstream || detached,
			run: h.push,
		},
		{
			id: "sync.fetch",
			group: sync,
			label: t("scmPaletteFetchAll"),
			hint: "git fetch --all --prune",
			disabled: notRepo,
			run: h.fetch,
		},
	);

	const branch = t("scmGroupBranch");
	out.push(
		{
			id: "branch.create",
			group: branch,
			label: t("scmBranchNew"),
			hint: "git checkout -b <name>",
			disabled: notRepo,
			run: h.branchCreate,
		},
		{
			id: "branch.rename",
			group: branch,
			label: t("scmBranchRename"),
			hint: "git branch -m <name>",
			disabled: notRepo || detached || !status?.branch,
			run: h.branchRename,
		},
	);

	const checkout = branchActions(ctx, Math.min(ctx.branches.length, MAX_BRANCH_ACTIONS));
	out.push(...checkout);

	const commit = t("scmGroupCommit");
	out.push(
		{
			id: "commit.staged",
			group: commit,
			label: t("scmCommit"),
			hint: 'git commit -m "…"',
			badge: ctx.stagedCount > 0 ? String(ctx.stagedCount) : undefined,
			disabled: notRepo || !hasMsg || ctx.stagedCount === 0,
			run: h.commit,
		},
		{
			id: "commit.all",
			group: commit,
			label: t("scmCommitAll"),
			hint: "git add -A && git commit",
			disabled: notRepo || !hasMsg || ctx.fileCount === 0,
			run: h.commitAll,
		},
		{
			id: "commit.amend",
			group: commit,
			label: t("scmAmend"),
			hint: "git commit --amend",
			disabled: notRepo,
			run: h.amend,
		},
		{
			id: "commit.generate",
			group: commit,
			label: t("scmGenMsg"),
			disabled: notRepo,
			run: h.genMessage,
		},
	);

	const change = t("scmGroupChange");
	out.push(
		{
			id: "change.stage-all",
			group: change,
			label: t("scmStageAll"),
			hint: "git add -A",
			disabled: notRepo || ctx.fileCount === 0,
			run: h.stageAll,
		},
		{
			id: "change.unstage-all",
			group: change,
			label: t("scmUnstageAll"),
			hint: "git reset HEAD",
			disabled: notRepo || ctx.stagedCount === 0,
			run: h.unstageAll,
		},
		{
			id: "change.stash",
			group: change,
			label: t("scmStashSave"),
			hint: "git stash push",
			disabled: notRepo,
			run: () => h.stashSave(false),
		},
		{
			id: "change.stash-untracked",
			group: change,
			label: t("scmStashIncludeUntracked"),
			hint: "git stash push -u",
			disabled: notRepo,
			run: () => h.stashSave(true),
		},
		{
			id: "change.stash-open",
			group: change,
			label: t("scmStashOpenList"),
			disabled: notRepo,
			run: h.stashOpen,
		},
	);
	if (ctx.selectedPath) {
		out.push({
			id: "change.discard-selected",
			group: change,
			label: t("scmDiscardSelected"),
			hint: ctx.selectedPath,
			tone: "danger",
			disabled: notRepo,
			run: h.discardSelected,
		});
	}

	const view = t("scmGroupView");
	out.push(
		{
			id: "view.blame",
			group: view,
			label: ctx.showBlame ? t("scmBlameHide") : t("scmBlameShow"),
			hint: ctx.selectedPath ?? undefined,
			disabled: notRepo || !ctx.selectedPath,
			run: h.toggleBlame,
		},
		{
			id: "view.terminal",
			group: view,
			label: t("scmViewTerminal"),
			disabled: false,
			run: h.openTerminal,
		},
		{
			id: "view.refresh",
			group: view,
			label: t("bgTaskRefresh"),
			hint: t("scmRefreshTip"),
			disabled: false,
			run: h.refresh,
		},
	);

	const remote = t("scmGroupRemote");
	out.push(
		{
			id: "remote.tag-create",
			group: remote,
			label: t("scmTagCreate"),
			hint: "git tag <name>",
			disabled: notRepo,
			run: h.createTag,
		},
		{
			id: "remote.tag-push",
			group: remote,
			label: t("scmTagPush"),
			hint: "git push --tags",
			// `git push --tags` 不需要当前分支有 upstream（只排到 remote）：有远端分支就允许，
			// 否则没上游的仓库里标签永远推不了。真推失败仍在终端里看得见。
			disabled: notRepo || !(status?.upstream || ctx.branches.some((b) => b.remote)),
			run: h.pushTags,
		},
	);

	return out;
}

function branchActions(ctx: ScmPaletteContext, limit: number): ScmPaletteAction[] {
	const { t, handlers: h } = ctx;
	const group = t("scmPaletteCheckout");
	return ctx.branches.slice(0, limit).map((b) => ({
		id: `branch.checkout.${b.name}`,
		group,
		label: b.name,
		hint: b.remote ? t("scmPaletteRemote") : t("scmPaletteLocal"),
		badge: b.current ? t("scmPaletteCurrent") : undefined,
		disabled: ctx.notRepo || b.current,
		run: () => h.branchCheckout(b.name),
	}));
}

const ASCII_QUERY = /^[\x20-\x7e]+$/;

/**
 * 面板搜索：label / hint / group / id 都入选，但 id 是开发者键（`commit.staged`），
 * 直接子串匹配会让搜 `tag` 命中 `sTAGed`、搜 `stage` 命中 `staged`，把无关行摆到眼前。
 *
 * 所以 ASCII 查询按词边界匹配（前一字符不能是字母数字），中文查询仍用子串——
 * 中文没有词边界，“全部暂存”里搜“暂存”必须能命中。
 */
export function matchesScmPaletteAction(action: ScmPaletteAction, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const hay = `${action.label} ${action.hint ?? ""} ${action.group} ${action.id}`.toLowerCase();
	if (!ASCII_QUERY.test(q)) return hay.includes(q);
	for (let from = 0; ;) {
		const at = hay.indexOf(q, from);
		if (at < 0) return false;
		const prev = at === 0 ? "" : hay[at - 1];
		if (!/[a-z0-9]/.test(prev)) return true;
		from = at + 1;
	}
}
