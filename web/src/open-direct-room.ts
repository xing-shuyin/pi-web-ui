import { DEVICE_GROUPS_CHANGED, deviceGroupRequest } from "./components/DeviceGroupSection";

/**
 * Bot 入口跳转的唯一实现。
 *
 * 分层：左栏「智能体」区 = 对话入口，设备中心 = 管理入口；两边互相跳转都走这里，
 * 不再各写一份「fetch 幂等直聊房间 + 派发事件」的逻辑。
 *
 * - 直聊：沿用现有端点 `POST /api/device-center/bots/:id/direct-room`
 *   （deviceGroupRequest 走 appUrl + withToken，服务端为设备侧 userRoute，最终落 Hub 的
 *   `/api/bots/:id/direct-room`）；幂等拿到房间 id 后派发 `pi-web-ui:device-group-open` { roomId }。
 * - 管理：派发同一事件的空 detail，切到设备中心视图（LocalBots 卡片）。
 *
 * 事件名与 detail 形态都收在这里，避免组件各自硬编码。
 */

/** 打开设备中心的 Bot 管理入口（与 DeviceGroupSection「打开设备中心」一致：切到 devices 视图）。 */
export function openBotManagement(): void {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: {} }));
}

/** 打开一个已存在的房间视图（直聊房间与群房间共用同一视图）。 */
export function openRoomView(roomId: string): void {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: { roomId } }));
}

/**
 * 幂等开启与某 Bot 的直聊并打开，返回房间 id。
 * `knownRoomId` 是调用方缓存的直聊房间 id：命中时跳过请求；服务端本身也幂等，
 * 所以设备中心这类没有房间缓存的入口直接调用即可。
 */
export async function openDirectRoom(
	botId: string,
	options: { knownRoomId?: string; signal?: AbortSignal } = {},
): Promise<string> {
	const knownRoomId = options.knownRoomId;
	// deviceGroupRequest 自带 15s 超时；未传入 signal 时补一个不会主动 abort 的中性 signal。
	const roomId = knownRoomId
		? knownRoomId
		: (
				await deviceGroupRequest<{ room?: { id?: string } }>(
					`bots/${encodeURIComponent(botId)}/direct-room`,
					options.signal ?? new AbortController().signal,
					{},
				)
			).room?.id;
	if (!roomId) throw new Error("Direct room response is missing room.id");
	openRoomView(roomId);
	// 新建了直聊房间：通知左栏「智能体」区（及其它房间列表）重新拉取 rooms。
	if (!knownRoomId) window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
	return roomId;
}
