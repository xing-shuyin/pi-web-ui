import { BrowserWindow, Menu } from "electron";
import { createHash } from "node:crypto";
import { hubBrowserOrigin } from "./external-url.js";

export function createHubBrowser() {
	const windows = new Map<string, BrowserWindow>();
	return async (raw: string): Promise<boolean> => {
		const origin = hubBrowserOrigin(raw);
		if (!origin) throw new Error("Invalid device center URL");
		const url = new URL(raw);
		const lanAccess = /^\/(?:[A-Za-z0-9_-]+\/)*device-lan\/[^/]+\/__open$/.test(url.pathname);
		const deviceAccess =
			lanAccess || url.pathname === "/__device/open" || /^\/device\/[^/]+\/__open$/.test(url.pathname);
		const fallbackOrigins = lanAccess
			? [url.searchParams.get("hub"), url.searchParams.get("portal")]
					.map(hubBrowserOrigin)
					.filter((value): value is string => value !== null)
			: [];
		const key = deviceAccess
			? `${origin}${url.pathname}?next=${url.searchParams.get("next") || "/"}&fallback=${fallbackOrigins.join(",")}`
			: origin;
		const existing = windows.get(key);
		if (existing && !existing.isDestroyed()) {
			if (existing.isMinimized()) existing.restore();
			existing.show();
			existing.focus();
			if (deviceAccess) await existing.loadURL(raw);
			return true;
		}
		const win = new BrowserWindow({
			width: 1080,
			height: 800,
			minWidth: 640,
			minHeight: 480,
			title: `Device Center — ${origin}`,
			webPreferences: {
				partition: `persist:hub-${createHash("sha256").update(origin).digest("hex")}`,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
			},
		});
		windows.set(key, win);
		win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		win.webContents.session.setPermissionCheckHandler(() => false);
		win.webContents.on("will-attach-webview", (event) => event.preventDefault());
		const allowed = (url: string) => {
			const targetOrigin = hubBrowserOrigin(url);
			return targetOrigin === origin || (targetOrigin !== null && fallbackOrigins.includes(targetOrigin));
		};
		win.webContents.on("will-navigate", (event, url) => {
			if (!allowed(url)) event.preventDefault();
		});
		win.webContents.on("will-redirect", (event, url) => {
			if (!allowed(url)) event.preventDefault();
		});
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (allowed(url)) void win.loadURL(url).catch(() => {});
			return { action: "deny" };
		});
		win.on("page-title-updated", (event) => {
			event.preventDefault();
			win.setTitle(`Device Center — ${origin}`);
		});
		win.setMenu(
			Menu.buildFromTemplate([
				{
					label: "←",
					click: () => {
						if (win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
					},
				},
				{
					label: "→",
					click: () => {
						if (win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
					},
				},
				{ role: "reload" },
				{
					label: origin,
					click: () => {
						void win.loadURL(origin).catch(() => {});
					},
				},
			]),
		);
		win.on("closed", () => {
			if (windows.get(key) === win) windows.delete(key);
		});
		try {
			await win.loadURL(raw);
			return true;
		} catch (error) {
			win.destroy();
			throw error;
		}
	};
}
