/// <reference lib="dom" />
/**
 * 「把这个页面绑成服务地址」的纯逻辑。
 *
 * 为什么需要它：远程/局域网部署下地址是 `http://39.99.235.208:8787` 这种，端口也不固定，
 * 让用户先在选项页手打一遍是多余的 —— 他此刻**就站在** pi-web-ui 页面上。于是扩展改成：
 * 在 pi-web-ui 本页点图标 → 探测认出它 → 浮条问一句「要把它设成拾取服务地址吗」。
 *
 * 纪律：
 * - **永不静默改地址**（可能把用户本机的地址覆盖掉）：一定要在页面上点一下确认；
 * - 地址一律过 `normalizeServerUrl`（`?token=`、hash、尾斜杠都不进设置）；
 * - 只做纯计算，不问权限、不写存储 —— 那两件事在 background 里（可被假 chrome 单测）。
 */

import { normalizeServerUrl } from "./settings.js";

/** MAIN world 探测出来的页面身份（跨进程只能传普通对象）。 */
export interface PiProbe {
	/** 是不是 pi-web-ui 页面。 */
	isPiWebUi: boolean;
	/** 页面上有没有宿主动作桥（老版本没有桥 —— 与「能不能绑」无关，仅供提示/排障）。 */
	hasHost?: boolean;
	/** 服务端自报版本（`/api/health` 的 piVersion，给浮条显示用）。 */
	piVersion?: string;
	/** 页面地址（`location.href` —— 不依赖 `tab.url`，那要额外的 host 权限）。 */
	url: string;
	title?: string;
}

/** 绑定浮条要显示什么（文案在这里定，UI 只负责画）。 */
export interface BindView {
	/** 本页归一后的服务地址。 */
	base: string;
	/** 当前已绑定的地址。 */
	bound: string;
	/** 两者是不是同一个（同一个就不用再问「要不要绑」）。 */
	same: boolean;
	title: string;
	detail: string;
	/** 主按钮文案；`same` 时没有（没有可绑的东西，只提供「在本页拾取」）。 */
	bindLabel?: string;
}

/**
 * 页面地址 + 已绑定地址 → 浮条文案。
 *
 * `same` 时不要问「要不要绑」（那会让用户以为绑定失败了），而是说明现状 + 提供
 * 「仍然在本页拾取」—— 开发 pi-web-ui 自己时确实会在它自己的页面上拾取元素。
 */
export function bindView(pageUrl: string, boundUrl: string): BindView {
	const base = normalizeServerUrl(pageUrl);
	const bound = normalizeServerUrl(boundUrl);
	if (base === bound) {
		return {
			base,
			bound,
			same: true,
			title: "这个页面就是已绑定的 pi-web-ui",
			detail: `${base} —— 从别的页面拾取的内容会注入到这里。要在这个页面上拾取元素吗？`,
		};
	}
	return {
		base,
		bound,
		same: false,
		title: "这个页面是 pi-web-ui",
		detail: `把拾取的服务地址从 ${bound} 改成 ${base} 吗？改完之后，拾取的内容都注入到本页。`,
		bindLabel: "设为服务地址",
	};
}

/** 绑定结果（background → 浮条；`needAuth` = 权限没给成，得去选项页点一下）。 */
export interface BindResult {
	ok: boolean;
	base: string;
	message: string;
	/** true = 还差该 origin 的授权（浏览器要求手势，页面上的按钮给不了，只能去扩展页面点）。 */
	needAuth?: boolean;
}
