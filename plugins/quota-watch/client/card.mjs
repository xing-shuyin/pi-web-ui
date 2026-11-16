/**
 * 底栏「那个小卡片」的**内容**（不是外壳）。
 *
 * 位置、上下翻转、滚动跟随、点外部 / Esc 关闭、层级与主题全部归宿主
 * （`web/src/components/FooterSlotPopover.tsx`）。这里只做一件事：
 * 往宿主给的容器里画当前供应商的额度，并返回清理函数。
 *
 * 数据不自己拉：`store` 是唯一来源（`./store.mjs`），所以在这里点刷新，
 * 底栏那格也在同一帧更新 —— 这正是旧实现「浮层刷新了、底栏不动」的病根。
 */

import { esc } from "@pi-web-ui/plugin-sdk/client";
import { detectLang, makeT } from "./i18n.mjs";
import { createSummaryStore } from "./store.mjs";

/** 卡片文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

/** 余额低于这个数就整卡转红（只对余额型来源有意义）。 */
const LOW_BALANCE = 5;

/**
 * 把 `¥47.86` / `CNY 47.86` 拆成「货币符号 + 数字」，符号用小一号字号排。
 * 拆不出来就整串当数字，绝不吃掉内容。
 * @param {string} text
 * @returns {{ symbol: string, value: string }}
 */
function splitMoney(text) {
	const raw = String(text ?? "").trim();
	const match = /^([^\d-]*)\s*(-?[\d.,]+)$/.exec(raw);
	if (!match) return { symbol: "", value: raw };
	return { symbol: match[1].trim(), value: match[2] };
}

/**
 * 读一个窗口的剩余百分比：null / "" / undefined 一律「没有数字」
 * （`Number(null)` 是 0，会凭空造出「剩 0%」的假告警）。
 * @param {any} win
 * @returns {number|null}
 */
function remainingOf(win) {
	const raw = win?.remainingPercent;
	if (raw === null || raw === undefined || raw === "") return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/** 20% 以下保留一位小数（12.3% 比 12% 更能看出快到底了）。 */
function pctText(remaining) {
	return remaining < 20 ? remaining.toFixed(1) : String(Math.round(remaining));
}

/** @param {number|null} remaining */
function level(remaining) {
	if (remaining === null) return "ok";
	if (remaining <= 20) return "low";
	if (remaining <= 50) return "warn";
	return "ok";
}

/**
 * 「多久以前」—— 卡片自己的可信度指标。秒级刷新，人眼才看得出数字在动。
 * @param {number} ms
 */
function ageText(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 2) return t("justNow");
	if (s < 60) return t("secondsAgo", { n: s });
	const m = Math.floor(s / 60);
	if (m < 60) return t("minutesAgo", { n: m });
	return t("hoursAgo", { n: Math.floor(m / 60) });
}

/**
 * 自动刷新节奏：不足一分钟按秒报，整分钟报「每分钟」，其余按分钟。
 * @param {number} seconds
 */
function autoEveryText(seconds) {
	if (seconds < 60) return t("auto.everySeconds", { seconds });
	if (seconds === 60) return t("auto.everyMinute");
	return t("auto.everyMinutes", { minutes: Math.round(seconds / 60) });
}

/**
 * 重置倒计时。
 * @param {string} iso
 */
function countdown(iso) {
	const at = Date.parse(String(iso ?? ""));
	if (!Number.isFinite(at)) return "";
	const ms = at - Date.now();
	if (ms <= 0) return t("resetDone");
	const minutes = Math.max(1, Math.round(ms / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days) return hours ? t("countdown.daysHours", { days, hours }) : t("countdown.days", { days });
	if (hours) return mins ? t("countdown.hoursMins", { hours, mins }) : t("countdown.hours", { hours });
	return t("countdown.minutes", { mins });
}

/**
 * 一个窗口一行：标签 + 百分比 + 细进度条 + 倒计时。
 * @param {any} win
 * @param {boolean} zh
 */
function renderWindow(win, zh) {
	const remaining = remainingOf(win);
	const label = (zh ? win?.label : win?.labelEn || win?.label) || "";
	const pct = remaining === null ? t("unknown") : `${pctText(remaining)}%`;
	const width = remaining === null ? 0 : Math.max(0, Math.min(100, remaining));
	const reset = countdown(win?.resetAt);
	return `
		<div class="qw-win" data-level="${level(remaining)}">
			<div class="qw-win-head">
				<span class="qw-win-label">${esc(label)}</span>
				<span class="qw-win-pct">${esc(pct)}</span>
			</div>
			<div class="qw-bar"><div class="qw-bar-fill" style="width:${width}%"></div></div>
			<div class="qw-win-sub"${win?.resetAt ? ` data-reset="${esc(win.resetAt)}"` : ""}>${esc(reset)}</div>
		</div>`;
}

/**
 * 正文：余额（主数字）+ 拆分 chips + 窗口 / 附加项 / 一句状态说明。
 * @param {any} provider
 * @param {boolean} zh
 * @param {{ stale: boolean, low: boolean }} flags
 */
function renderProvider(provider, zh, flags) {
	const status = String(provider?.status ?? "ok");
	const windows = Array.isArray(provider?.windows) ? provider.windows : [];
	const balance = provider?.balance;
	const failed = status === "network" || status === "expired" || status === "error";
	const parts = [];

	if (balance) {
		const money = splitMoney(balance.text || `${balance.currency ?? ""} ${Number(balance.amount).toFixed(2)}`);
		parts.push(`
			<div class="qw-hero">
				<span class="qw-amount" data-role="amount"${flags.stale ? ' data-stale="1"' : ""}>${
					money.symbol ? `<span class="qw-cur">${esc(money.symbol)}</span>` : ""
				}${esc(money.value)}</span>
				<span class="qw-unit">${esc(t("balance"))}</span>
				<span class="qw-age" data-role="age"></span>
			</div>`);
	}

	const chips = [];
	for (const item of Array.isArray(provider?.extra) ? provider.extra : []) {
		const label = zh ? item.label : item.labelEn || item.label;
		if (!label || !item?.value) continue;
		chips.push(`<span class="qw-chip">${esc(label)} <b>${esc(item.value)}</b></span>`);
	}
	if (chips.length) parts.push(`<div class="qw-extra qw-chips">${chips.join("")}</div>`);

	if (windows.length) {
		parts.push(`<div class="qw-windows">${windows.map((win) => renderWindow(win, zh)).join("")}</div>`);
	}

	if (flags.low) {
		parts.push(`<div class="qw-alert" data-kind="warn">${esc(t("lowBalance"))}</div>`);
	}

	if (!windows.length && !balance && !failed) {
		const empty = status === "signed-out" ? t("signedOut") : status === "empty" ? t("empty") : t("noWindows");
		parts.push(`<div class="qw-empty">${esc(empty)}</div>`);
	}

	// 网络不可达 / 登录失效时，厂商原始报错（`fetch failed`）对人没用，优先给能操作的提示
	const hint = (zh ? provider?.hint : provider?.hintEn || provider?.hint) || "";
	const note = status === "network" || status === "expired" ? hint || provider?.error || "" : provider?.error || hint;
	if (note) {
		const kind = status === "network" ? "warn" : provider?.error ? "error" : "info";
		parts.push(`<div class="qw-note" data-kind="${kind}">${esc(note)}</div>`);
	}
	if (flags.stale) {
		parts.push(
			`<div class="qw-note" data-kind="stale"><span>${esc(t("stale"))}</span><span data-role="stale-age"></span></div>`,
		);
	}
	return parts.join("");
}

/**
 * 造一个稳定的 `render(container)`：``setFooterStatus({ content: { render } })`` 会按引用比较，
 * 所以这个函数必须只造一次（entry.mjs 里模块级持有），不能每次轮询都新建。
 * @param {{ apiBase: string, store?: any }} opts
 * @returns {(container: HTMLElement) => () => void}
 */
export function createQuotaCard({ apiBase, store }) {
	return function render(container) {
		/** 当前语言决定服务端数据的 nameEn / labelEn 选哪一份；文案本身走 t()。 */
		const zh = detectLang() === "zh";
		/** 没传 store 时（单测 / 独立使用）自建一个，行为与主流程一致。 */
		const own = store ? null : createSummaryStore({ apiBase });
		const hub = store ?? own;
		if (own) own.start();

		let disposed = false;
		let busy = false;
		/** @type {any} */
		let payload = null;
		let lastMoneyKey = "";

		container.classList.add("qw-card");
		container.innerHTML = `
			<div class="qw-head">
				<span class="qw-name" data-role="name">${esc(t("title"))}</span>
				<span class="qw-plan" data-role="plan" hidden></span>
				<span class="qw-gap"></span>
				<span class="qw-head-age" data-role="head-age" hidden></span>
				<button class="qw-refresh" type="button" data-role="refresh" title="${esc(t("refresh"))}" aria-label="${esc(t("refresh"))}">
					<svg class="qw-ring" viewBox="0 0 24 24" aria-hidden="true">
						<circle class="qw-ring-track" cx="12" cy="12" r="10"></circle>
						<circle class="qw-ring-fill" cx="12" cy="12" r="10"></circle>
					</svg>
					<span class="qw-glyph">⟳</span>
				</button>
			</div>
			<div class="qw-body" data-role="body"><div class="qw-empty">${esc(t("loading"))}</div></div>
			<div class="qw-foot">
				<span class="qw-auto" data-role="auto"></span>
			</div>`;

		const $ = (selector) => container.querySelector(selector);
		const nameNode = $('[data-role="name"]');
		const planNode = $('[data-role="plan"]');
		const bodyNode = $('[data-role="body"]');
		const autoNode = $('[data-role="auto"]');
		const refreshBtn = $('[data-role="refresh"]');
		const ringFill = $(".qw-ring-fill");

		/** 一秒一跳：新鲜度文字 + 自动刷新进度环（都是「数据有多旧」的可视化）。 */
		function tick() {
			if (disposed || !payload) return;
			const updatedAt = Date.parse(String(payload?.updatedAt ?? ""));
			const ttl = Number(payload?.ttlMs) || 60_000;
			if (!Number.isFinite(updatedAt)) return;
			const age = Date.now() - updatedAt;
			const stalled = age > ttl;
			const ageNode = $('[data-role="age"]');
			const headAge = $('[data-role="head-age"]');
			const ageLabel = stalled ? `${ageText(age)} · ${t("aging")}` : ageText(age);
			if (ageNode) {
				ageNode.textContent = ageLabel;
				ageNode.toggleAttribute("data-stale", stalled);
			}
			// 订阅型没有余额主数字，新鲜度就摆到头部（否则只剩一排进度条，看不出数据多旧）
			if (headAge && !headAge.hasAttribute("hidden")) {
				headAge.textContent = ageLabel;
				headAge.toggleAttribute("data-stale", stalled);
			}
			const staleAge = $('[data-role="stale-age"]');
			if (staleAge) {
				const since = Date.parse(String(payload?.lastGoodAt ?? ""));
				staleAge.textContent = Number.isFinite(since) ? ` · ${ageText(Date.now() - since)}` : "";
			}
			if (ringFill) {
				const circumference = 2 * Math.PI * 10;
				const remaining = Math.max(0, Math.min(1, 1 - age / ttl));
				ringFill.setAttribute("stroke-dasharray", circumference.toFixed(2));
				ringFill.setAttribute("stroke-dashoffset", (circumference * (1 - remaining)).toFixed(2));
			}
			// 窗口倒计时也一起走
			container.querySelectorAll("[data-reset]").forEach((node) => {
				const text = countdown(node.getAttribute("data-reset") ?? "");
				if (text) node.textContent = text;
			});
		}

		/** @param {any} data */
		function paint(data) {
			if (disposed) return;
			payload = data;
			const provider = Array.isArray(data?.providers) ? data.providers[0] : null;
			const money = provider?.balance ? String(provider.balance.text ?? "") : "";
			const amount = Number(provider?.balance?.amount);
			const low = Number.isFinite(amount) && amount <= LOW_BALANCE;
			const stale = provider?.stale === true || Number(data?.staleMs) > Number(data?.ttlMs);

			container.setAttribute("data-tone", low ? "low" : "ok");
			if (nameNode) nameNode.textContent = provider?.name || t("title");
			if (planNode) {
				planNode.textContent = provider?.plan || "";
				planNode.toggleAttribute("hidden", !provider?.plan);
			}
			if (bodyNode) {
				bodyNode.innerHTML = provider
					? renderProvider(provider, zh, { stale, low })
					: `<div class="qw-empty">${esc(t("noSource"))}</div>`;
			}
			const headAge = $('[data-role="head-age"]');
			if (headAge) headAge.toggleAttribute("hidden", Boolean(provider?.balance));
			if (autoNode) {
				const seconds = Number(data?.refreshSeconds) || 60;
				autoNode.textContent = provider ? autoEveryText(seconds) : "";
				// 没有内容时别留一条孤零零的分隔线
				autoNode.parentElement?.toggleAttribute("hidden", !provider);
			}
			// 数字真的变了才做一次高亮：用户不用盯着看也能确认「刚才那下生效了」
			if (money && money !== lastMoneyKey) {
				const flash = Boolean(lastMoneyKey);
				lastMoneyKey = money;
				const amountNode = $(".qw-amount");
				if (flash && amountNode) {
					amountNode.classList.add("qw-flash");
					setTimeout(() => amountNode.classList.remove("qw-flash"), 1100);
				}
			}
			tick();
		}

		/** @param {unknown} error */
		function paintError(error) {
			if (disposed || !bodyNode || payload) return;
			const message = error instanceof Error ? error.message : String(error);
			bodyNode.innerHTML = `<div class="qw-empty" data-kind="error">${esc(t("failed"))}: ${esc(message)}</div>`;
		}

		/** @param {boolean} force */
		async function load(force) {
			if (disposed || busy) return;
			busy = true;
			refreshBtn?.setAttribute("data-busy", "1");
			refreshBtn?.setAttribute("disabled", "true");
			try {
				await hub.refresh(force);
			} catch (error) {
				paintError(error);
			} finally {
				busy = false;
				if (!disposed) {
					refreshBtn?.removeAttribute("data-busy");
					refreshBtn?.removeAttribute("disabled");
				}
			}
		}

		const onClick = (event) => {
			const target = event.target;
			if (target instanceof Element && target.closest('[data-role="refresh"]')) void load(true);
		};
		container.addEventListener("click", onClick);

		/** 浮层挂着 = 有人在看：轮询加速到 activeMs，并在挂载时补一次。 */
		const release = hub.hold();
		const unsubscribe = hub.subscribe(paint);
		const ticker = setInterval(tick, 1000);
		if (!hub.get()) void load(false);

		return () => {
			disposed = true;
			clearInterval(ticker);
			container.removeEventListener("click", onClick);
			unsubscribe();
			release();
			own?.stop();
			container.classList.remove("qw-card");
			container.removeAttribute("data-tone");
		};
	};
}
