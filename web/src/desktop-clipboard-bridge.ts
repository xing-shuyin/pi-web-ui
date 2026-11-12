import { clipboardBrowserBridge, type ClipboardSocket } from "../../server/device-center/desktop-clipboard-bridge";
export function createClipboardBridge(options: {
	frame: () => Window | null;
	origin: string;
	localUrl: string;
	state: (status: string) => void;
}) {
	const bridge = clipboardBrowserBridge({
		open: () => new WebSocket(options.localUrl) as unknown as ClipboardSocket,
		id: () => crypto.randomUUID(),
		post: (data) => options.frame()?.postMessage(data, "*"),
		state: options.state,
	});
	const receive = (event: MessageEvent) => {
		if (event.source === options.frame() && event.origin === options.origin) bridge.receive(event.data);
	};
	window.addEventListener("message", receive);
	return {
		set: bridge.set,
		close() {
			bridge.close();
			window.removeEventListener("message", receive);
		},
	};
}
