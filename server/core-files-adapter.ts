import type { FilesPort, WorkspacePort } from "../packages/keel/src/contracts/files.js";
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

/**
 * 工作区绑定面：宿主侧还没搬出「解析目标 → 校验 → 换会话 → 推帧」这条链
 * （它长在 `ClientSession.setCwd` 里，约 150 行，属 P4）。这里**显式声明未接**，
 * 让调用方拿到带名字的错误，而不是静默什么都不做。
 */
export function createCoreWorkspaceUnavailable(): WorkspacePort {
	const fail = (what: string): never => {
		throw new Error(`core 引擎暂不支持${what}（工作区绑定待 P4 从 agent-service 抽出）`);
	};
	return {
		async setCwd(): Promise<void> {
			fail("切换工作目录");
		},
		async setWorkspaceRoots(): Promise<void> {
			fail("设置额外工作区根");
		},
	};
}
