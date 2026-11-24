import type { FilesPort } from "../packages/keel/src/contracts/files.js";
import type { ServerLang } from "../packages/keel/src/i18n.js";
import { FilesService } from "./files-service.js";

export interface CoreFilesSinks {
	/** 一帧发给本客户端。 */
	emit(msg: import("./protocol.js").ServerMessage): void;
	isDisposed(): boolean;
	/** 本对话的工作目录（`FilesService` 的线径根）。 */
	getCwd(): string;
	/** 已绑定工作区（含额外根的解析结果）。 */
	getActiveCwd(): string;
	getLang?: () => ServerLang;
	getUploadMaxBytes?: () => number;
}

/**
 * 宿主侧适配器：把 `FilesService` 按 `FilesPort` 的窄面交给内核。
 *
 * 结构直通：13 个方法一一对应（`FilesService` 本来就是这 13 件事的唯一实现），
 * 这里只补 `FilesHost` 需要的那几项宿主能力，不搬参数、不重算路径归一。
 */
export function createCoreFiles(options: CoreFilesSinks): FilesPort {
	const service = new FilesService({
		emit: (msg) => options.emit(msg),
		isDisposed: () => options.isDisposed(),
		getCwd: () => options.getCwd(),
		getActiveCwd: () => options.getActiveCwd(),
		getLang: options.getLang,
		getUploadMaxBytes: options.getUploadMaxBytes,
	});
	return service;
}
