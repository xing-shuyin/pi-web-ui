// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { desktopFileManager } from "../../server/device-center/desktop-file-manager.js";
import { fileChunkCrc } from "../../server/device-center/desktop-files-protocol.js";

it("disables remote writes in view-only mode and updates after reconnecting with control", async () => {
	let readOnly = true;
	document.documentElement.style.setProperty("--bg", "#ffffff");
	const local = vi.fn(async (path: string) =>
		path === "info"
			? { device: "local", home: "/", roots: [] }
			: { path: "/", parent: "/", entries: [{ name: "one.txt", path: "/one.txt", directory: false, size: 1 }] },
	);
	const remote = vi.fn(async (path: string) =>
		path === "info" ? { device: "remote", home: "/", roots: [], readOnly } : { path: "/", parent: "/", entries: [] },
	);
	const manager = desktopFileManager({
		local,
		remote,
		crc: fileChunkCrc,
		browser: () => {
			throw new Error("unexpected");
		},
	});
	const dialog = document.querySelector("#file-transfer-dialog") as HTMLDialogElement;
	dialog.showModal = () => dialog.setAttribute("open", "");
	dialog.close = () => dialog.removeAttribute("open");
	try {
		await manager.open();
		const checkbox = dialog.querySelector('input[aria-label="one.txt"]') as HTMLInputElement;
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event("change"));
		const send = [...dialog.querySelectorAll("button")].find((e) => e.textContent === "Send →") as HTMLButtonElement;
		const remoteMkdir = dialog
			.querySelectorAll(".fm-pane")[1]
			.querySelector('button[title="New folder"]') as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(remoteMkdir.disabled).toBe(true);
		readOnly = false;
		dialog.close();
		await manager.open();
		expect(send.disabled).toBe(false);
		expect(remoteMkdir.disabled).toBe(false);
	} finally {
		manager.close();
		document.documentElement.style.removeProperty("--bg");
	}
});
