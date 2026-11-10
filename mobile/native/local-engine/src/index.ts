import { registerPlugin } from "@capacitor/core";
import type { LocalEngineEndpoint, LocalEnginePlugin, LocalEngineStatus } from "./definitions";

export type * from "./definitions";

const native = registerPlugin<
	Omit<LocalEnginePlugin, "start"> & { start(): Promise<{ endpoint: LocalEngineEndpoint | null }> }
>("LocalEngine");

export const LocalEngine: LocalEnginePlugin = {
	getStatus: () => native.getStatus(),
	install: () => native.install(),
	start: async () => {
		const result = await native.start();
		const endpoint = result.endpoint;
		const serverUrl = endpoint?.serverUrl?.trim() ?? "";
		const token = endpoint?.token?.trim() ?? "";
		if (!serverUrl || !token) throw new Error("本机引擎未返回连接信息，请查看引擎日志后重试。");
		return { endpoint: { serverUrl, token } };
	},
	stop: () => native.stop(),
	getLogSnapshot: (options) => native.getLogSnapshot(options),
	reset: () => native.reset(),
	addListener: native.addListener.bind(native),
	removeAllListeners: () => native.removeAllListeners(),
};

export type { LocalEngineStatus } from "./definitions";
