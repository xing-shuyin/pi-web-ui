import { errorText, isNetworkError, makeProvider, requestJson } from "./util.mjs";

export const ID = "deepseek";
export const NAME = "DeepSeek";
export const NAME_EN = "DeepSeek";

const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** 币种符号，未知币种原样显示代码。 */
function symbol(currency) {
	if (currency === "CNY") return "¥";
	if (currency === "USD") return "$";
	return `${currency} `;
}

/**
 * @param {unknown} value
 * @param {string} currency
 */
function money(value, currency) {
	const n = Number(value);
	if (!Number.isFinite(n)) return "";
	return `${symbol(currency)}${n.toFixed(2)}`;
}

/**
 * DeepSeek 是预付费余额（没有订阅窗口），所以不画进度条，只报余额与拆分。
 * @param {{ host: any, apiKey: string }} ctx
 */
export async function collect({ host, apiKey }) {
	const key = String(apiKey ?? "").trim();
	if (!key) {
		return makeProvider(ID, {
			name: NAME,
			status: "signed-out",
			hint: "没有找到 DeepSeek API Key：设置 → 插件 → 额度看板里填一次，或设置环境变量 DEEPSEEK_API_KEY。",
			hintEn: "No DeepSeek API key found: set one in Settings → Plugins → Quota Watch, or export DEEPSEEK_API_KEY.",
		});
	}
	try {
		const data = await requestJson(host, BALANCE_URL, {
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
		});
		const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
		if (infos.length === 0) {
			return makeProvider(ID, {
				name: NAME,
				status: "empty",
				hint: data?.is_available === false ? "账户当前不可用（余额耗尽或未充值）。" : "接口没有返回余额信息。",
				hintEn:
					data?.is_available === false
						? "Account is not available (balance exhausted or never topped up)."
						: "The endpoint returned no balance info.",
			});
		}
		const currency = String(infos[0].currency ?? "CNY");
		const total = Number(infos[0].total_balance);
		const granted = Number(infos[0].granted_balance);
		const toppedUp = Number(infos[0].topped_up_balance);
		const extra = [];
		if (Number.isFinite(granted)) {
			extra.push({ label: "赠送", labelEn: "Granted", value: money(granted, currency) });
		}
		if (Number.isFinite(toppedUp)) {
			extra.push({ label: "充值", labelEn: "Top-up", value: money(toppedUp, currency) });
		}
		const unavailable = data?.is_available === false || (Number.isFinite(total) && total <= 0);
		return makeProvider(ID, {
			name: NAME,
			status: unavailable ? "empty" : "ok",
			source: "api.deepseek.com/user/balance",
			balance: Number.isFinite(total) ? { amount: total, currency, text: money(total, currency) } : null,
			extra,
			hint: unavailable ? "余额已耗尽，充值后恢复。" : "",
			hintEn: unavailable ? "Balance exhausted; top up to resume." : "",
		});
	} catch (error) {
		const message = errorText(error);
		const network = isNetworkError(error);
		const unauthorized = !network && /401|403|authentication|invalid/i.test(message);
		return makeProvider(ID, {
			name: NAME,
			status: network ? "network" : unauthorized ? "expired" : "error",
			error: message,
			hint: unauthorized ? "API Key 无效或已吊销，换一个再试。" : "查询余额失败，稍后重试。",
			hintEn: unauthorized
				? "The API key is invalid or revoked; set another one."
				: "Failed to read the balance; retry later.",
		});
	}
}
