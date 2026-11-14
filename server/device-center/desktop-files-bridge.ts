import { desktopFileManager, type DesktopFileRequest } from "./desktop-file-manager.js";
import { desktopBrowserFiles } from "./desktop-files-browser.js";
import { fileChunkCrc } from "./desktop-files-protocol.js";

export function desktopFilesRequest(
	endpoint: (path: string) => string,
	local = false,
	session?: () => string,
): DesktopFileRequest {
	return async (path, method = "GET", body) => {
		const response = await fetch(endpoint(path), {
			method,
			credentials: "same-origin",
			cache: "no-store",
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(local ? { "x-pi-local-files": "1" } : {}),
				...(session ? { "x-pi-desktop-file-session": session() } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (response.status === 204) return null;
		const value: any = await response.json();
		if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
		return value;
	};
}

export function desktopFilesBridge(options: {
	frame: () => any;
	origin: string;
	nested: boolean;
	manager: (remote: DesktopFileRequest) => ReturnType<typeof desktopFileManager>;
}) {
	const win = Reflect.get(globalThis, "window") as any;
	let counter = 0,
		closed = false,
		popup: ReturnType<typeof desktopFileManager> | undefined;
	let target = "",
		epoch = 0;
	const channel = Array.from(win.crypto.getRandomValues(new Uint8Array(16)), (x: any) =>
		x.toString(16).padStart(2, "0"),
	).join("");
	const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: any }>();
	const remote: DesktopFileRequest = (path, method = "GET", body) =>
		new Promise((resolve, reject) => {
			if (closed) return reject(new Error("File transfer closed"));
			const id = ++counter,
				timer = win.setTimeout(() => {
					pending.delete(id);
					reject(new Error("File request timed out; resume to retry"));
				}, 120000);
			pending.set(id, { resolve, reject, timer });
			options.frame()?.postMessage({ type: "desktop-files-call", channel, id, path, method, body }, "*");
		});
	const receive = (event: any) => {
		const data = event.data;
		if (!data || typeof data.type !== "string") return;
		if (options.nested && event.source === win.parent && win.parent !== win && data.type === "desktop-files-call") {
			options.frame()?.postMessage(data, "*");
			return;
		}
		if (
			event.source !== options.frame() ||
			event.origin !== options.origin ||
			!["desktop-files-show", "desktop-files-result", "desktop-files-target"].includes(data.type)
		)
			return;
		if (options.nested) {
			win.parent.postMessage(data, "*");
			return;
		}
		if (["desktop-files-target", "desktop-files-show"].includes(data.type)) {
			if (typeof data.target !== "string" || !/^[a-f0-9]{32}$/.test(data.target)) return;
			if (target !== data.target) {
				target = data.target;
				epoch++;
				popup?.close();
				popup = undefined;
				for (const item of pending.values()) {
					win.clearTimeout(item.timer);
					item.reject(new Error("Remote device changed"));
				}
				pending.clear();
			}
			if (data.type === "desktop-files-target") return;
		}
		if (data.type === "desktop-files-show") {
			const owner = epoch;
			popup ??= options.manager((...args) =>
				owner === epoch ? remote(...args) : Promise.reject(new Error("Remote device changed; reopen file transfer")),
			);
			void popup.open();
			return;
		}
		if (data.channel !== channel || !Number.isSafeInteger(data.id)) return;
		const item = pending.get(data.id);
		if (!item) return;
		pending.delete(data.id);
		win.clearTimeout(item.timer);
		if (typeof data.error === "string") item.reject(new Error(data.error));
		else item.resolve(data.value);
	};
	win.addEventListener("message", receive);
	return {
		close() {
			closed = true;
			win.removeEventListener("message", receive);
			popup?.close();
			for (const item of pending.values()) {
				win.clearTimeout(item.timer);
				item.reject(new Error("Remote device changed; reopen file transfer"));
			}
			pending.clear();
		},
	};
}

export function desktopFilesPortalScript(localPath?: string) {
	const path = localPath?.replace(/\/clipboard-ws(?:\?.*)?$/, "/files/");
	return `const filesBridge=(()=>{const __name=fn=>fn;const crc=${fileChunkCrc.toString()}, browser=${desktopBrowserFiles.toString()}, request=${desktopFilesRequest.toString()}, manager=${desktopFileManager.toString()};return (${desktopFilesBridge.toString()})({frame:()=>frame.contentWindow,origin:'null',nested:parent!==window,manager:remote=>manager({remote,crc,browser:()=>browser(crc),local:${JSON.stringify(path ?? null)}&&['localhost','127.0.0.1','[::1]'].includes(location.hostname)?request(path=>new URL(path,${JSON.stringify(path ?? null)}).href,true):undefined})});})();addEventListener('pagehide',()=>filesBridge.close());`;
}
