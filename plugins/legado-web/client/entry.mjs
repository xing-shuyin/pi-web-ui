import { buildFixPrompt, isAiFixMessage } from "./ai-fix.mjs";
import { makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

function appUrl() {
	const url = new URL("app/index.html", import.meta.url);
	try {
		const e = new URL(import.meta.url).searchParams.get("e");
		if (e) url.searchParams.set("e", e);
	} catch {}
	return url.href;
}

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
		frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-same-origin");
		frame.style.cssText = "display:block;height:100%;width:100%;border:0;background:transparent";
		frame.src = appUrl();
		container.append(frame);

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

		const onMessage = async (ev) => {
			if (ev.origin !== window.location.origin) return;
			if (ev.source !== frame.contentWindow) return;
			if (!isAiFixMessage(ev.data)) return;
			await waitDirs();
			const prompt = buildFixPrompt(ev.data.context, dirs);
			const host = hostApi();
			if (!host || typeof host.startChat !== "function") {
				try {
					await navigator.clipboard?.writeText(prompt);
					window.alert(t("hostUnsupportedCopied"));
				} catch {
					window.alert(t("hostUnsupported"));
				}
				return;
			}
			host.setView?.("chat");
			const cwd = dirs.dataDir || dirs.workspace || "";
			const ok = host.startChat({ prompt, newChat: true, cwd });
			if (!ok) window.alert(t("hostNotConnected"));
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
