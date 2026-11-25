import type { ClientId } from "../../contracts/ids.js";
import type { ModelAdminPort, ModelMemoryPort, ProjectKeyPins } from "../../contracts/model-admin.js";
import type { TurnCapableSession } from "../../contracts/session.js";

/** 模型/供应商记忆按引擎分槽落盘：pi 引擎之外的槽位由各自引擎写（这里只碰 pi）。 */
export const MODEL_MEMORY_ENGINE = "pi";

export interface ParsedModelId {
	provider: string;
	id: string;
}

/** `provider/id`：项目模型、全局默认、会话当前模型都用这一个字符串做键，解析只写这一处。 */
export function parseModelId(modelId: string): ParsedModelId | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return undefined;
	return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

/** 会话里的模型对象（SDK 的模型）窄化成同一组键：比较「当前模型是不是记忆里那个」。 */
export function modelKeyOf(value: unknown): ParsedModelId | undefined {
	if (!value || typeof value !== "object") return undefined;
	const cur = value as { provider?: unknown; id?: unknown };
	return typeof cur.provider === "string" && typeof cur.id === "string"
		? { provider: cur.provider, id: cur.id }
		: undefined;
}

export interface ProjectMemoryOptions {
	clientId: ClientId;
	memory: ModelMemoryPort;
	/** 缺省 = 凭据面未接：只记模型，key 一个也不动。 */
	admin?: ModelAdminPort;
}

/** 「进项目套模型」的输入：会话、项目目录，以及取模型对象/收尾的宿主口。 */
export interface ProjectModelRestore {
	cwd: string;
	session: TurnCapableSession;
	/** 按 `provider/id` 取模型对象（模型目录域提供）；缺省 = 目录未接，不换模型。 */
	resolveModel?(provider: string, id: string): Promise<unknown | undefined>;
	/** 换完模型的宿主收尾（压缩预留重算 / 插件通知）：宿主拿这一段，域里不猜。 */
	onModelChanged?(): void;
}

/**
 * 项目级模型/供应商 key 记忆（老的 `rememberProjectModel` / `restoreProjectModelForCwd` /
 * `restoreProjectProviderKeysForCwd` / `restoreKeyForModel` 四个函数收成一处）。
 *
 * 分工：**什么时候读哪一格**在这里，落盘仍然只归宿主（`ModelMemoryPort` 是窄面，不缓存）。
 * 回落链与老实现逐字一致：项目 pin > 全局 pin > SDK 默认；静默 + 自愈（记忆里的 key 已经被删就
 * 把那条记忆删掉，不再报一次错——项目切换后回头骂一句正是老实现最难用的地方）。
 */
export interface ProjectMemory {
	/** 记住某个 provider 当前用的是哪个 key（激活 key 之后、换完模型之后）。 */
	rememberActiveKey(cwd: string, provider: string, keyName: string): void;
	/** 这个项目不再记住某个 provider 的 key（激活失败 = 那条记忆失效）。 */
	forgetKey(cwd: string, provider: string): void;
	/** 选完模型立刻记：项目模型 + 该 provider 当前 active key（老 `rememberProjectModel`）。 */
	rememberModel(cwd: string, modelId: string): void;
	/** 进项目：把该项目记住的 provider key 全部激活（老 `restoreProjectProviderKeysForCwd`）。 */
	restoreKeysForProject(cwd: string): Promise<void>;
	/** 换模型前：先恢复该模型 provider 的项目 pin / 全局 pin（老 `restoreKeyForModel`）。 */
	restoreKeyForModel(cwd: string, modelId: string): Promise<void>;
	/** 进项目：项目模型 → 全局默认套到「还没开始」的会话上（老 `restoreProjectModelForCwd`）。 */
	restoreModelForProject(input: ProjectModelRestore): Promise<boolean>;
	/** 删掉一个 key 之后把项目/全局引用改指新的 active（老 `repointDeletedKeyEverywhere/InDefault`）。 */
	repointDeletedKey(provider: string, deletedKeyName: string, newActive: string | null): void;
	/** 项目记忆的模型（项目 > 全局默认）：只读场景（Bot 兜底模型）用。 */
	rememberedModel(cwd: string): string | undefined;
}

/** 把项目记忆绑成凭据域要的三格：谁 / 哪个项目 / 用哪个凭据面，全部**惰性读取**。 */
export interface ProjectKeyPinsOptions {
	/** 客户端 id 会被孤儿收养改写（`ClientRuntime.updateClientId`），所以要 thunk。 */
	clientId(): ClientId;
	/** 当前工作区：每换一次目录就变，快照式传入会把 pin 写到上一个项目上。 */
	cwd(): string;
	/** 模型记忆；缺省 = 未接（三格全部变成 no-op）。 */
	memory(): ModelMemoryPort | undefined;
	admin?(): ModelAdminPort | undefined;
}

/**
 * `ProjectKeyPins` 的绑定器：凭据域只看到「记住/忘掉/改指」三格，具体落哪一格由模型域决定。
 * 两块域不互相 import（`tests/unit/core-boundaries.test.ts`），所以绑定放在 app 层。
 */
export function bindProjectKeyPins(options: ProjectKeyPinsOptions): ProjectKeyPins {
	const project = (): ProjectMemory | undefined => {
		const memory = options.memory();
		if (!memory) return undefined;
		const admin = options.admin?.();
		return createProjectMemory({ clientId: options.clientId(), memory, ...(admin ? { admin } : {}) });
	};
	return {
		remember: (provider, keyName) => project()?.rememberActiveKey(options.cwd(), provider, keyName),
		forget: (provider) => project()?.forgetKey(options.cwd(), provider),
		repointDeleted: (provider, deletedKeyName, newActive) =>
			project()?.repointDeletedKey(provider, deletedKeyName, newActive),
	};
}

/**
 * 会话是不是「已经开始了」：老实现读 `getSessionStats().totalMessages > 0`，
 * 内核窄面没有 stats（SDK 类型只许在 `adapters/sdk/**`），这里用同源的 `messages` 长度——
 * 空会话两种口径都判 0，有内容两种口径都判非 0，差别只在「只写了自定义条目」的转录。
 */
function hasStarted(session: TurnCapableSession): boolean {
	return (session.messages?.length ?? 0) > 0;
}

export function createProjectMemory(options: ProjectMemoryOptions): ProjectMemory {
	const { clientId, memory, admin } = options;

	/** 项目 pin → 全局 pin 依次尝试激活；项目 pin 自愈（key 已不存在就删掉那条记忆）。 */
	async function restoreKeyForModel(cwd: string, modelId: string): Promise<void> {
		const parsed = parseModelId(modelId);
		if (!admin || !parsed) return;
		const { provider } = parsed;
		const projectPin = memory.getProjectProviderKey(clientId, cwd, provider);
		if (projectPin) {
			if (admin.getActiveKeyName(provider) === projectPin) return;
			if (!admin.hasProviderKey(provider, projectPin)) {
				memory.deleteProjectProviderKey(clientId, cwd, provider);
				return;
			}
			const ok = await admin.activateProviderKey(provider, projectPin, { silent: true });
			if (!ok) memory.deleteProjectProviderKey(clientId, cwd, provider);
			return;
		}
		// 没有项目 pin：跟随全局默认 key。这里不自愈删除——那条引用属于全局默认。
		const globalPin = memory.getDefaultProviderKey(provider);
		if (!globalPin) return;
		if (admin.getActiveKeyName(provider) === globalPin) return;
		if (!admin.hasProviderKey(provider, globalPin)) return;
		await admin.activateProviderKey(provider, globalPin, { silent: true });
	}

	return {
		rememberActiveKey(cwd, provider, keyName): void {
			memory.saveProjectProviderKey(clientId, cwd, provider, keyName);
		},

		forgetKey(cwd, provider): void {
			memory.deleteProjectProviderKey(clientId, cwd, provider);
		},

		rememberModel(cwd, modelId): void {
			memory.saveProjectModel(clientId, cwd, modelId, MODEL_MEMORY_ENGINE);
			const parsed = parseModelId(modelId);
			if (!parsed) return;
			const active = admin?.getActiveKeyName(parsed.provider);
			if (active) memory.saveProjectProviderKey(clientId, cwd, parsed.provider, active);
		},

		async restoreKeysForProject(cwd): Promise<void> {
			// 枚举口是可选能力：宿主没实现就退化成「只恢复当前模型那一个 provider」。
			const saved = memory.getProjectProviderKeys?.(clientId, cwd);
			if (!saved || !admin) return;
			for (const [provider, keyName] of Object.entries(saved)) {
				if (admin.getActiveKeyName(provider) === keyName) continue;
				if (!admin.hasProviderKey(provider, keyName)) {
					memory.deleteProjectProviderKey(clientId, cwd, provider);
					continue;
				}
				const ok = await admin.activateProviderKey(provider, keyName, { silent: true });
				if (!ok) memory.deleteProjectProviderKey(clientId, cwd, provider);
			}
		},

		restoreKeyForModel,

		async restoreModelForProject(input): Promise<boolean> {
			const saved = this.rememberedModel(input.cwd);
			if (!saved) return false;
			// 已经开始（有消息）的会话保留它自己的模型：切回一条在跑的对话不该被项目默认悄悄改写。
			if (hasStarted(input.session)) return false;
			const parsed = parseModelId(saved);
			if (!parsed) return false;
			const model = await input.resolveModel?.(parsed.provider, parsed.id);
			if (!model) return false;
			await restoreKeyForModel(input.cwd, saved);
			const current = modelKeyOf(input.session.model);
			if (current && current.provider === parsed.provider && current.id === parsed.id) return false;
			if (!input.session.setModel) return false;
			await input.session.setModel(model);
			input.onModelChanged?.();
			return true;
		},

		repointDeletedKey(provider, deletedKeyName, newActive): void {
			memory.repointDeletedKeyEverywhere?.(provider, deletedKeyName, newActive);
			memory.repointDeletedKeyInDefault?.(provider, deletedKeyName, newActive);
		},

		rememberedModel(cwd): string | undefined {
			return memory.getProjectModel(clientId, cwd, MODEL_MEMORY_ENGINE) ?? memory.getDefaultModel(MODEL_MEMORY_ENGINE);
		},
	};
}
