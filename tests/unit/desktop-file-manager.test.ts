// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { desktopFileManager } from "../../server/device-center/desktop-file-manager.js";
import { desktopBrowserFiles } from "../../server/device-center/desktop-files-browser.js";
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

it("sorts each pane independently and selects the requested file in its containing folder", async () => {
	const home = "C:\\Downloads",
		file = home + "\\report10.zip";
	const entries = [
		{ name: "report10.zip", path: file, modified: 6000, size: 10, directory: false },
		{ name: "report2.zip", path: home + "\\report2.zip", modified: 3000, size: 20, directory: false },
		{ name: "out", path: home + "\\out", directory: true },
	];
	const request = async (path: string) =>
		path === "info"
			? { device: "test", home, roots: [] }
			: {
					path: home,
					parent: "C:\\",
					entries: entries.slice(),
					selected: decodeURIComponent(path.slice(10)) === file ? file : undefined,
				};
	const legacyRemote = async (path: string) => {
		if (decodeURIComponent(path.slice(10)) === file) throw new Error("ENOTDIR: not a directory");
		return request(path);
	};
	const manager = desktopFileManager({ local: request, remote: legacyRemote, crc: fileChunkCrc, browser: () => null });
	try {
		const dialog = document.querySelector("dialog")!;
		dialog.showModal = () => dialog.setAttribute("open", "");
		await manager.open();
		const [left, right] = dialog.querySelectorAll<HTMLElement>(".fm-pane");
		const labels = (pane: HTMLElement) =>
			[...pane.querySelectorAll("tbody input")].map((n) => n.getAttribute("aria-label"));
		const sort = (pane: HTMLElement, index: number) =>
			pane.querySelectorAll<HTMLButtonElement>(".fm-sort")[index].click();
		expect(labels(left)).toEqual(["out", "report2.zip", "report10.zip"]);
		const path = left.querySelector<HTMLInputElement>(".fm-path")!;
		path.value = '"' + file + '"';
		path.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		const selected = () => left.querySelector<HTMLInputElement>('input[aria-label="report10.zip"]')!;
		await vi.waitFor(() => expect(selected().checked).toBe(true));
		expect(path.value).toBe(home);
		sort(left, 1);
		expect(labels(left)).toEqual(["out", "report10.zip", "report2.zip"]);
		expect(left.querySelector("[aria-sort=descending]")?.textContent).toBe("Modified");
		expect(labels(right)).toEqual(["out", "report2.zip", "report10.zip"]);
		sort(left, 1);
		expect(labels(left)).toEqual(labels(right));
		sort(left, 2);
		expect(labels(left)).toEqual(["out", "report2.zip", "report10.zip"]);
		sort(left, 2);
		expect(labels(left)).toEqual(["out", "report10.zip", "report2.zip"]);
		expect(selected().checked).toBe(true);
		const remotePath = right.querySelector<HTMLInputElement>(".fm-path")!;
		remotePath.value = "report10.zip";
		remotePath.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await vi.waitFor(() =>
			expect(right.querySelector<HTMLInputElement>('input[aria-label="report10.zip"]')!.checked).toBe(true),
		);
		expect(remotePath.value).toBe(home);
	} finally {
		manager.close();
	}
});

it("locates browser-picked files and rejects unselected paths", async () => {
	const browser = desktopBrowserFiles(fileChunkCrc);
	const zip = new File(["archive"], "report.zip");
	Object.defineProperty(zip, "webkitRelativePath", { value: "folder/report.zip" });
	const pick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
		Object.defineProperty(this, "files", { value: [zip] });
		this.dispatchEvent(new Event("change"));
	});
	try {
		browser.pick(true, () => {});
		const result = await browser.request("list?path=/folder/report.zip");
		expect(result).toMatchObject({
			path: "/folder",
			parent: "/",
			selected: "/folder/report.zip",
			entries: [{ name: "report.zip" }],
		});
		await expect(browser.request("list?path=/other.zip")).rejects.toThrow();
		await expect(browser.request("list?path=/../folder/report.zip")).rejects.toThrow();
	} finally {
		pick.mockRestore();
		browser.close();
	}
});
