import { esc, hostApi } from "@pi-web-ui/plugin-sdk/client";
import { CSS } from "./styles.mjs";
import { detectLang, makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

export function resolveApiBase(url) {
	const parsed = new URL(url);
	const index = parsed.pathname.indexOf("/plugins/");
	return `${parsed.origin}${index < 0 ? "" : parsed.pathname.slice(0, index)}/plugins-api/github-workbench`;
}

const API = resolveApiBase(import.meta.url);
// 第一列是接口入参（`filter=` / `is:` 搜索词取值），不要翻译；第二列是词典键。
const FILTERS = [
	["repository", "filterRepository"],
	["review-requested", "filterReviewRequested"],
	["assigned", "filterAssigned"],
	["authored", "filterAuthored"],
	["mentioned", "filterMentioned"],
	["custom", "filterCustom"],
];
const KINDS = [
	["all", "kindAll"],
	["pr", "kindPr"],
	["issue", "kindIssue"],
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
const stateLabel = (item) =>
	item.pr?.merged ? t("stateMerged") : item.state === "open" ? t("stateOpen") : t("stateClosed");
const empty = (title, hint = "", name = "inbox") =>
	`<div class="empty"><span class="empty-icon">${icon(name)}</span><strong>${esc(title)}</strong>${hint ? `<span>${esc(hint)}</span>` : ""}</div>`;
function shortDate(value) {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? String(value ?? "")
		: date.toLocaleDateString(detectLang() === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric" });
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
				<header class="header"><span class="brand">${icon("github")}</span><div class="heading"><h1>${esc(t("appName"))}</h1><div class="account" data-account><span>${esc(t("connecting"))}</span></div></div><button type="button" class="icon-button refresh" data-action="refresh" title="${esc(t("refreshInbox"))}" aria-label="${esc(t("refreshInbox"))}">${icon("refresh")}</button></header>
				<form class="toolbar" aria-label="${esc(t("filterFormLabel"))}">
					<div class="input-field">${icon("repo")}<input name="repo" aria-label="${esc(t("repoLabel"))}" placeholder="${esc(t("repoPlaceholder"))}" maxlength="200" spellcheck="false"><button type="submit" class="icon-button" title="${esc(t("loadRepo"))}" aria-label="${esc(t("loadRepo"))}">${icon("arrow")}</button></div>
					<div class="filter-line"><div class="input-field filter-field">${icon("filter")}<select name="filter" aria-label="${esc(t("filterLabel"))}">${FILTERS.map(([value, label]) => `<option value="${value}">${esc(t(label))}</option>`).join("")}</select></div><button type="button" class="icon-button search-toggle" data-action="search" aria-label="${esc(t("expandSearch"))}" aria-expanded="false" aria-controls="gh-search">${icon("search")}</button></div>
					<div class="input-field search-field" id="gh-search" hidden>${icon("search")}<input name="q" aria-label="${esc(t("searchQuery"))}" placeholder="${esc(t("searchPlaceholder"))}" maxlength="1000"><button type="submit" class="icon-button" title="${esc(t("search"))}" aria-label="${esc(t("search"))}">${icon("arrow")}</button></div>
				</form>
				<div class="kind-tabs" role="group" aria-label="${esc(t("kindLabel"))}">${KINDS.map(([value, label]) => `<button type="button" class="kind-tab" data-kind="${value}" aria-pressed="${value === "all"}">${icon(value === "all" ? "inbox" : value)}${esc(t(label))}</button>`).join("")}</div>
				<div class="status" role="status" aria-live="polite"></div>
				<div class="workspace"><div class="inbox" aria-label="${esc(t("inboxList"))}">${empty(t("loadingInbox"), t("loadingInboxHint"))}</div><div class="detail" aria-label="${esc(t("detailPane"))}">${empty(t("selectItem"), t("selectItemHint"))}</div></div>
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
					if (!response.ok || !result.ok)
						throw new Error(result.error || t("requestFailed", { status: response.status }));
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
					`<div class="list-heading"><span><strong>${esc(t("inbox"))}</strong><span class="count">${total}</span></span><span class="sort-label">${icon("clock")}${esc(t("sortRecent"))}</span></div>` +
					(items.length
						? items
								.map((item, index) => {
									const active = Boolean(selected && key(item) === key(selected));
									return `<button type="button" class="row${active ? " selected" : ""}" data-index="${index}" aria-pressed="${active}"><span class="item-icon${item.state === "open" ? "" : " closed"}" title="${stateLabel(item)}">${icon(item.kind)}</span><span class="row-body"><span class="row-repo"><span class="repo-name">${esc(item.repo)}</span><span class="item-number">#${item.number}</span></span><div class="row-title">${esc(item.title)}</div><span class="row-footer"><span class="author">@${esc(item.author)}</span><time title="${esc(item.updatedAt)}">${esc(shortDate(item.updatedAt))}</time><span class="comment-count" aria-label="${esc(t("commentCountLabel", { count: item.commentCount }))}">${icon("comment")}${item.commentCount}</span></span>${
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
						: empty(t("emptyInbox"), t("emptyInboxHint")));
				if (items.length || page > 1)
					inbox.insertAdjacentHTML(
						"beforeend",
						`<div class="page"><button type="button" data-action="prev" title="${esc(t("prevPage"))}" aria-label="${esc(t("prevPage"))}" ${page <= 1 || loadingList ? "disabled" : ""}>${icon("left")}</button><span>${esc(t("pageSummary", { page, total }))}</span><button type="button" data-action="next" title="${esc(t("nextPage"))}" aria-label="${esc(t("nextPage"))}" ${!hasMore || loadingList ? "disabled" : ""}>${icon("right")}</button></div>`,
					);
				if (visible(inbox)) inbox.scrollTop = listScroll;
			}
			function detailNav(item) {
				return `<div class="detail-nav"><button type="button" class="back" data-action="back">${icon("back")}${esc(t("backToList"))}</button>${item ? `<a class="url" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">GitHub ${icon("external")}</a>` : ""}</div>`;
			}
			function renderDetail(item) {
				const pr = item.pr;
				detail.innerHTML = `${detailNav(item)}<div class="meta"><span class="tag state-tag${item.state === "open" ? "" : " closed"}">${icon(item.kind)}${stateLabel(item)}</span><span>${esc(t(item.kind === "pr" ? "kindPr" : "kindIssue"))} #${item.number}</span></div><h2>${esc(item.title)}</h2><div class="detail-author">${esc(item.repo)} · @${esc(item.author)} · ${esc(t("detailUpdated", { date: shortDate(item.updatedAt) }))}</div>
					<div class="actions"><button type="button" data-action="process" class="primary">${icon("spark")}${esc(t("processWithAi"))}</button><button type="button" data-action="quote" class="quote" title="${esc(t("quoteToChat"))}" aria-label="${esc(t("quoteToChat"))}">${icon("quote")}</button><button type="button" data-action="state" class="state-action" ${pr?.merged ? "disabled" : ""}>${esc(t(item.state === "open" ? "closeItem" : "reopenItem"))}</button></div>
					${pr ? `<div class="summary"><div class="branches">${icon("pr")}<span>${esc(pr.head)}</span>${icon("arrow")}<span>${esc(pr.base)}</span>${pr.draft ? `<span class="tag">${esc(t("draftTag"))}</span>` : ""}</div><div>${esc(t("changedFiles", { count: pr.changedFiles }))} · <span class="diff-added">+${pr.additions}</span> / <span class="diff-deleted">−${pr.deletions}</span></div><div class="hint">${esc(t("mergeStatus", { state: pr.mergeableState ?? t("mergeComputing") }))} · ${esc(t("reviewStatus", { reviewers: pr.reviewers.join(", ") || t("noReviewers") }))}</div><div class="hint">${esc(t("prExternalHint"))}</div></div>` : ""}
					${item.labels.length ? `<div class="labels">${item.labels.map((label) => `<span class="tag">${esc(label)}</span>`).join("")}</div>` : ""}<div class="content">${esc(item.body || t("noBody"))}</div><h3 class="section-title">${icon("comment")}${esc(t("discussion"))}<span class="count">${item.commentCount}</span></h3>
					${item.commentsTruncated ? `<p class="hint">${esc(t("commentsTruncated"))}</p>` : ""}${item.comments.map((comment) => `<div class="comment"><div class="comment-author"><span class="avatar" aria-hidden="true">${esc(comment.author?.slice(0, 1).toUpperCase() || "?")}</span><span>@${esc(comment.author)}</span><span class="hint">${esc(shortDate(comment.createdAt))}</span></div><div class="content">${esc(comment.body)}</div></div>`).join("") || `<div class="hint">${esc(t("noComments"))}</div>`}
					<form class="comment-form"><label for="gh-comment">${esc(t("postComment"))}</label><textarea id="gh-comment" name="comment" maxlength="60000" placeholder="${esc(t("commentPlaceholder"))}">${esc(draftComments.get(key(item)) ?? "")}</textarea><div class="actions"><span class="comment-target">${esc(t("commentTarget", { number: item.number }))}</span><button type="submit" class="primary">${esc(t("publishComment"))} ${icon("arrow")}</button></div></form>`;
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
					detail.innerHTML = empty(t("selectItem"), t("selectItemHint"));
					listScroll = 0;
					inbox.scrollTop = 0;
				}
				message("");
				if (!items.length) inbox.innerHTML = empty(t("loadingInbox"), t("loadingInboxQuick"));
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
					message(result.incomplete ? t("searchIncomplete") : "");
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
				detail.innerHTML = detailNav(item) + empty(t("loadingDetail"), t("loadingDetailHint"));
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
					detail.innerHTML = detailNav() + empty(t("detailFailed"), t("detailFailedHint"));
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
					account.title = t("accountHint");
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
					account.querySelector("span").textContent = t("notConnected");
					message(error.message, true);
					inbox.innerHTML = `<div class="help"><h2>${esc(t("connectTitle"))}</h2><p>${esc(t("connectInstall"))}</p><p class="code">gh auth login --hostname github.com</p><p>${esc(t("connectDone"))}</p></div>`;
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
				message(path === "/comment" ? t("publishingComment") : t("updatingState"));
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
							text: `${error.message}${t("mutationUncertain")}`,
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
				if (!hostApi()?.compose?.({ attachments: [buildReference(selected)] })) return message(t("noComposer"), true);
				hostApi()?.setView?.("chat");
				message(t("quoted"));
			}
			const onSubmit = (event) => {
				event.preventDefault();
				if (event.target === form) {
					void (connected ? loadItems() : connect());
					return;
				}
				if (event.target.matches(".comment-form")) {
					const body = event.target.elements.comment.value;
					if (!body.trim()) return message(t("commentEmpty"), true);
					saveDraft();
					mutate("/comment", { body }, t("commentPublished"));
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
						if (selected) mutate("/state", { state: selected.state === "open" ? "closed" : "open" }, t("stateUpdated"));
						break;
				}
			};
			root.addEventListener("submit", onSubmit);
			root.addEventListener("click", onClick);
			root.addEventListener("input", onInput);
			root.addEventListener("change", onChange);
			inbox.addEventListener("scroll", rememberScroll, { passive: true });
			detail.addEventListener("scroll", rememberScroll, { passive: true });
			// 宿主全局语言单源：首帧按 locale.current() 取词，切语言后重渲染
			const rerenderOnLocale = () => {
				if (disposed) return;
				try {
					const h1 = root.querySelector("h1");
					if (h1) h1.textContent = t("appName");
				} catch {}
				try {
					renderList(false);
				} catch {}
				try {
					if (selected?.title) renderDetail(selected);
				} catch {}
			};
			let offLocale = null;
			let onLocaleEvent = null;
			try {
				offLocale = window.__piWebUiHost?.locale?.onChange?.(rerenderOnLocale) ?? null;
			} catch {
				offLocale = null;
			}
			try {
				onLocaleEvent = () => rerenderOnLocale();
				window.addEventListener("pi-web-ui:locale", onLocaleEvent);
			} catch {
				onLocaleEvent = null;
			}
			syncControls();
			if (saved) {
				if (!saved.loadingList) renderList(false);
				if (selected?.comments) renderDetail(selected);
				showView(saved.view, false);
			}
			void (async () => {
				if (pendingMutation) {
					message(t("finishingPrevious"));
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
				try {
					offLocale?.();
				} catch {}
				try {
					if (onLocaleEvent) window.removeEventListener("pi-web-ui:locale", onLocaleEvent);
				} catch {}
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
