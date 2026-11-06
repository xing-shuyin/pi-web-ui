import { renameRemote, sftpCall, isSafeRemoteName, makeRemoteMkdir } from "./engine.mjs";

export const MAX_READ_BYTES = 2 * 1024 * 1024;

export function assertRemotePath(p, label = "路径") {
	const s = String(p ?? "").trim();
	if (!s.startsWith("/")) throw new Error(`${label}必须是绝对路径（以 / 开头）：${s || "(空)"}`);
	if (s.split("/").some((seg) => seg === "..")) throw new Error(`${label}不能含 ..：${s}`);
	return s;
}

export async function remoteList(sftp, dir) {
	const d = assertRemotePath(dir || "/", "目录");
	const list = await sftpCall(sftp, "readdir", d);
	const out = [];
	for (const f of list ?? []) {
		if (!isSafeRemoteName(f?.filename)) continue;
		const attrs = f.attrs ?? {};
		const isDir = typeof attrs.isDirectory === "function" ? attrs.isDirectory() : false;
		const isFile = typeof attrs.isFile === "function" ? attrs.isFile() : !isDir;
		if (!isDir && !isFile) continue;
		out.push({
			name: f.filename,
			type: isDir ? "dir" : "file",
			size: Number(attrs.size) || 0,
			mtime: typeof attrs.mtime === "number" ? Math.floor(attrs.mtime) * 1000 : null,
			path: `${d.replace(/\/+$/, "")}/${f.filename}`,
		});
	}
	out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	return out;
}

export async function remoteRead(sftp, p, maxBytes = MAX_READ_BYTES) {
	const file = assertRemotePath(p);
	const st = await sftpCall(sftp, "stat", file).catch(() => null);
	if (!st) throw new Error(`远端文件不存在：${file}`);
	if (Number(st.size) > maxBytes) {
		throw new Error(`文件过大（${st.size} 字节 > ${maxBytes}）——同步到本地用编辑器打开，或调大上限`);
	}
	const buf = await sftpCall(sftp, "readFile", file);
	return { path: file, size: Number(st.size) || buf.length, data: buf };
}

export async function remoteWrite(sftp, p, data) {
	const file = assertRemotePath(p);
	const mkdirp = makeRemoteMkdir(sftp);
	const idx = file.lastIndexOf("/");
	const dir = idx <= 0 ? "/" : file.slice(0, idx);
	await mkdirp(dir);
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
	const tmp = `${dir}/.sftp-tmp-${process.pid}-${(seq++).toString(36)}-${file.slice(idx + 1)}`;
	await sftpCall(sftp, "writeFile", tmp, buf);
	await renameRemote(sftp, tmp, file);
	return { path: file, bytes: buf.length };
}

export async function remoteMkdir(sftp, p) {
	const dir = assertRemotePath(p, "目录");
	const mkdirp = makeRemoteMkdir(sftp);
	await mkdirp(dir);
	return { path: dir };
}

export async function remoteMove(sftp, from, to) {
	const a = assertRemotePath(from, "源路径");
	const b = assertRemotePath(to, "目标路径");
	await renameRemote(sftp, a, b);
	return { from: a, to: b };
}

/**
 * 递归删除。`trash` 给定时走「先挪进垃圾桶」而不是真删（同步引擎的删除保护同款）。
 * @returns {Promise<{removed: number, trashed: string[]|null}>}
 */
export async function remoteRemove(sftp, p, { trash } = {}) {
	const target = assertRemotePath(p);
	const mkdirp = makeRemoteMkdir(sftp);
	let removed = 0;
	const trashed = trash ? [] : null;

	async function moveToTrash(abs, rootAbs, stamp) {
		const rel = abs.slice(String(rootAbs).replace(/\/+$/, "").length).replace(/^\/+/, "");
		const dst = `${String(rootAbs).replace(/\/+$/, "")}/.sftp-trash/${stamp}/${rel}`;
		const di = dst.lastIndexOf("/");
		await mkdirp(di <= 0 ? "/" : dst.slice(0, di));
		await renameRemote(sftp, abs, dst);
		trashed.push(dst);
	}

	async function walk(abs) {
		let st;
		try {
			st = await sftpCall(sftp, "stat", abs);
		} catch {
			return;
		}
		const isDir = typeof st.isDirectory === "function" ? st.isDirectory() : false;
		if (!isDir) {
			if (trash) await moveToTrash(abs, trash.root, trash.stamp);
			else await sftpCall(sftp, "unlink", abs);
			removed++;
			return;
		}
		const list = await sftpCall(sftp, "readdir", abs).catch(() => []);
		const kids = (list ?? []).map((f) => f.filename).filter((n) => isSafeRemoteName(n));
		for (const name of kids) await walk(`${abs.replace(/\/+$/, "")}/${name}`);
		if (trash && abs === String(trash.root).replace(/\/+$/, "")) return;
		if (trash) await moveToTrash(abs, trash.root, trash.stamp);
		else await sftpCall(sftp, "rmdir", abs).catch(() => {});
		removed++;
	}

	await walk(target);
	return { removed, trashed };
}

let seq = 0;
