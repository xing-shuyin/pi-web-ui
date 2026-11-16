import { DEVICE_GROUPS_CHANGED, deviceGroupRequest } from "./components/DeviceGroupSection";

/**
 * 「新建智能体」的两个入口（单源）。
 *
 * - AI 创建（默认推荐）：把一句话交给服务端的 `bot-draft-runner` 跑一次模型调用，
 *   产出**草案**（`BotDraft`）；草案出现在左栏「待确认的新智能体」里，人按下「创建」才真的建。
 *   这条路不占用任何会话，所以在私聊里点加号也不会被 `agent_bot` 工具禁用影响。
 * - 手动创建：**就地弹「新建智能体」表单**（`BotCreateDialog` 复用设备中心同一个编辑器），
 *   不切视图——加号本来就在左栏，为了填个表单跳去设备中心再跳回来是白绕一圈。
 */

export interface BotDraftResult {
	id: string;
	name: string;
	description?: string;
	rationale?: string;
}

/** 一句话 → 草案。只产草案，不创建。 */
export async function createBotDraft(request: string, signal?: AbortSignal): Promise<BotDraftResult> {
	const data = await deviceGroupRequest<{ draft?: BotDraftResult }>(
		"bot-drafts",
		signal ?? new AbortController().signal,
		{ request },
	);
	const draft = data?.draft;
	if (!draft?.id) throw new Error("Bot draft response is missing draft.id");
	// 左栏（及其它读 bot-panel 的地方）据此重新拉一次草案列表。
	window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
	return draft;
}

const EVENT = "pi-web-ui:bot-create";

/** 手动创建：让挂着的 `BotCreateDialog` 打开空白表单（本视图内弹窗，不切设备中心）。 */
export function requestBotCreate(): void {
	window.dispatchEvent(new Event(EVENT));
}

export function subscribeBotCreateRequest(handler: () => void): () => void {
	window.addEventListener(EVENT, handler);
	return () => window.removeEventListener(EVENT, handler);
}
