import { ClientStateStore } from "./client-state.js";
import type { SettingsStorePort } from "../packages/keel/src/contracts/settings-store.js";

/**
 * 宿主侧设置存储适配器：`ClientStateStore` 就是 `client-state.json` 的唯一实现，
 * 结构直通（签名逐字对齐，不搬参数、不重算归一），内核只按 `SettingsStorePort` 的窄面读写。
 *
 * 一个进程一份实例：设置、项目最近列表、模型记忆都落在同一份缓存里，
 * 两套实例各写同一个文件会互相覆盖（那是 `client-state` 的单写者约定）。
 */
export function createCoreStateStore(filePath: string): SettingsStorePort {
	return new ClientStateStore(filePath);
}
