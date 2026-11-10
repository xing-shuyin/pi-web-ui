/**
 * Android 本机引擎的 rename 兼容层（CJS preload，LocalEngineService 用 `--require` 注入）。
 *
 * 为什么需要：App 进程带 zygote 下发的 seccomp 过滤器（`/proc/<pid>/status` 的 `Seccomp_filters: 1`），
 * 过滤器让 `renameat2` 直接返回 ENOSYS；glibc 2.28+ 的 `rename()` 只走 `renameat2`、不做回退，
 * 于是 proot 里的 node 所有 rename 都失败：原子写（`writeAtomicSync`）、插件物化
 * （`plugin-materialize` 的 staging→目标）、会话落盘全部报 ENOSYS，引擎起来也存不住状态。
 * 同一个 rootfs / 同一个 proot 在 `adb run-as`（无 seccomp）下 rename 正常 —— 这不是 proot 的问题，
 * 也不是 rootfs 的问题，换 ABI 一样会复现。
 *
 * 做法：rename 抛 ENOSYS 时才降级成「复制 + 删源」。代价是丢掉原子性（系统里根本没有 rename 可用），
 * 换来的是进程能落盘；其它错误码原样抛出，绝不掩盖真实故障。
 */
"use strict";

const fs = require("node:fs");
const promises = require("node:fs/promises");

const UNSUPPORTED_CODES = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

let notified = false;

function noteDegraded() {
	if (notified) return;
	notified = true;
	process.stderr.write("[rename-compat] rename 返回 ENOSYS（Android App 沙盒），已降级为 copy + rm\n");
}

function isUnsupported(error) {
	return Boolean(error) && UNSUPPORTED_CODES.has(error.code);
}

function removeQuietly(target) {
	try {
		fs.rmSync(target, { recursive: true, force: true });
	} catch {}
}

/** 与 rename 等价的搬移：符号链接重建链接本身，目录整棵树复制后删源，文件覆盖复制后删源。 */
function moveSync(source, target) {
	const info = fs.lstatSync(source);
	if (info.isSymbolicLink()) {
		const link = fs.readlinkSync(source);
		removeQuietly(target);
		fs.symlinkSync(link, target);
	} else if (info.isDirectory()) {
		removeQuietly(target);
		fs.cpSync(source, target, { recursive: true, force: true, preserveTimestamps: true, dereference: false });
	} else {
		fs.copyFileSync(source, target);
	}
	removeQuietly(source);
}

async function moveAsync(source, target) {
	const info = await promises.lstat(source);
	if (info.isSymbolicLink()) {
		const link = await promises.readlink(source);
		await promises.rm(target, { recursive: true, force: true }).catch(() => {});
		await promises.symlink(link, target);
	} else if (info.isDirectory()) {
		await promises.rm(target, { recursive: true, force: true }).catch(() => {});
		await promises.cp(source, target, { recursive: true, force: true, preserveTimestamps: true, dereference: false });
	} else {
		await promises.copyFile(source, target);
	}
	await promises.rm(source, { recursive: true, force: true }).catch(() => {});
}

function install() {
	if (globalThis.__piRenameCompatInstalled) return;
	globalThis.__piRenameCompatInstalled = true;

	const renameSyncOriginal = fs.renameSync;
	const renameOriginal = fs.rename;
	const renameAsyncOriginal = promises.rename;

	fs.renameSync = function renameSync(source, target) {
		try {
			return renameSyncOriginal(source, target);
		} catch (error) {
			if (!isUnsupported(error)) throw error;
			noteDegraded();
			return moveSync(source, target);
		}
	};

	fs.rename = function rename(source, target, callback) {
		const done = typeof callback === "function" ? callback : () => {};
		renameOriginal(source, target, (error) => {
			if (!error) return done(null);
			if (!isUnsupported(error)) return done(error);
			noteDegraded();
			moveAsync(source, target).then(() => done(null), done);
		});
	};

	promises.rename = async function rename(source, target) {
		try {
			return await renameAsyncOriginal(source, target);
		} catch (error) {
			if (!isUnsupported(error)) throw error;
			noteDegraded();
			return moveAsync(source, target);
		}
	};
}

install();
