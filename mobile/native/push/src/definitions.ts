import type { PluginListenerHandle } from "@capacitor/core";

export interface PushStatus {
	permission: "prompt" | "granted" | "denied";
	registrationId: string;
	enabled: boolean;
}

export interface PushNotification {
	extras: Record<string, string>;
}

export interface PiPushPlugin {
	getStatus(): Promise<PushStatus>;
	enable(): Promise<PushStatus>;
	disable(): Promise<void>;
	openSystemSettings(): Promise<void>;
	getPendingNotification(): Promise<PushNotification | null>;
	addListener(
		eventName: "registration",
		listener: (event: { registrationId: string }) => void,
	): Promise<PluginListenerHandle>;
	addListener(
		eventName: "notificationOpened" | "notificationReceived",
		listener: (event: PushNotification) => void,
	): Promise<PluginListenerHandle>;
}

export interface ConnectionCredentials {
	serverUrl: string;
	token: string;
	mode?: "hub" | "direct" | "local";
}

export interface PiCredentialsPlugin {
	get(): Promise<ConnectionCredentials | null>;
	set(credentials: ConnectionCredentials): Promise<void>;
	clear(): Promise<void>;
}
