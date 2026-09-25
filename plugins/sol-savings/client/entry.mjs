/**
 * sol-savings 客户端动作桥
 *
 * 响应底栏徽标（sol-savings-badge）点击动作，向服务端请求弹出节省明细报告。
 */

const ACTION = "sol-savings:details";

function hostApi() {
	return globalThis.window?.__piWebUiHost;
}

function whenBridge(fn, tries = 40) {
	const bridge = hostApi();
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	setTimeout(() => whenBridge(fn, tries - 1), 200);
}

function register() {
	whenBridge((bridge) => {
		try {
			const handler = async () => {
				try {
					await fetch("/plugins-api/sol-savings/trigger-details", {
						method: "POST",
						credentials: "same-origin",
					});
				} catch (err) {
					console.error("[sol-savings] trigger details failed:", err);
				}
			};
			bridge.onUiAction?.(ACTION, handler);
			bridge.onUiAction?.("details", handler);
		} catch (err) {
			console.error("[sol-savings] register action failed:", err);
		}
	});
}

register();

export default {
	mount() {
		register();
		return () => {};
	},
};
