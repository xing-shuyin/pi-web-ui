export function definePlugin(def) {
	if (!def || typeof def !== "object") throw new Error("[sdk] definePlugin 需要一个对象");
	if (typeof def.activate !== "function") throw new Error("[sdk] 插件缺 activate(host) 方法");
	if (def.deactivate !== undefined && typeof def.deactivate !== "function") {
		throw new Error("[sdk] deactivate 必须是函数");
	}
	return def;
}

export * from "./client.mjs";
export * from "./testing.mjs";
