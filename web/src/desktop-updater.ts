import { useCallback, useEffect, useState } from "react";
import { isDesktopShell, type DesktopShellWindow } from "./desktop.js";

const DESKTOP_REPO = "xing-shuyin/pi-web-ui";

export interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

interface DesktopUpdaterBridge {
	check: () => Promise<unknown>;
	download: () => Promise<unknown>;
	quitAndInstall: () => Promise<unknown>;
	onEvent: (cb: (msg: DesktopUpdaterEvent) => void) => () => void;
}

type DesktopUpdaterState = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";

interface DesktopUpdaterStatus {
	state: DesktopUpdaterState;
	version: string | null;
	percent: number;
	message: string | null;
}

export const INITIAL_DESKTOP_UPDATER_STATUS: DesktopUpdaterStatus = {
	state: "idle",
	version: null,
	percent: 0,
	message: null,
};

function clampPercent(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

export function reduceUpdaterEvent(prev: DesktopUpdaterStatus, event: DesktopUpdaterEvent): DesktopUpdaterStatus {
	switch (event.state) {
		case "checking":
			return { ...prev, state: "checking", message: null };
		case "available":
			return { ...prev, state: "available", version: event.version ?? prev.version, message: null };
		case "up-to-date":
			return { ...prev, state: "up-to-date", version: event.version ?? prev.version, message: null };
		case "downloading":
			return { ...prev, state: "downloading", percent: clampPercent(event.percent), message: null };
		case "downloaded":
			return {
				...prev,
				state: "downloaded",
				version: event.version ?? prev.version,
				percent: 100,
				message: null,
			};
		case "error":
			return { ...prev, state: "error", message: event.message ?? "unknown error" };
		default:
			return prev;
	}
}

export function getDesktopUpdaterBridge(win?: unknown): DesktopUpdaterBridge | null {
	if (!isDesktopShell(win)) return null;
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	const updater = (w as { piDesktop?: { updater?: DesktopUpdaterBridge } } | undefined)?.piDesktop?.updater;
	if (!updater || typeof updater.check !== "function" || typeof updater.download !== "function") return null;
	return updater;
}

function invokeMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function desktopReleasesUrl(version: string | null | undefined): string {
	const v = (version ?? "").trim().replace(/^v/, "");
	return v
		? `https://github.com/${DESKTOP_REPO}/releases/tag/v${v}`
		: `https://github.com/${DESKTOP_REPO}/releases/latest`;
}

export function useDesktopUpdater(): DesktopUpdaterStatus & {
	bridge: DesktopUpdaterBridge | null;
	check: () => void;
	download: () => void;
	quitAndInstall: () => void;
} {
	const [bridge] = useState<DesktopUpdaterBridge | null>(() => getDesktopUpdaterBridge());
	const [status, setStatus] = useState<DesktopUpdaterStatus>(INITIAL_DESKTOP_UPDATER_STATUS);

	useEffect(() => {
		if (!bridge) return;
		return bridge.onEvent((msg) => setStatus((prev) => reduceUpdaterEvent(prev, msg)));
	}, [bridge]);

	const check = useCallback(() => {
		if (!bridge) return;
		setStatus((prev) => ({ ...prev, state: "checking", message: null }));
		bridge
			.check()
			.catch((err: unknown) => setStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) })));
	}, [bridge]);

	const download = useCallback(() => {
		if (!bridge) return;
		setStatus((prev) => ({ ...prev, state: "downloading", message: null }));
		bridge
			.download()
			.catch((err: unknown) => setStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) })));
	}, [bridge]);

	const quitAndInstall = useCallback(() => {
		if (!bridge) return;
		bridge
			.quitAndInstall()
			.catch((err: unknown) => setStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) })));
	}, [bridge]);

	return { ...status, bridge, check, download, quitAndInstall };
}
