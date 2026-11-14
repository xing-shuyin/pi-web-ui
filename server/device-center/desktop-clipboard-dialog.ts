/** Shared by trusted portal documents and the standalone desktop viewer. */
export function clipboardDialog(zh: boolean, onClose?: () => void) {
	const document = Reflect.get(globalThis, "document") as { createElement(tag: string): any; body: any };
	const dialog = document.createElement("dialog");
	dialog.className = "desktop-clipboard-dialog";
	dialog.setAttribute("aria-label", zh ? "剪贴板" : "Clipboard");
	const header = document.createElement("header"),
		title = document.createElement("strong"),
		close = document.createElement("button");
	title.textContent = zh ? "剪贴板" : "Clipboard";
	close.type = "button";
	close.textContent = zh ? "关闭" : "Close";
	close.onclick = () => dialog.close();
	dialog.addEventListener("close", () => onClose?.());
	header.append(title, close);
	const host = document.createElement("div");
	dialog.append(header, host);
	document.body.append(dialog);
	return {
		host,
		open() {
			if (!dialog.open) dialog.showModal();
		},
		hide() {
			dialog.close();
		},
		remove() {
			dialog.remove();
		},
	};
}

export const clipboardDialogCss = `.desktop-clipboard-dialog{box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-width:100%;max-height:calc(100dvh - 24px);padding:16px;border:1px solid var(--border,#555);border-radius:12px;background:var(--bg-elev,#17181c);color:var(--text,#eee);font:13px system-ui;overflow:auto;overscroll-behavior:contain;box-shadow:0 12px 40px #0005}.desktop-clipboard-dialog::backdrop{background:#0006}.desktop-clipboard-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.desktop-clipboard-dialog button{font:inherit;color:inherit;background:var(--bg-elev2,#303137);border:1px solid var(--border,#555);border-radius:6px;padding:5px 10px;cursor:pointer}.desktop-clipboard-dialog .browser-clipboard{max-height:none;padding:0}.desktop-clipboard-dialog .browser-clipboard textarea{height:130px;max-height:40vh}.desktop-clipboard-dialog #clipboard-bar{flex-wrap:wrap;padding:0}.desktop-clipboard-dialog p{color:var(--text-dim,#aaa)}`;
