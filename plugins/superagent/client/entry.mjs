export default {
	mount(el, ctx) {
		let disposed = false;
		let cleanup;
		el.textContent = "正在加载外部渠道…";
		const url = new URL("../../../plugins-api/superagent/assets/main.mjs", import.meta.url);
		url.search = new URL(import.meta.url).search;
		import(url.href)
			.then((mod) => {
				if (!disposed) cleanup = mod.default.mount(el, ctx);
			})
			.catch(() => {
				if (!disposed) el.textContent = "内置渠道界面加载失败，请重新加载页面或重启主程序。";
			});
		return () => {
			disposed = true;
			cleanup?.();
			el.replaceChildren();
		};
	},
};
