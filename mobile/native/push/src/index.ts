import { registerPlugin } from "@capacitor/core";
import type { ConnectionCredentials, PiCredentialsPlugin, PiPushPlugin, PushNotification } from "./definitions";

export type * from "./definitions";

const nativePush = registerPlugin<
	Omit<PiPushPlugin, "getPendingNotification"> & {
		getPendingNotification(): Promise<{ notification: PushNotification | null }>;
	}
>("PiPush");

export const PiPush: PiPushPlugin = {
	getStatus: () => nativePush.getStatus(),
	enable: () => nativePush.enable(),
	disable: () => nativePush.disable(),
	openSystemSettings: () => nativePush.openSystemSettings(),
	getPendingNotification: async () => (await nativePush.getPendingNotification()).notification,
	addListener: nativePush.addListener.bind(nativePush),
};

const nativeCredentials = registerPlugin<
	Omit<PiCredentialsPlugin, "get"> & {
		get(): Promise<{ credentials: ConnectionCredentials | null }>;
	}
>("PiCredentials");

export const PiCredentials: PiCredentialsPlugin = {
	get: async () => (await nativeCredentials.get()).credentials,
	set: (credentials) => nativeCredentials.set(credentials),
	clear: () => nativeCredentials.clear(),
};
