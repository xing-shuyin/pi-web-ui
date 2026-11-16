import { makeT } from "./i18n.mjs";

const t = makeT();

export default {
	mount(el, ctx) {
		let disposed = false;
		let cleanup;
		el.textContent = t("loading");
		const url = new URL("../../../plugins-api/superagent/assets/main.mjs", import.meta.url);
		url.search = new URL(import.meta.url).search;
		import(url.href)
			.then((mod) => {
				if (!disposed) cleanup = mod.default.mount(el, ctx);
			})
			.catch(() => {
				if (!disposed) el.textContent = t("mountFailed");
			});
		return () => {
			disposed = true;
			cleanup?.();
			el.replaceChildren();
		};
	},
};
