/**
 * legado-web 客户端视图 —— 把内嵌的 Legado 阅读页整幅嵌进插件视图，并给它的
 * 「🤖 AI 修复源」按钮当转接头（iframe → 主应用）。
 *
 * 职责：
 *   1. 一张占满视图的 iframe（内嵌页是独立的 vanilla-TS 应用，产物在 client/app/）
 *   2. 收内嵌页的 postMessage（`legado:ai-fix`，同源 + source 校验）→ 组装给 AI 的正文
 *      → window.__piWebUiHost.startChat({ prompt, newChat: true, cwd: 书源所在目录 })
 *      → 主应用切到「对话」视图 + 新建对话（cwd = 书源所在目录，即 dataDir）+ 自动发送
 *
 * 目录信息（书源文件 / 规则速查文件 / 书源所在目录 / 插件目录）由插件的服务端在收到 {type:"info"} 时回，
 * 客户端 bundle 自己不知道这些（见 ../index.mjs）。宿主 API 不存在（旧版 pi-web-ui）时
 * 退化成把正文复制到剪贴板 + 提示，不让按钮变成哑巴。
 *
 * 路径取自本 bundle 的运行期 URL（`.../plugins/<id>/client/entry.mjs`），
 * 因此应用根前缀（nginx 子路径 /pi）与插件 id 都不用写死。
 *
 * 约定：ESM 默认导出 { mount(container, ctx) → cleanup? }，纯 DOM 无依赖。
 */

import { buildFixPrompt, isAiFixMessage } from "./ai-fix.mjs";

/** 内嵌应用首页：与本 bundle 同目录的 app/index.html（相对 URL 自动带前缀）。
 *  带上服务端重载纪元（本 bundle URL 上的 ?e=）作为缓存击穿参数：
 *  插件换版本后刷新浏览器（新 epoch）会重新拉 HTML，避免拿到指向已删除旧 hash 的旧页面。 */
function appUrl() {
	const url = new URL("app/index.html", import.meta.url);
	try {
		const e = new URL(import.meta.url).searchParams.get("e");
		if (e) url.searchParams.set("e", e);
	} catch {
		/* 非 http(s) 环境：不带参数 */
	}
	return url.href;
}

/** 宿主 API（pi-web-ui 装的，见 web/src/plugin-host.ts）。 */
function hostApi() {
	try {
		return window.__piWebUiHost ?? null;
	} catch {
		return null;
	}
}

export default {
	mount(container, ctx) {
		container.style.height = "100%";
		const frame = document.createElement("iframe");
		frame.title = "Legado Web";
		frame.setAttribute("allow", "clipboard-write");
		frame.style.cssText = "display:block;height:100%;width:100%;border:0;background:transparent";
		frame.src = appUrl();
		container.append(frame);

		// 插件目录信息：挂载时问一次服务端，之后缓存（点击时没拿到也不阻塞，正文里少几行而已）
		let dirs = {};
		let dirsWaiters = [];
		const resolveDirs = (info) => {
			dirs = info && typeof info === "object" ? info : {};
			const ws = dirsWaiters;
			dirsWaiters = [];
			for (const w of ws) w();
		};
		const waitDirs = (ms = 1200) =>
			Object.keys(dirs).length
				? Promise.resolve()
				: Promise.race([
						new Promise((resolve) => dirsWaiters.push(resolve)),
						new Promise((resolve) => setTimeout(resolve, ms)),
					]);
		const offData = ctx.onData((payload) => {
			if (payload && typeof payload === "object" && payload.kind === "info") resolveDirs(payload);
		});
		ctx.send({ type: "info" });

		/** 内嵌页点了「AI 修复源」：组正文 → 交给宿主开新对话发送。 */
		const onMessage = async (ev) => {
			// 同源 + 必须来自我们这张 iframe（别的窗口/别的插件发的一律不理）
			if (ev.origin !== window.location.origin) return;
			if (ev.source !== frame.contentWindow) return;
			if (!isAiFixMessage(ev.data)) return;
			await waitDirs();
			const prompt = buildFixPrompt(ev.data.context, dirs);
			const host = hostApi();
			if (!host || typeof host.startChat !== "function") {
				try {
					await navigator.clipboard?.writeText(prompt);
					window.alert(
						"当前宿主不支持自动开对话（pi-web-ui 版本较旧）。\n给 AI 的正文已复制到剪贴板，粘贴到对话框即可。",
					);
				} catch {
					window.alert("当前宿主不支持自动开对话（pi-web-ui 版本较旧）。");
				}
				return;
			}
			// 切到对话视图 + 新建对话。cwd 落在**书源所在目录**（dataDir = `<dataDir>/legado-web`，sources.json 就在那儿）；
			// 绝不用插件目录：那是安装产物，AI 在里面改任何东西都会被下次 `install --force` 整目录覆盖。
			host.setView?.("chat");
			const cwd = dirs.dataDir || dirs.workspace || "";
			const ok = host.startChat({ prompt, newChat: true, cwd });
			if (!ok) window.alert("还没连上 pi-web-ui 服务（或连接未就绪），稍后重试。");
		};
		window.addEventListener("message", onMessage);

		return () => {
			window.removeEventListener("message", onMessage);
			offData?.();
			frame.remove();
			container.style.height = "";
		};
	},
};
