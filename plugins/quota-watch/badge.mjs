/**
 * 底栏徽标的纯逻辑：模型 → 供应商识别、徽标文本与 tooltip。
 * 不碰 IO，方便单测。
 *
 * 唯一的视角是「当前供应商」：`providerFromModel` 决定引擎只去查哪一家，
 * 徽标与 tooltip 也只讲这一家 —— 不再有「当前 + 最紧」「全部来源并排」的多来源模式。
 */

/** 模型标识里的关键字 → 额度来源 id（顺序有意义：先认更具体的）。 */
const MODEL_RULES = [
	{ id: "deepseek", test: /deepseek/i },
	{ id: "claude", test: /claude|anthropic|-opus|-sonnet|-haiku/i },
	{ id: "codex", test: /codex|openai|(^|[/\s-])gpt|(^|[/\s-])o[134]([/\s-]|$)|chatgpt/i },
];

/** 徽标里的短名（底栏空间小）。 */
const SHORT = { claude: "CL", codex: "CX", deepseek: "DS" };

/** 中文/英文展示名。 */
const LABEL = {
	claude: { zh: "Claude Code", en: "Claude Code" },
	codex: { zh: "Codex", en: "Codex" },
	deepseek: { zh: "DeepSeek", en: "DeepSeek" },
};

/**
 * 从模型标识（如 `auto/deepseek-v4.1-flash`、`anthropic/claude-sonnet-4`）认出额度来源。
 * @param {unknown} model
 * @returns {string} provider id，认不出返回空串
 */
export function providerFromModel(model) {
	const text = String(model ?? "").trim();
	if (!text) return "";
	for (const rule of MODEL_RULES) {
		if (rule.test.test(text)) return rule.id;
	}
	return "";
}

/**
 * @param {string} id
 */
export function providerShort(id) {
	return (
		SHORT[id] ??
		String(id ?? "")
			.slice(0, 2)
			.toUpperCase()
	);
}

/**
 * @param {string} id
 * @param {boolean} zh
 */
export function providerLabel(id, zh) {
	const entry = LABEL[id];
	if (!entry) return id;
	return zh ? entry.zh : entry.en;
}

/**
 * 读一个窗口的剩余百分比：null / "" / undefined 一律视为「没有数字」。
 * （`Number(null)` 是 0，用它会凭空造出「剩 0%」的假告警。）
 * @param {any} win
 * @returns {number|null}
 */
function remainingOf(win) {
	const raw = win?.remainingPercent;
	if (raw === null || raw === undefined || raw === "") return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/**
 * 百分比文案：20% 以下保留一位小数（12.3% 比 12% 更能看出快到底了）。
 * @param {number} remaining
 */
function pctText(remaining) {
	return remaining < 20 ? remaining.toFixed(1) : String(Math.round(remaining));
}

/**
 * 一条 provider 里最紧的窗口（剩余最少且有数字）。
 * @param {any} provider
 * @returns {{ window: any, remaining: number } | null}
 */
export function tightestWindow(provider) {
	let best = null;
	for (const win of provider?.windows ?? []) {
		const remaining = remainingOf(win);
		if (remaining === null) continue;
		if (!best || remaining < best.remaining) best = { window: win, remaining };
	}
	return best;
}

/**
 * 取一个 provider 的展示态：状态 + 最紧窗口 + 余额。
 * @param {any} provider
 * @param {boolean} zh
 */
function describeProvider(provider, zh) {
	const tightest = tightestWindow(provider);
	const name = zh ? provider?.name : provider?.nameEn || provider?.name;
	if (provider?.status === "signed-out") return { text: "—", detail: `${name}：未登录`, ok: false };
	if (provider?.status === "error")
		return { text: "!", detail: `${name}：查询失败（${provider?.error ?? ""}）`, ok: false };
	if (provider?.status === "expired") return { text: "≠", detail: `${name}：登录态已失效`, ok: false };
	if (provider?.status === "network")
		return { text: "⇅", detail: `${name}：网络不可达（开代理/VPN 再刷新）`, ok: false };
	if (tightest) {
		const pct = pctText(tightest.remaining);
		const label = zh ? tightest.window?.label : tightest.window?.labelEn || tightest.window?.label;
		return { text: `${pct}%`, detail: `${name} · ${label} 剩余 ${pct}%`, ok: true };
	}
	const balance = provider?.balance;
	if (balance) {
		const text = String(balance.text ?? "");
		return { text, detail: `${name} 余额 ${text}`, ok: true };
	}
	return { text: "—", detail: `${name}：无额度数据`, ok: false };
}

/**
 * 快照里那条「当前供应商」记录（collectActive 只采集这一条）。
 * @param {any} snapshot
 * @param {string} activeId
 */
function findActive(snapshot, activeId) {
	const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
	return providers.find((p) => p?.id === activeId) ?? null;
}

/**
 * 底栏徽标文本 —— **只讲当前供应商**。别家根本不会被查询（见 providers/index.mjs 的 collectActive），
 * 所以这里没有「当前 + 最紧」「全部来源并排」这类模式。
 *
 * 认不出当前供应商时返回空 label/badge：客户端拿到空文本就把 `host:quota` 槽清掉，
 * 底栏不留「额度 --」这种既占地方又没信息的残片。
 * @param {any} snapshot collectActive() 的结果
 * @param {string} activeId 当前供应商 id（空 = 没识别出来）
 * @param {boolean} zh
 * @returns {{ label: string, badge: string }}
 */
export function formatBadge(snapshot, activeId, zh) {
	const active = findActive(snapshot, activeId);
	if (!active) return { label: "", badge: "" };
	return { label: providerShort(active.id), badge: describeProvider(active, zh).text };
}

/**
 * tooltip：当前供应商的每个窗口一行 + 余额 / 附加项，末行说明点击能干什么。
 * 同样只讲当前供应商 —— 其余来源既没查过，也没有数据可讲。
 * @param {any} snapshot
 * @param {string} activeId
 * @param {boolean} zh
 */
export function formatHint(snapshot, activeId, zh) {
	const active = findActive(snapshot, activeId);
	if (!active) return "";
	const plan = active.plan ? (zh ? `（${active.plan}）` : ` (${active.plan})`) : "";
	const name = providerLabel(active.id, zh);
	const lines = [zh ? `📊 当前供应商：${name}${plan}` : `📊 Active provider: ${name}${plan}`];
	if (active.account) lines.push(active.account);

	const status = String(active.status ?? "");
	const windows = Array.isArray(active.windows) ? active.windows : [];
	if (status !== "ok") {
		// 未登录 / 网络不可达 / 登录失效 / 查询失败：一句人话（能操作的提示优先于原始报错）
		lines.push(describeProvider(active, zh).detail);
	} else if (windows.length) {
		for (const win of windows) {
			const remaining = remainingOf(win);
			const label = (zh ? win.label : win.labelEn || win.label) || "";
			const pct = remaining === null ? (zh ? "未知" : "unknown") : `${pctText(remaining)}%`;
			lines.push(`${label} ${zh ? "剩余" : "left"} ${pct}`);
		}
	} else if (!active.balance) {
		lines.push(zh ? "接口没有返回额度数据" : "No quota data returned");
	}
	if (active.balance) lines.push(`${zh ? "余额" : "Balance"} ${active.balance.text}`);
	for (const item of active.extra ?? []) {
		if (item?.label && item?.value) lines.push(`${zh ? item.label : item.labelEn || item.label}: ${item.value}`);
	}
	lines.push(zh ? "点击打开额度看板" : "Click to open the Quota Watch board");
	return lines.join("\n");
}

/**
 * 从额度快照里挑出「当前供应商」：模型认出哪家、且快照里真有这家时才认。
 * （认不出 = 空串 —— 底栏整段隐藏；别退回去胡说某一家。）
 * @param {string} model
 * @param {any} snapshot
 */
export function resolveActiveProvider(model, snapshot) {
	const fromModel = providerFromModel(model);
	if (!fromModel) return "";
	const has = (snapshot?.providers ?? []).some((p) => p?.id === fromModel);
	return has ? fromModel : "";
}
