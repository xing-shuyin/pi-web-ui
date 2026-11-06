export default {
	async activate(host) {
		const url = new URL("./server.mjs", import.meta.url);
		url.search = new URL(import.meta.url).search;
		const { default: plugin } = await import(url.href);
		return plugin.activate(host);
	},
};
