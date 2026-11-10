/*
 * Android App 沙箱的 zygote seccomp 过滤器对 renameat2 直接返回 ENOSYS，而 glibc 2.28+ 的
 * rename() 只走 renameat2、不做回退 —— proot 里每个 glibc 程序的 rename 都会失败：
 * node 的原子写 / 插件物化、git 的 lockfile 提交、mv 之类。renameat 在允许名单里，
 * 所以这里把 rename 系列改道 renameat。
 *
 * 由 build-runtime.sh 编译成 /usr/local/lib/pi-mobile/librename-compat.so，并在 rootfs 的
 * /etc/ld.so.preload 里登记，让 guest 内所有动态链接程序自动加载（proot 自身是 bionic，
 * 不读这个文件，也不加载 glibc 的 .so）。node 侧另有一层 JS 兜底：
 * mobile/native/local-engine/android/src/main/assets/pi-localengine/rename-compat.cjs。
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>

static int rename_with_at(const char *old_path, const char *new_path) {
	return (int)syscall(SYS_renameat, AT_FDCWD, old_path, AT_FDCWD, new_path);
}

int rename(const char *old_path, const char *new_path) {
	return rename_with_at(old_path, new_path);
}

int renameat(int old_dirfd, const char *old_path, int new_dirfd, const char *new_path) {
	if (old_dirfd == AT_FDCWD && new_dirfd == AT_FDCWD) return rename_with_at(old_path, new_path);
	static int (*real_renameat)(int, const char *, int, const char *) = 0;
	if (!real_renameat) real_renameat = (int (*)(int, const char *, int, const char *))dlsym(RTLD_NEXT, "renameat");
	if (!real_renameat) {
		errno = ENOSYS;
		return -1;
	}
	return real_renameat(old_dirfd, old_path, new_dirfd, new_path);
}

int renameat2(int old_dirfd, const char *old_path, int new_dirfd, const char *new_path, unsigned int flags) {
	if (old_dirfd == AT_FDCWD && new_dirfd == AT_FDCWD && flags == 0) return rename_with_at(old_path, new_path);
	/* RENAME_NOREPLACE / RENAME_EXCHANGE 没有 renameat 等价物，保持和沙箱一样的失败语义 */
	errno = ENOSYS;
	return -1;
}
