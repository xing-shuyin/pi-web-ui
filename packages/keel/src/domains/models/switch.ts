import type { ClientId } from "../../contracts/ids.js";
import type { ModelAdminPort, ModelMemoryPort } from "../../contracts/model-admin.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { TurnCapableSession } from "../../contracts/session.js";
import { createProjectMemory, MODEL_MEMORY_ENGINE, modelKeyOf, parseModelId } from "./project-memory.js";

export interface ModelSwitcherOptions {
	clientId: ClientId;
	/** 当前工作区（**惰性读取**：换目录之后项目记忆要落到新目录上）。 */
	cwd(): string;
	transport: TransportPort;
	modelAdmin?: ModelAdminPort;
	modelMemory?: ModelMemoryPort;
	/** 按 `provider/id` 取模型对象（由模型目录域提供）；缺省 = 目录未接。 */
	resolveModel?(provider: string, id: string): Promise<unknown | undefined>;
	/** 当前对话的会话（含 `setModel` / `setThinkingLevel` / `settingsManager`）；缺省 = 没开会话。 */
	sessionOf(): TurnCapableSession | undefined;
	flushSnapshot(): void;
	/** 推 `default_model` 帧（换全局默认模型后必须显式推一次）。 */
	pushDefaultModel(): void;
	/** 换完模型的宿主收尾（压缩预留重算 / 插件通知）：属于宿主的 C 类能力。 */
	onSessionModelChanged?(): void;
}

export interface ModelSwitchers {
	setModel(modelId: string): Promise<void>;
	setDefaultModel(modelId: string): Promise<void>;
	clearDefaultModel(): void;
	setThinking(level: string): void;
}

/**
 * 选模型 / 思考档 / 全局默认模型。
 *
 * 语义逐字沿用老实现（`server/agent-service.ts:17588-17708`）：失败一律发 `notice` 回包、**不抛**
 * （前端要看到原因而不是断线），只有「取模型对象」这一步在目录未接时才是真错误。
 * 项目/全局记忆落 `client-state`（经 `ModelMemoryPort`），默认模型/思考档的持久化留 SDK 设置层；
 * 「记哪一格 / 什么时候恢复」的单源是 `domains/models/project-memory.ts`。
 */
export function createModelSwitchers(options: ModelSwitcherOptions): ModelSwitchers {
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (!options.transport.isClosed()) options.transport.send({ type: "notice", level, text, textEn });
	};
	const settingsOf = () => options.sessionOf()?.settingsManager;
	const project = (): ReturnType<typeof createProjectMemory> | undefined =>
		options.modelMemory
			? createProjectMemory({
					clientId: options.clientId,
					memory: options.modelMemory,
					...(options.modelAdmin ? { admin: options.modelAdmin } : {}),
				})
			: undefined;

	return {
		async setModel(modelId: string): Promise<void> {
			try {
				const session = options.sessionOf();
				if (!session) throw new Error("没有可切换模型的会话");
				const parsed = parseModelId(modelId);
				if (!parsed) throw new Error(`无效的模型 ID：${modelId}`);
				const model = await options.resolveModel?.(parsed.provider, parsed.id);
				if (!model) throw new Error(`模型不存在：${modelId}`);
				await project()?.restoreKeyForModel(options.cwd(), modelId);
				if (!session.setModel) throw new Error("当前会话不支持切换模型");
				await session.setModel(model);
				options.onSessionModelChanged?.();
				project()?.rememberModel(options.cwd(), modelId);
			} catch (err) {
				notice("error", `切换模型失败：${(err as Error).message}`, `Failed to switch model: ${(err as Error).message}`);
			}
			options.flushSnapshot();
		},

		async setDefaultModel(modelId: string): Promise<void> {
			try {
				const memory = options.modelMemory;
				if (!memory) throw new Error("模型记忆未接");
				const parsed = parseModelId(modelId);
				if (!parsed) throw new Error(`无效的模型 ID：${modelId}`);
				if (!(await options.resolveModel?.(parsed.provider, parsed.id))) throw new Error(`模型不存在：${modelId}`);
				memory.saveDefaultModel(modelId, MODEL_MEMORY_ENGINE);
				const active = options.modelAdmin?.getActiveKeyName(parsed.provider);
				if (active) memory.saveDefaultProviderKey(parsed.provider, active);
				try {
					settingsOf()?.setDefaultModelAndProvider?.(parsed.provider, parsed.id);
				} catch {}
				options.pushDefaultModel();
				notice(
					"info",
					`🌍 已设全局默认模型 ${modelId}（新项目自动使用，项目记忆优先）`,
					`🌍 Global default model set to ${modelId} (new projects follow it; project memory wins)`,
				);
			} catch (err) {
				notice(
					"error",
					`设置全局默认模型失败：${(err as Error).message}`,
					`Failed to set global default model: ${(err as Error).message}`,
				);
			}
			options.flushSnapshot();
		},

		clearDefaultModel(): void {
			options.modelMemory?.saveDefaultModel("", MODEL_MEMORY_ENGINE);
			try {
				settingsOf()?.setDefaultModelAndProvider?.(undefined, undefined);
			} catch {}
			options.pushDefaultModel();
			notice(
				"info",
				"🌍 已清除全局默认模型（新项目回到 SDK 默认）",
				"🌍 Global default model cleared (new projects use the SDK default)",
			);
			options.flushSnapshot();
		},

		setThinking(level: string): void {
			try {
				const session = options.sessionOf();
				if (!session?.setThinkingLevel) throw new Error("当前会话不支持切换思考强度");
				session.setThinkingLevel(level, { persist: true });
				const cur = modelKeyOf(session.model);
				if (cur) settingsOf()?.setModelThinkingLevel?.(cur.provider, cur.id, level);
			} catch (err) {
				notice(
					"error",
					`切换思考强度失败：${(err as Error).message}`,
					`Failed to switch thinking level: ${(err as Error).message}`,
				);
			}
			options.flushSnapshot();
		},
	};
}
