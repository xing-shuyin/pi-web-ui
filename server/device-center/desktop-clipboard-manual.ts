export function manualClipboardControls(options: {
	host: { append(node: any): void };
	post: (value: object) => void;
	zh: boolean;
}) {
	const document = Reflect.get(globalThis, "document") as { createElement(tag: string): any };
	const navigator = Reflect.get(globalThis, "navigator") as { clipboard?: { writeText(value: string): Promise<void> } };
	const { host, post, zh } = options;
	const panel = document.createElement("details");
	panel.className = "browser-clipboard";
	panel.hidden = true;
	const summary = document.createElement("summary");
	summary.textContent = zh ? "剪贴板 · 浏览器文本传递" : "Clipboard · browser text transfer";
	const text = document.createElement("textarea");
	text.setAttribute("aria-label", zh ? "剪贴板文本" : "Clipboard text");
	text.placeholder = zh ? "在这里粘贴文本，再发送到远程剪贴板" : "Paste text here, then send to the remote clipboard";
	text.maxLength = 16384;
	const actions = document.createElement("div"),
		note = document.createElement("p"),
		status = document.createElement("span");
	status.setAttribute("role", "status");
	note.textContent = zh
		? "浏览器模式需手动发送/接收文本（最多 16 KiB）。文本、图片、文件自动同步请从本机 localhost 的 pi-web-ui 打开设备。"
		: "Manually send/receive text (up to 16 KiB). For automatic text, image and file sync, open the device from your local pi-web-ui.";
	const button = (label: string, run: () => void) => {
		const element = document.createElement("button");
		element.type = "button";
		element.textContent = label;
		element.onclick = run;
		actions.append(element);
		return element;
	};
	let channel = "",
		busy = false,
		connected = false,
		readOnly = true;
	let pending: object | undefined, timer: ReturnType<typeof setTimeout> | undefined;
	const send = (payload: object) => post({ type: "desktop-clipboard", channel, payload });
	const controls = () => {
		put.disabled = busy || !connected || readOnly;
		get.disabled = busy || !connected;
	};
	const stop = () => {
		clearTimeout(timer);
		if (channel) send({ type: "bridge-stop" });
		channel = "";
		busy = false;
		pending = undefined;
		controls();
	};
	const fail = () => {
		stop();
		status.textContent = zh
			? "传递失败，请检查连接并更新被控端。"
			: "Transfer failed. Check the connection and update the remote device.";
	};
	const request = (payload: object) => {
		if (busy || !connected) return;
		if (JSON.stringify(payload).length > 48000) {
			status.textContent = zh ? "文本编码后超过传递限制。" : "Encoded text exceeds the transfer limit.";
			return;
		}
		stop();
		busy = true;
		controls();
		pending = payload;
		channel = "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
			(Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16),
		);
		status.textContent = zh ? "正在传递…" : "Transferring…";
		send({ type: "bridge-text-start", mode: readOnly ? "receive" : "both" });
		timer = setTimeout(fail, 15000);
	};
	const put = button(zh ? "发送到远程" : "Send to remote", () => {
		if (new TextEncoder().encode(text.value).length > 16384) {
			status.textContent = zh ? "文本超过 16 KiB。" : "Text exceeds 16 KiB.";
			return;
		}
		request({ type: "text-write", text: text.value });
	});
	const get = button(zh ? "读取远程文本" : "Read remote text", () => request({ type: "text-read" }));
	button(zh ? "复制到本机" : "Copy locally", () => {
		text.focus();
		text.select();
		if (navigator.clipboard?.writeText) {
			void navigator.clipboard
				.writeText(text.value)
				.then(() => {
					status.textContent = zh ? "已复制到本机。" : "Copied locally.";
				})
				.catch(() => {
					status.textContent = zh ? "请按 Ctrl/Cmd+C 复制选中的文本。" : "Press Ctrl/Cmd+C to copy the selected text.";
				});
		} else status.textContent = zh ? "请按 Ctrl/Cmd+C 复制选中的文本。" : "Press Ctrl/Cmd+C to copy the selected text.";
	});
	panel.append(summary, text, actions, status, note);
	host.append(panel);
	controls();
	panel.addEventListener("toggle", () => {
		if (!panel.open) stop();
	});
	return {
		receive(data: any) {
			if (data?.type === "desktop-clipboard-available") {
				connected = data.connected === true;
				readOnly = data.viewOnly !== false;
				panel.hidden = !connected;
				if (!connected) {
					stop();
					text.value = "";
					status.textContent = "";
				}
				controls();
				return;
			}
			if (data?.type !== "desktop-clipboard" || !channel || data.channel !== channel) return;
			const value = data.payload;
			if (value?.type === "clipboard-ready" && pending) {
				const next = pending;
				pending = undefined;
				send(next);
			} else if (value?.type === "text-result") {
				if (typeof value.text === "string" && new TextEncoder().encode(value.text).length <= 16384)
					text.value = value.text;
				stop();
				status.textContent = value.error
					? zh
						? "当前内容不是文本、超过限制或无法读取。图片和文件请使用本机客户端同步。"
						: "Not text, too large, or unavailable. Use the local client for images and files."
					: value.written
						? zh
							? "已写入远程剪贴板，可在远程粘贴。"
							: "Written to remote clipboard. Paste on the remote computer."
						: zh
							? "已读取，可选中复制或点击复制到本机。"
							: "Received. Select and copy, or click Copy locally.";
			} else if (value?.type === "clipboard-error" || value?.type === "clipboard-stopped") fail();
		},
		close() {
			stop();
			panel.remove();
		},
	};
}

export const manualClipboardCss = `.browser-clipboard{flex:none;padding:6px 10px;background:var(--bg-elev,#17181c);color:var(--text,#eee);font:12px system-ui;max-height:38vh;overflow:auto}.browser-clipboard[hidden]{display:none}.browser-clipboard summary{cursor:pointer}.browser-clipboard textarea{box-sizing:border-box;display:block;width:100%;height:70px;margin:8px 0;background:var(--bg,#17181c);color:inherit;border:1px solid var(--border,#555);border-radius:6px;resize:vertical}.browser-clipboard button{margin:0 6px 6px 0;padding:5px 8px;font:inherit;background:var(--bg,#303137);color:inherit;border:1px solid var(--border,#555);border-radius:6px}.browser-clipboard p{margin:6px 0;max-width:none;overflow-wrap:anywhere}.browser-clipboard button:disabled{opacity:.5}`;
