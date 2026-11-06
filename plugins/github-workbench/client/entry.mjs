import { esc, hostApi } from "@pi-web-ui/plugin-sdk/client";
import { CSS } from "./styles.mjs";

export function resolveApiBase(url) {
	const parsed = new URL(url);
	const index = parsed.pathname.indexOf("/plugins/");
	return `${parsed.origin}${index < 0 ? "" : parsed.pathname.slice(0, index)}/plugins-api/github-workbench`;
}

const API = resolveApiBase(import.meta.url);
const FILTERS = [
	["repository", "仓库待办"],
	["review-requested", "待我评审"],
	["assigned", "分配给我"],
	["authored", "我创建的"],
	["mentioned", "提到我的"],
	["custom", "自定义搜索"],
];
const KINDS = [
	["all", "全部"],
	["pr", "PR"],
	["issue", "Issue"],
];
const PATHS = {
	github:
		'<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
	repo: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 3H20v19H6.5A2.5 2.5 0 0 1 4 19.5v-14A2.5 2.5 0 0 1 6.5 3Z"/><path d="M8 7h8M8 11h5"/>',
	pr: '<circle cx="6" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="M6 8v13M18 16V8a3 3 0 0 0-3-3h-3m3-3-3 3 3 3"/>',
	issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
	inbox: '<path d="M4 4h16l2 11v5H2v-5L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
	refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3l1 3M4 12l1 3a8 8 0 0 0 13 3"/>',
	search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
	filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
	arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
	back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
	left: '<path d="m14 6-6 6 6 6"/>',
	right: '<path d="m10 6 6 6-6 6"/>',
	external: '<path d="M15 3h6v6m0-6L10 14M9 3H3v18h18v-6"/>',
	comment: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2-5A8.5 8.5 0 1 1 21 11.5Z"/>',
	quote: '<path d="M9 5H3v7h6V5Zm12 0h-6v7h6V5ZM9 12c0 4-2 6-5 7m17-7c0 4-2 6-5 7"/>',
	spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (name) =>
	`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? PATHS.inbox}</svg>`;
const key = (item) => `${item.repo}#${item.number}`;
const stateLabel = (item) => (item.pr?.merged ? "已合并" : item.state === "open" ? "进行中" : "已关闭");
const empty = (title, hint = "", name = "inbox") =>
	`<div class="empty"><span class="empty-icon">${icon(name)}</span><strong>${esc(title)}</strong>${hint ? `<span>${esc(hint)}</span>` : ""}</div>`;
function shortDate(value) {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? String(value ?? "")
		: date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function buildReference(item) {
	const label = `${item.kind === "pr" ? "PR" : "Issue"} #${item.number}`;
	const referenceKey = `github:${item.repo}#${item.number}`;
	return {
		path: "",
		name: label,
		mode: "quote",
		key: referenceKey,
		quote: { text: `${label} · ${item.repo}\n${item.url}`, messageId: referenceKey, role: "github" },
	};
}

export function createWorkbench() {
	let saved = null;
	let pendingMutation = null;
	let mutationNotice = null;
	const draftComments = new Map();
	return {
		mount(container) {
			const root = container.shadowRoot ?? container.attachShadow({ mode: "open" });
			root.innerHTML = `<style>${CSS}</style><div class="app" data-view="list">
				<header class="header"><span class="brand">${icon("github")}</span><div class="heading"><h1>GitHub 工作台</h1><div class="account" data-account><span>正在连接…</span></div></div><button type="button" class="icon-button refresh" data-action="refresh" title="刷新待办" aria-label="刷新待办">${icon("refresh")}</button></header>
				<form class="toolbar" aria-label="GitHub 待办筛选">
					<div class="input-field">${icon("repo")}<input name="repo" aria-label="仓库" placeholder="owner/repo · 留空查看个人待办" maxlength="200" spellcheck="false"><button type="submit" class="icon-button" title="加载仓库" aria-label="加载仓库">${icon("arrow")}</button></div>
					<div class="filter-line"><div class="input-field filter-field">${icon("filter")}<select name="filter" aria-label="待办分类">${FILTERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></div><button type="button" class="icon-button search-toggle" data-action="search" aria-label="展开搜索条件" aria-expanded="false" aria-controls="gh-search">${icon("search")}</button></div>
					<div class="input-field search-field" id="gh-search" hidden>${icon("search")}<input name="q" aria-label="搜索条件" placeholder="搜索标题、label:bug…" maxlength="1000"><button type="submit" class="icon-button" title="搜索" aria-label="搜索">${icon("arrow")}</button></div>
				</form>
				<div class="kind-tabs" role="group" aria-label="待办类型">${KINDS.map(([value, label]) => `<button type="button" class="kind-tab" data-kind="${value}" aria-pressed="${value === "all"}">${icon(value === "all" ? "inbox" : value)}${label}</button>`).join("")}</div>
				<div class="status" role="status" aria-live="polite"></div>
				<div class="workspace"><div class="inbox" aria-label="待办列表">${empty("正在加载待办", "正在连接你的 GitHub 账号")}</div><div class="detail" aria-label="待办详情">${empty("选择一条待办", "查看详情、参与讨论，或交给 AI 处理")}</div></div>
			</div>`;
			const app = root.querySelector(".app");
			const form = root.querySelector(".toolbar");
			const inbox = root.querySelector(".inbox");
			const detail = root.querySelector(".detail");
			const status = root.querySelector(".status");
			const account = root.querySelector("[data-account]");
			const refresh = root.querySelector('[data-action="refresh"]');
			const controllers = new Set();
			let disposed = false;
			let listEpoch = 0;
			let detailEpoch = 0;
			let items = saved?.loadingList ? [] : (saved?.items ?? []);
			let selected = saved?.selected ?? null;
			let page = saved?.page ?? 1;
			let hasMore = saved?.hasMore ?? false;
			let total = saved?.loadingList ? 0 : (saved?.total ?? 0);
			let loadingList = false;
			let mutation = Boolean(pendingMutation);
			let connected = false;
			let initialized = saved?.initialized ?? false;
			let query = saved?.query ?? null;
			let listScroll = saved?.listScroll ?? 0;
			let detailScroll = saved?.detailScroll ?? 0;
			let kind = saved?.kind ?? "all";
			let searchOpen = saved?.searchOpen ?? false;
			for (const name of ["repo", "filter", "q"]) if (saved?.form) form.elements[name].value = saved.form[name];

			function message(value, error = false) {
				if (disposed) return;
				status.textContent = value;
				status.classList.toggle("error", error);
			}
			function syncControls() {
				for (const button of root.querySelectorAll("[data-kind]"))
					button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
				root.querySelector(".search-field").hidden = !searchOpen;
				root.querySelector('[data-action="search"]').setAttribute("aria-expanded", String(searchOpen));
			}
			const visible = (element) => element.getClientRects().length > 0;
			function rememberScroll() {
				if (visible(inbox)) listScroll = inbox.scrollTop;
				if (visible(detail)) detailScroll = detail.scrollTop;
			}
			function restoreScroll() {
				if (visible(inbox)) inbox.scrollTop = listScroll;
				if (visible(detail)) detail.scrollTop = detailScroll;
			}
			function showView(view, remember = true) {
				if (remember) rememberScroll();
				app.dataset.view = view;
				restoreScroll();
			}
			async function request(path, body) {
				const controller = new AbortController();
				if (body === undefined) controllers.add(controller);
				const timer = setTimeout(() => controller.abort(), 60000);
				try {
					const response = await fetch(`${API}${path}`, {
						method: body === undefined ? "GET" : "POST",
						headers: body === undefined ? {} : { "Content-Type": "application/json" },
						body: body === undefined ? undefined : JSON.stringify(body),
						signal: controller.signal,
					});
					const result = await response.json();
					if (!response.ok || !result.ok) throw new Error(result.error || `请求失败 (${response.status})`);
					return result;
				} finally {
					clearTimeout(timer);
					controllers.delete(controller);
				}
			}
			function saveDraft() {
				const input = detail.querySelector("textarea");
				if (selected && input) {
					if (input.value) draftComments.set(key(selected), input.value);
					else draftComments.delete(key(selected));
				}
			}
			function renderList(remember = true) {
				if (remember && visible(inbox)) listScroll = inbox.scrollTop;
				inbox.innerHTML =
					`<div class="list-heading"><span><strong>待办</strong><span class="count">${total}</span></span><span class="sort-label">${icon("clock")}最近更新</span></div>` +
					(items.length
						? items
								.map((item, index) => {
									const active = Boolean(selected && key(item) === key(selected));
									return `<button type="button" class="row${active ? " selected" : ""}" data-index="${index}" aria-pressed="${active}"><span class="item-icon${item.state === "open" ? "" : " closed"}" title="${stateLabel(item)}">${icon(item.kind)}</span><span class="row-body"><span class="row-repo"><span class="repo-name">${esc(item.repo)}</span><span class="item-number">#${item.number}</span></span><div class="row-title">${esc(item.title)}</div><span class="row-footer"><span class="author">@${esc(item.author)}</span><time title="${esc(item.updatedAt)}">${esc(shortDate(item.updatedAt))}</time><span class="comment-count" aria-label="${item.commentCount} 条评论">${icon("comment")}${item.commentCount}</span></span>${
										item.labels.length
											? `<span class="labels">${item.labels
													.slice(0, 3)
													.map((label) => `<span class="tag">${esc(label)}</span>`)
													.join(
														"",
													)}${item.labels.length > 3 ? `<span class="hint">+${item.labels.length - 3}</span>` : ""}</span>`
											: ""
									}</span></button>`;
								})
								.join("")
						: empty("暂时没有待办", "换个分类，或试试其他搜索条件"));
				if (items.length || page > 1)
					inbox.insertAdjacentHTML(
						"beforeend",
						`<div class="page"><button type="button" data-action="prev" title="上一页" aria-label="上一页" ${page <= 1 || loadingList ? "disabled" : ""}>${icon("left")}</button><span>第 ${page} 页 · ${total} 条待办</span><button type="button" data-action="next" title="下一页" aria-label="下一页" ${!hasMore || loadingList ? "disabled" : ""}>${icon("right")}</button></div>`,
					);
				if (visible(inbox)) inbox.scrollTop = listScroll;
			}
			function detailNav(item) {
				return `<div class="detail-nav"><button type="button" class="back" data-action="back">${icon("back")}返回列表</button>${item ? `<a class="url" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">GitHub ${icon("external")}</a>` : ""}</div>`;
			}
			function renderDetail(item) {
				const pr = item.pr;
				detail.innerHTML = `${detailNav(item)}<div class="meta"><span class="tag state-tag${item.state === "open" ? "" : " closed"}">${icon(item.kind)}${stateLabel(item)}</span><span>${item.kind === "pr" ? "PR" : "Issue"} #${item.number}</span></div><h2>${esc(item.title)}</h2><div class="detail-author">${esc(item.repo)} · @${esc(item.author)} · ${esc(shortDate(item.updatedAt))} 更新</div>
					<div class="actions"><button type="button" data-action="process" class="primary">${icon("spark")}交给 AI 处理</button><button type="button" data-action="quote" class="quote" title="引用到对话" aria-label="引用到对话">${icon("quote")}</button><button type="button" data-action="state" class="state-action" ${pr?.merged ? "disabled" : ""}>${item.state === "open" ? "关闭" : "重新打开"}</button></div>
					${pr ? `<div class="summary"><div class="branches">${icon("pr")}<span>${esc(pr.head)}</span>${icon("arrow")}<span>${esc(pr.base)}</span>${pr.draft ? '<span class="tag">草稿</span>' : ""}</div><div>${pr.changedFiles} 个文件 · <span class="diff-added">+${pr.additions}</span> / <span class="diff-deleted">−${pr.deletions}</span></div><div class="hint">合并状态 ${esc(pr.mergeableState ?? "计算中")} · 待评审 ${esc(pr.reviewers.join(", ") || "无指定评审人")}</div><div class="hint">完整 diff、CI 与代码行评审可在 GitHub 查看。</div></div>` : ""}
					${item.labels.length ? `<div class="labels">${item.labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("")}</div>` : ""}<div class="content">${esc(item.body || "（无正文）")}</div><h3 class="section-title">${icon("comment")}讨论<span class="count">${item.commentCount}</span></h3>
					${item.commentsTruncated ? '<p class="hint">仅显示最近一页评论，完整讨论可在 GitHub 查看。</p>' : ""}${item.comments.map((comment) => `<div class="comment"><div class="comment-author"><span class="avatar" aria-hidden="true">${esc(comment.author?.slice(0, 1).toUpperCase() || "?")}</span><span>@${esc(comment.author)}</span><span class="hint">${esc(shortDate(comment.createdAt))}</span></div><div class="content">${esc(comment.body)}</div></div>`).join("") || '<div class="hint">还没有评论，来开启讨论。</div>'}
					<form class="comment-form"><label for="gh-comment">发表评论</label><textarea id="gh-comment" name="comment" maxlength="60000" placeholder="分享你的想法，支持 Markdown">${esc(draftComments.get(key(item)) ?? "")}</textarea><div class="actions"><span class="comment-target">发布到 #${item.number}</span><button type="submit" class="primary">发布评论 ${icon("arrow")}</button></div></form>`;
				setMutationDisabled();
			}
			function setMutationDisabled() {
				for (const element of detail.querySelectorAll(
					'button[data-action="state"], .comment-form button, .comment-form textarea',
				))
					element.disabled = mutation || (element.dataset.action === "state" && Boolean(selected?.pr?.merged));
			}
			async function loadItems(targetPage = 1, captureFilters = true, preserveSelection = false) {
				query =
					captureFilters || !query
						? {
								repo: form.elements.repo.value.trim(),
								filter: form.elements.filter.value,
								q: [form.elements.q.value.trim(), kind === "all" ? "" : `is:${kind}`].filter(Boolean).join(" "),
								page: targetPage,
							}
						: { ...query, page: targetPage };
				const requestedQuery = query;
				const epoch = ++listEpoch;
				loadingList = true;
				refresh.setAttribute("aria-busy", "true");
				saveDraft();
				if (!preserveSelection) {
					selected = null;
					++detailEpoch;
					showView("list");
					detail.innerHTML = empty("选择一条待办", "查看详情、参与讨论，或交给 AI 处理");
					listScroll = 0;
					inbox.scrollTop = 0;
				}
				message("");
				if (!items.length) inbox.innerHTML = empty("正在加载待办", "马上就好");
				else renderList();
				try {
					const result = await request(
						`/items?${new URLSearchParams({ ...requestedQuery, page: String(requestedQuery.page) })}`,
					);
					if (disposed || epoch !== listEpoch) return;
					items = result.items;
					page = result.page;
					query = { ...requestedQuery, page };
					hasMore = result.hasMore;
					total = result.total;
					message(result.incomplete ? "搜索结果不完整，可缩小条件后重试。" : "");
				} catch (error) {
					if (disposed || epoch !== listEpoch) return;
					items = [];
					hasMore = false;
					total = 0;
					message(error.message, true);
				} finally {
					if (!disposed && epoch === listEpoch) {
						loadingList = false;
						refresh.setAttribute("aria-busy", "false");
						renderList();
					}
				}
			}
			async function openItem(item, preserveDraft = true) {
				if (preserveDraft) saveDraft();
				const epoch = ++detailEpoch;
				selected = item;
				renderList();
				showView("detail");
				detailScroll = 0;
				detail.scrollTop = 0;
				detail.innerHTML = detailNav(item) + empty("正在加载详情", "获取正文与最近讨论");
				try {
					const result = await request(
						`/detail?${new URLSearchParams({ repo: item.repo, number: String(item.number) })}`,
					);
					if (disposed || epoch !== detailEpoch) return;
					selected = result.item;
					renderDetail(selected);
				} catch (error) {
					if (disposed || epoch !== detailEpoch) return;
					selected = null;
					renderList();
					detail.innerHTML = detailNav() + empty("详情加载失败", "返回列表后点击条目重试");
					message(error.message, true);
				}
			}
			async function connect(restore = false) {
				refresh.setAttribute("aria-busy", "true");
				try {
					const result = await request("/status");
					if (disposed) return;
					connected = true;
					account.classList.add("connected");
					account.querySelector("span").textContent = `@${result.login}`;
					account.title = "使用服务所在机器的 GitHub CLI 登录";
					if (!initialized) {
						initialized = true;
						if (!form.elements.repo.value && result.repo) form.elements.repo.value = result.repo;
						if (!form.elements.repo.value) form.elements.filter.value = "review-requested";
					}
					await loadItems(restore ? (query?.page ?? 1) : 1, !restore, restore);
				} catch (error) {
					if (disposed) return;
					connected = false;
					refresh.setAttribute("aria-busy", "false");
					account.classList.remove("connected");
					account.querySelector("span").textContent = "尚未连接 GitHub";
					message(error.message, true);
					inbox.innerHTML = `<div class="help"><h2>连接你的 GitHub</h2><p>在运行服务的机器安装 GitHub CLI，然后在终端执行：</p><p class="code">gh auth login --hostname github.com</p><p>完成后点击右上角刷新，即可查看 PR 与 Issue。</p></div>`;
					showView("list");
				}
			}
			async function refreshWorkspace(reconnect = false) {
				const item = selected;
				const epoch = detailEpoch;
				await (reconnect || !connected ? connect(Boolean(saved)) : loadItems(query?.page ?? page, false, true));
				if (disposed) return;
				if (connected && item && detailEpoch === epoch && app.dataset.view === "detail") {
					const scroll = detail.scrollTop;
					await openItem(item, false);
					if (!disposed && selected && key(selected) === key(item) && app.dataset.view === "detail") {
						detailScroll = scroll;
						detail.scrollTop = scroll;
					}
				}
			}
			function mutate(path, body, success) {
				if (mutation || pendingMutation || !selected) return;
				const item = selected;
				const epoch = detailEpoch;
				mutation = true;
				mutationNotice = null;
				setMutationDisabled();
				message(path === "/comment" ? "正在发布评论…" : "正在更新状态…");
				pendingMutation = (async () => {
					try {
						await request(path, { repo: item.repo, number: item.number, ...body });
						if (path === "/comment") {
							if (draftComments.get(key(item)) === body.body) draftComments.delete(key(item));
							const input = detail.querySelector("textarea");
							if (selected && key(selected) === key(item) && input?.value === body.body) input.value = "";
						}
						if (path === "/state") {
							item.state = body.state;
							items = items.map((row) => (key(row) === key(item) ? { ...row, state: body.state } : row));
							if (saved)
								saved.items = saved.items.map((row) => (key(row) === key(item) ? { ...row, state: body.state } : row));
							if (!disposed) renderList();
						}
						mutationNotice = { text: success, error: false, deferred: disposed };
						if (disposed) return;
						message(success);
						if (epoch === detailEpoch) await openItem(item, false);
					} catch (error) {
						mutationNotice = {
							text: `${error.message}；操作结果不确定时请刷新确认后再重试。`,
							error: true,
							deferred: disposed,
						};
						message(mutationNotice.text, true);
					} finally {
						mutation = false;
						pendingMutation = null;
						if (!disposed) setMutationDisabled();
					}
				})();
			}
			function quote() {
				if (!selected) return;
				if (!hostApi()?.compose?.({ attachments: [buildReference(selected)] }))
					return message("当前没有可用的对话输入框，请先打开一个对话。", true);
				hostApi()?.setView?.("chat");
				message("已引用到当前对话，可继续填写处理要求。");
			}
			const onSubmit = (event) => {
				event.preventDefault();
				if (event.target === form) {
					void (connected ? loadItems() : connect());
					return;
				}
				if (event.target.matches(".comment-form")) {
					const body = event.target.elements.comment.value;
					if (!body.trim()) return message("请输入评论内容。", true);
					saveDraft();
					mutate("/comment", { body }, "评论已发布");
				}
			};
			const onInput = (event) => {
				if (event.target.matches(".comment-form textarea")) saveDraft();
			};
			const onChange = (event) => {
				if (event.target !== form.elements.filter) return;
				if (connected) void loadItems();
				else query = null;
			};
			const onClick = (event) => {
				const button = event.target.closest("button");
				if (!button || button.disabled) return;
				if (button.dataset.index !== undefined) {
					void openItem(items[Number(button.dataset.index)]);
					return;
				}
				if (button.dataset.kind) {
					kind = button.dataset.kind;
					syncControls();
					if (connected) void loadItems();
					else query = null;
					return;
				}
				switch (button.dataset.action) {
					case "refresh":
						void refreshWorkspace();
						break;
					case "search":
						searchOpen = !searchOpen;
						syncControls();
						if (searchOpen) form.elements.q.focus();
						break;
					case "back":
						saveDraft();
						++detailEpoch;
						showView("list");
						break;
					case "prev":
						if (!loadingList) void loadItems(page - 1, false);
						break;
					case "next":
						if (!loadingList) void loadItems(page + 1, false);
						break;
					case "quote":
					case "process":
						quote();
						break;
					case "state":
						if (selected) mutate("/state", { state: selected.state === "open" ? "closed" : "open" }, "状态已更新");
						break;
				}
			};
			root.addEventListener("submit", onSubmit);
			root.addEventListener("click", onClick);
			root.addEventListener("input", onInput);
			root.addEventListener("change", onChange);
			inbox.addEventListener("scroll", rememberScroll, { passive: true });
			detail.addEventListener("scroll", rememberScroll, { passive: true });
			syncControls();
			if (saved) {
				if (!saved.loadingList) renderList(false);
				if (selected?.comments) renderDetail(selected);
				showView(saved.view, false);
			}
			void (async () => {
				if (pendingMutation) {
					message("正在完成上一次操作…");
					await pendingMutation;
					mutation = false;
					if (disposed) return;
					if (selected?.comments) renderDetail(selected);
				}
				if (disposed) return;
				await refreshWorkspace(true);
				if (!disposed && mutationNotice?.deferred) {
					message(mutationNotice.text, mutationNotice.error);
					mutationNotice.deferred = false;
				}
			})();
			return () => {
				saveDraft();
				rememberScroll();
				saved = {
					items,
					selected,
					page,
					hasMore,
					total,
					query,
					loadingList,
					kind,
					searchOpen,
					initialized,
					form: Object.fromEntries(["repo", "filter", "q"].map((name) => [name, form.elements[name].value])),
					view: app.dataset.view,
					listScroll,
					detailScroll,
				};
				disposed = true;
				for (const controller of controllers) controller.abort();
				controllers.clear();
				root.removeEventListener("submit", onSubmit);
				root.removeEventListener("click", onClick);
				root.removeEventListener("input", onInput);
				root.removeEventListener("change", onChange);
				inbox.removeEventListener("scroll", rememberScroll);
				detail.removeEventListener("scroll", rememberScroll);
				root.replaceChildren();
			};
		},
	};
}

export default createWorkbench();
