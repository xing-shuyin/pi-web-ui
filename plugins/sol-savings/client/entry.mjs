/**
 * sol-savings 客户端动作桥
 *
 * 响应底栏徽标（sol-savings-badge）点击动作，向服务端请求弹出节省明细报告。
 */

const ACTION = "sol-savings:details";

function hostApi() {
	return globalThis.window?.__piWebUiHost;
}

function register() {
	try {
		const api = hostApi();
		api?.onUiAction?.(ACTION, async () => {
			try {
				await fetch("/plugins-api/sol-savings/trigger-details", {
					method: "POST",
					credentials: "same-origin",
				});
			} catch (err) {
				console.error("[sol-savings] trigger details failed:", err);
			}
		});
	} catch {
		/* ignore */
	}
}

register();

export default {
	mount() {
		register();
		return () => {};
	},
};
