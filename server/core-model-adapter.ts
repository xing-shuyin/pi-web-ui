import { join } from "node:path";
import { ModelRuntime as SdkModelRuntime, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelAdminService } from "./model-admin.js";
import type { ModelAdminPort } from "../packages/keel/src/contracts/model-admin.js";
import type { ServerMessage } from "./protocol.js";

export interface CoreModelAdminSinks {
	/** 一帧发给所有已连接的客户端（模型管理是进程级能力，老实现也是单一 active socket）。 */
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	isDisposed(): boolean;
	pushModels(): Promise<void>;
}

/**
 * 宿主侧适配器：把进程级的 `ModelAdminService` 按 `ModelAdminPort` 的窄面交给内核。
 *
 * 结构直通：端口签名与 `ModelAdminService` 逐字对齐，这里只补 `ModelAdminHost` 需要的宿主能力，
 * 不搬参数、不重算语义（内核那边也不许有第二套）。
 *
 * OAuth 需要 SDK 的 `ModelRuntime`，且流程管理器是**同步取用**的，所以构造期就热一份
 * （与老 `AgentService` 启动时建 `runtime.services.modelRuntime` 同一口径）；建失败只影响 OAuth，
 * 其余路径照常（`modelRuntime()` 返回 undefined → OAuth 自己给出「不支持」的明确错误）。
 */
export function createCoreModelAdmin(options: { agentDir: string } & CoreModelAdminSinks): ModelAdminPort {
	let runtime: ModelRuntime | undefined;
	const refreshRuntime = (): void => {
		void SdkModelRuntime.create({
			authPath: join(options.agentDir, "auth.json"),
			modelsPath: join(options.agentDir, "models.json"),
		})
			.then((created) => {
				runtime = created;
			})
			.catch(() => {
				runtime = undefined;
			});
	};
	refreshRuntime();
	return new ModelAdminService({
		agentDir: options.agentDir,
		emit: (msg) => options.emit(msg),
		flushSnapshot: () => options.flushSnapshot(),
		isDisposed: () => options.isDisposed(),
		modelRuntime: () => {
			// 流程管理器同步取用：没热好就把话说清（会作为 OAuth 失败原因回到前端）。
			if (!runtime) throw new Error("模型运行时尚未就绪，请稍后重试 / Model runtime is not ready yet");
			return runtime;
		},
		pushModels: () => options.pushModels(),
		// SDK 运行时的凭据快照在建实例时读取：登录态变了就重建，别让后续 OAuth 用旧快照。
		invalidatePiConfig: refreshRuntime,
	});
}
