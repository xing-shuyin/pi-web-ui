import type { ClientId } from "../../contracts/ids.js";
import type { ModelAdminPort, ModelMemoryPort } from "../../contracts/model-admin.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { TurnCapableSession } from "../../contracts/session.js";

/** 模型/供应商记忆按引擎分槽落盘：pi 引擎之外的槽位由各自引擎写（这里只碰 pi）。 */
const ENGINE = "pi";

export interface ModelSwitcherOptions {
	clientId: ClientId;
	cwd: string;
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

interface ParsedModelId {
	provider: string;
	id: string;
}

function parseModelId(modelId: string): ParsedModelId | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return undefined;
	return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

function modelKeyOf(value: unknown): ParsedModelId | undefined {
	if (!value || typeof value !== "object") return undefined;
	const cur = value as { provider?: unknown; id?: unknown };
	return typeof cur.provider === "string" && typeof cur.id === "string"
		? { provider: cur.provider, id: cur.id }
		: undefined;
}

/**
 * 选模型 / 思考档 / 全局默认模型。
 *
 * 语义逐字沿用老实现（`server/agent-service.ts:17588-17708`）：失败一律发 `notice` 回包、**不抛**
 * （前端要看到原因而不是断线），只有「取模型对象」这一步在目录未接时才是真错误。
 * 项目/全局记忆落 `client-state`（经 `ModelMemoryPort`），默认模型/思考档的持久化留 SDK 设置层。
 */
export function createModelSwitchers(options: ModelSwitcherOptions): ModelSwitchers {
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (!options.transport.isClosed()) options.transport.send({ type: "notice", level, text, textEn });
	};
	const settingsOf = () => options.sessionOf()?.settingsManager;

	/** 项目 pin → 全局 pin 依次尝试激活对应 key；项目 pin 自愈（key 已不存在就删掉）。 */
	async function restoreKeyForModel(modelId: string): Promise<void> {
		const admin = options.modelAdmin;
		const memory = options.modelMemory;
		const parsed = parseModelId(modelId);
		if (!admin || !memory || !parsed) return;
		const { provider } = parsed;
		const projectPin = memory.getProjectProviderKey(options.clientId, options.cwd, provider);
		if (projectPin) {
			if (admin.getActiveKeyName(provider) === projectPin) return;
			if (!admin.hasProviderKey(provider, projectPin)) {
				memory.deleteProjectProviderKey(options.clientId, options.cwd, provider);
				return;
			}
			const ok = await admin.activateProviderKey(provider, projectPin, { silent: true });
			if (!ok) memory.deleteProjectProviderKey(options.clientId, options.cwd, provider);
			return;
		}
		// 没有项目 pin：跟随全局默认 key。这里不自愈删除——那条引用属于全局默认。
		const globalPin = memory.getDefaultProviderKey(provider);
		if (!globalPin) return;
		if (admin.getActiveKeyName(provider) === globalPin) return;
		if (!admin.hasProviderKey(provider, globalPin)) return;
		await admin.activateProviderKey(provider, globalPin, { silent: true });
	}

	function rememberProjectModel(modelId: string): void {
		const memory = options.modelMemory;
		if (!memory) return;
		memory.saveProjectModel(options.clientId, options.cwd, modelId, ENGINE);
		const parsed = parseModelId(modelId);
		if (!parsed) return;
		const active = options.modelAdmin?.getActiveKeyName(parsed.provider);
		if (active) memory.saveProjectProviderKey(options.clientId, options.cwd, parsed.provider, active);
	}

	return {
		async setModel(modelId: string): Promise<void> {
			try {
				const session = options.sessionOf();
				if (!session) throw new Error("没有可切换模型的会话");
				const parsed = parseModelId(modelId);
				if (!parsed) throw new Error(`无效的模型 ID：${modelId}`);
				const model = await options.resolveModel?.(parsed.provider, parsed.id);
				if (!model) throw new Error(`模型不存在：${modelId}`);
				await restoreKeyForModel(modelId);
				if (!session.setModel) throw new Error("当前会话不支持切换模型");
				await session.setModel(model);
				options.onSessionModelChanged?.();
				rememberProjectModel(modelId);
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
				memory.saveDefaultModel(modelId, ENGINE);
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
			options.modelMemory?.saveDefaultModel("", ENGINE);
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
