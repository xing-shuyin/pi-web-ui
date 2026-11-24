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

/** 一次预热：`ready` 完成时 `current()` 就是可用的运行时（失败也 resolve，`current()` 保持 `undefined`）。 */
interface ModelRuntimeWarmup {
	ready: Promise<void>;
	current(): ModelRuntime | undefined;
	invalidate(): void;
}

function warmupModelRuntime(agentDir: string): ModelRuntimeWarmup {
	let runtime: ModelRuntime | undefined;
	let inflight: Promise<void> | undefined;
	const start = (): Promise<void> => {
		inflight ??= SdkModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		}).then(
			(created) => {
				runtime = created;
			},
			() => {
				runtime = undefined;
			},
		);
		return inflight;
	};
	return {
		ready: start(),
		current: () => runtime,
		// SDK 运行时的凭据快照在建实例时读取：登录态变了就重建，别让后续 OAuth 用旧快照。
		invalidate: () => {
			inflight = undefined;
			void start();
		},
	};
}

/**
 * 把端口的**异步**成员接到预热完成之后：`ModelRuntime.create()` 是异步的，而端口签名是同步取值，
 * 所以「热好之前调端口」必须等这一次创建，而不是当场报「模型运行时尚未就绪」
 * （老实现没有这个窗口：`AgentService` 启动时就建好了 `runtime.services.modelRuntime`）。
 * `hasProviderKey` 这类同步成员与运行时无关，原样直通。
 */
function warmGate<T extends object>(port: T, warmup: ModelRuntimeWarmup): T {
	return new Proxy(port, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver) as unknown;
			if (typeof value !== "function") return value;
			const fn = value as (...args: unknown[]) => unknown;
			if (fn.constructor?.name !== "AsyncFunction") return fn.bind(target);
			return async (...args: unknown[]) => {
				await warmup.ready;
				return fn.apply(target, args);
			};
		},
	});
}

/**
 * 宿主侧适配器：把进程级的 `ModelAdminService` 按 `ModelAdminPort` 的窄面交给内核。
 *
 * 结构直通：端口签名与 `ModelAdminService` 逐字对齐，这里只补 `ModelAdminHost` 需要的宿主能力，
 * 不搬参数、不重算语义（内核那边也不许有第二套）。
 *
 * OAuth 需要 SDK 的 `ModelRuntime`，且流程管理器是**同步取用**的：端口整体套 `warmGate`，
 * 第一个早到的 `save_model_config` 会等预热完成，而不是拿到「模型运行时尚未就绪」。
 */
export function createCoreModelAdmin(options: { agentDir: string } & CoreModelAdminSinks): ModelAdminPort {
	const warmup = warmupModelRuntime(options.agentDir);
	const service = new ModelAdminService({
		agentDir: options.agentDir,
		emit: (msg) => options.emit(msg),
		flushSnapshot: () => options.flushSnapshot(),
		isDisposed: () => options.isDisposed(),
		modelRuntime: () => {
			const runtime = warmup.current();
			// 预热失败（auth / models 读不了）：仍然如实说清，不拿半个运行时去跑 OAuth。
			if (!runtime) throw new Error("模型运行时尚未就绪，请稍后重试 / Model runtime is not ready yet");
			return runtime;
		},
		pushModels: () => options.pushModels(),
		invalidatePiConfig: () => warmup.invalidate(),
	});
	return warmGate(service, warmup);
}
