import { desktopFileManager } from "./desktop-file-manager.js";
import { desktopBrowserFiles } from "./desktop-files-browser.js";
import { desktopFilesRequest } from "./desktop-files-bridge.js";
import { fileChunkCrc } from "./desktop-files-protocol.js";

export function desktopFilesPageScript() {
	return `(()=>{const __name=fn=>fn;const request=(${desktopFilesRequest.toString()}),crc=(${fileChunkCrc.toString()}),browser=(${desktopBrowserFiles.toString()}),manager=(${desktopFileManager.toString()});(${desktopFilesPage.toString()})(request,()=>manager({remote:request(path=>new URL('api/device-desktop/files/'+path,document.baseURI).href,false,()=>filesSession),local:['localhost','127.0.0.1','[::1]'].includes(location.hostname)?request(path=>new URL('api/device-desktop/local/files/'+path,document.baseURI).href,true):undefined,crc,browser:()=>browser(crc)}),()=>filesSession);})();`;
}

function desktopFilesPage(
	request: typeof desktopFilesRequest,
	create: () => ReturnType<typeof desktopFileManager>,
	session: () => string,
) {
	const win = Reflect.get(globalThis, "window") as any,
		doc = win.document;
	const button = doc.createElement("button");
	button.id = "file-transfer";
	button.type = "button";
	button.textContent = (win.navigator.language || "en").startsWith("zh") ? "文件传输" : "File transfer";
	doc.getElementById("clipboard")?.after(button);
	const api = request((path) => new URL("api/device-desktop/files/" + path, doc.baseURI).href, false, session);
	const target = Array.from(win.crypto.getRandomValues(new Uint8Array(16)), (v: any) =>
		v.toString(16).padStart(2, "0"),
	).join("");
	if (win.parent !== win) win.parent.postMessage({ type: "desktop-files-target", target }, "*");
	let popup: ReturnType<typeof desktopFileManager> | undefined,
		busy = 0;
	button.onclick = () => {
		if (win.parent !== win) win.parent.postMessage({ type: "desktop-files-show", target }, "*");
		else {
			popup ??= create();
			void popup.open();
		}
	};
	win.addEventListener("pagehide", () => popup?.close());
	win.addEventListener("message", async (event: any) => {
		const data = event.data;
		if (
			event.source !== win.parent ||
			win.parent === win ||
			data?.type !== "desktop-files-call" ||
			!Number.isSafeInteger(data.id) ||
			typeof data.channel !== "string" ||
			!/^[a-f0-9]{32}$/.test(data.channel)
		)
			return;
		const reply = (result: any) =>
			win.parent.postMessage({ type: "desktop-files-result", id: data.id, channel: data.channel, ...result }, "*");
		if (
			typeof data.path !== "string" ||
			data.path.length > 8192 ||
			!/^(?:info|list|mkdir|download|jobs(?:\/[a-f0-9]{32}(?:\/(?:chunk|finish))?)?|exports(?:\/[a-f0-9]{32}(?:\/chunk)?)?)(?:\?[^#]*)?$/.test(
				data.path,
			) ||
			!["GET", "POST", "PUT", "DELETE"].includes(data.method) ||
			JSON.stringify(data.body ?? null).length > 2 * 1024 ** 2
		) {
			reply({ error: "Invalid file request" });
			return;
		}
		if (busy >= 4) {
			reply({ error: "Too many file requests" });
			return;
		}
		busy++;
		try {
			if (data.path === "download") {
				const item = await api("downloads", "POST", data.body),
					link = doc.createElement("a");
				link.href = new URL("api/device-desktop/files/download/" + item.id, doc.baseURI).href;
				link.download = item.name;
				doc.body.append(link);
				link.click();
				link.remove();
				reply({ value: { started: true } });
			} else {
				const value = await api(data.path, data.method, data.body);
				if (data.path === "info") {
					const style = win.getComputedStyle(doc.documentElement);
					value.theme = Object.fromEntries(
						["--bg", "--bg-elev", "--border", "--text", "--text-dim", "--accent", "--red"].map((key) => [
							key,
							style.getPropertyValue(key).trim(),
						]),
					);
				}
				reply({ value });
			}
		} catch (error: any) {
			reply({ error: error.message });
		} finally {
			busy--;
		}
	});
}
