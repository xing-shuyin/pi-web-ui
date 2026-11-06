/// <reference lib="dom" />

import { normalizeServerUrl } from "./settings.js";
import { getMessage } from "./i18n.js";

export interface PiProbe {
	isPiWebUi: boolean;
	hasHost?: boolean;
	piVersion?: string;
	url: string;
	title?: string;
}

export interface BindView {
	base: string;
	bound: string;
	same: boolean;
	title: string;
	detail: string;
	bindLabel?: string;
}

export function bindView(pageUrl: string, boundUrl: string): BindView {
	const base = normalizeServerUrl(pageUrl);
	const bound = normalizeServerUrl(boundUrl);
	if (base === bound) {
		return {
			base,
			bound,
			same: true,
			title: getMessage("bindview_same_title", undefined, "这个页面就是已绑定的 pi-web-ui"),
			detail: getMessage(
				"bindview_same_detail",
				[base],
				`${base} —— 从别的页面拾取的内容会注入到这里。要在这个页面上拾取元素吗？`,
			),
		};
	}
	return {
		base,
		bound,
		same: false,
		title: getMessage("bindview_notSame_title", undefined, "这个页面是 pi-web-ui"),
		detail: getMessage(
			"bindview_notSame_detail",
			[bound, base],
			`把拾取的服务地址从 ${bound} 改成 ${base} 吗？改完之后，拾取的内容都注入到本页。`,
		),
		bindLabel: getMessage("bindview_notSame_label", undefined, "设为服务地址"),
	};
}

export interface BindResult {
	ok: boolean;
	base: string;
	message: string;
	needAuth?: boolean;
}
