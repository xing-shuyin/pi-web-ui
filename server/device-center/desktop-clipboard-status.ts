/** Shared by trusted clipboard controls. Transient errors never erase the saved direction. */
export function clipboardStatus(code: string, zh: boolean): string | undefined {
	if (code === "clipboard-preparing")
		return zh
			? "正在读取并校验本次复制的内容；完成前请勿粘贴，剪贴板仍可能是旧文件。"
			: "Reading and checking this copy. Wait before pasting; the clipboard may still contain old files.";
	if (code === "clipboard-complete")
		return zh ? "本次复制已同步完成，可以粘贴。" : "This copy has finished syncing. Ready to paste.";
	if (code.startsWith("clipboard-progress:")) {
		const [, , bytes, total] = code.split(":");
		const done = Number(bytes),
			size = Number(total);
		if (!Number.isFinite(done) || !Number.isFinite(size) || size <= 0) return;
		const unit = (n: number) =>
			n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GiB" : (n / 1048576).toFixed(1) + " MiB";
		return `${zh ? "正在传输" : "Transferring"} ${unit(done)} / ${unit(size)} · ${Math.floor((done / size) * 100)}%`;
	}
	if (!code.startsWith("warning:")) return;
	const messages: Record<string, [string, string]> = {
		"clipboard-folder": [
			"文件夹没有同步，剪贴板仍是原来的内容。请点击“文件传输”选择文件夹发送。",
			"Folder not synced; the previous clipboard is unchanged. Use File transfer → Send folder.",
		],
		"clipboard-size": [
			"本次内容超出对端支持的大小。大文件需要两端都更新；同步方向已保留，请重新复制。",
			"Content exceeds the peer's limit. Update both endpoints for large files. Direction is retained; copy again.",
		],
		"clipboard-space": [
			"接收端磁盘空间或临时文件配额不足。清理空间后重新复制；同步仍开启。",
			"The receiver has insufficient disk space or temporary quota. Free space and copy again; sync remains enabled.",
		],
		"clipboard-changed": [
			"文件在传输时发生变化。请等待文件写入完成后重新复制；同步仍开启。",
			"The source file changed. Wait until writing finishes, then copy again; sync remains enabled.",
		],
		"clipboard-timeout": [
			"本次传输超时，请检查连接后重新复制；同步方向已保留。",
			"This transfer timed out. Check the connection and copy again; direction is retained.",
		],
	};
	return (messages[code.slice(8)] ?? [
		"本次复制失败，剪贴板仍是原来的内容。请重新复制，或使用“文件传输”；同步仍开启。",
		"This copy failed; the previous clipboard is unchanged. Copy again or use File transfer; sync remains enabled.",
	])[zh ? 0 : 1];
}
