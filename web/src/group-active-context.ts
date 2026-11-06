import { useSyncExternalStore } from "react";
import type { GroupDetail, GroupDevice, GroupBotConversation } from "./device-group-messages";

export type GroupRightTab = "files" | "deliveries" | "transfers" | "canvas" | "presets" | "bots";

export interface ActiveGroupState {
	roomId: string;
	detail: GroupDetail | null;
	devices: GroupDevice[];
	members: GroupDevice[];
	conversations: GroupBotConversation[];
	attentionCount: number;
	activeRightTab: GroupRightTab;
	disabled: boolean;
	conversationError: string;
	onToggleCollapse?: () => void;
	isRightCollapsed?: boolean;
}

export type ActiveGroupRoomData = Omit<ActiveGroupState, "activeRightTab" | "onToggleCollapse" | "isRightCollapsed">;

let currentState: ActiveGroupState | null = null;
const listeners = new Set<() => void>();

function notify() {
	for (const listener of listeners) {
		listener();
	}
}

export function setActiveGroupRoomData(data: ActiveGroupRoomData | null) {
	if (!data) {
		if (currentState !== null) {
			currentState = null;
			notify();
		}
		return;
	}

	const isSameRoom = Boolean(currentState && currentState.roomId === data.roomId);
	const nextTab =
		isSameRoom && currentState ? currentState.activeRightTab : data.attentionCount > 0 ? "deliveries" : "files";

	if (
		currentState &&
		isSameRoom &&
		currentState.detail === data.detail &&
		currentState.devices === data.devices &&
		currentState.members === data.members &&
		currentState.conversations === data.conversations &&
		currentState.attentionCount === data.attentionCount &&
		currentState.disabled === data.disabled &&
		currentState.conversationError === data.conversationError &&
		currentState.activeRightTab === nextTab
	) {
		return;
	}

	currentState = {
		...currentState,
		...data,
		activeRightTab: nextTab,
	};
	notify();
}

export function setActiveGroupState(state: ActiveGroupState | null) {
	if (!state) {
		setActiveGroupRoomData(null);
		return;
	}
	const {
		activeRightTab,
		onToggleCollapse: _onToggleCollapse,
		isRightCollapsed: _isRightCollapsed,
		...roomData
	} = state;
	setActiveGroupRoomData(roomData);
	if (activeRightTab && currentState && currentState.roomId !== state.roomId) {
		currentState.activeRightTab = activeRightTab;
		notify();
	}
}

export function updateActiveGroupField<K extends keyof ActiveGroupState>(key: K, value: ActiveGroupState[K]) {
	if (!currentState) return;
	if (currentState[key] === value) return;
	currentState = { ...currentState, [key]: value };
	notify();
}

export function switchActiveGroupRightTab(tab: GroupRightTab, autoExpand = true) {
	if (!currentState) return;
	if (currentState.activeRightTab === tab) {
		if (autoExpand && currentState.isRightCollapsed && currentState.onToggleCollapse) {
			currentState.onToggleCollapse();
		}
		return;
	}
	currentState = { ...currentState, activeRightTab: tab };
	if (autoExpand && currentState.isRightCollapsed && currentState.onToggleCollapse) {
		currentState.onToggleCollapse();
	}
	notify();
}

export function getActiveGroupState(): ActiveGroupState | null {
	return currentState;
}

export function getActiveGroupRightTab(): GroupRightTab {
	return currentState?.activeRightTab ?? "files";
}

export function useActiveGroupState(): ActiveGroupState | null {
	return useSyncExternalStore(
		(callback) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
		getActiveGroupState,
		getActiveGroupState,
	);
}

export function useActiveGroupRightTab(): GroupRightTab {
	return useSyncExternalStore(
		(callback) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
		getActiveGroupRightTab,
		() => "files",
	);
}
