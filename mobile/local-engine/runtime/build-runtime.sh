#!/usr/bin/env bash
# mobile/local-engine/runtime/build-runtime.sh
# 构建手机本机引擎运行环境：Ubuntu rootfs + Node + pi-web-ui，按 ABI 打分卷进插件 assets。
#
# 仅限 Linux（qemu-user-static + chroot，需 root；GitHub Actions ubuntu runner 直接可用）。
# 产物：
#   out/<abi>/runtime.json + rootfs.tgz.part-NNN      留档
#   ../../native/local-engine/android/src/main/assets/localengine/   （--sync-assets 时覆盖）
#
# 用法：
#   sudo RUNTIME_REVISION=r1 PI_WEB_UI_VERSION=0.119.0 ./build-runtime.sh arm64 [--sync-assets]
#
# 输入全部 pin + 校验 sha256；镜像可用环境变量覆盖（默认清华源）。
set -euo pipefail

ABI="${1:-}"
SYNC_ASSETS="${2:-}"

if [[ "$ABI" != "arm64" && "$ABI" != "x86_64" ]]; then
	echo "用法: $0 arm64|x86_64 [--sync-assets]" >&2
	exit 2
fi
if [[ "$(id -u)" != "0" ]]; then
	echo "需要 root（qemu chroot + mount）。CI runner 或 sudo 执行。" >&2
	exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ASSETS_DIR="$SCRIPT_DIR/../../native/local-engine/android/src/main/assets/localengine"
OUT_DIR="$SCRIPT_DIR/out/$ABI"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- pinned inputs（改版本必须同步换 sha256，或填 PI_*_SKIP_SHA=1 显式跳过并自担风险）----
RUNTIME_REVISION="${RUNTIME_REVISION:?请设置 RUNTIME_REVISION（如 r1），每次产物变更递增}"
NODE_VERSION="${NODE_VERSION:-22.21.1}"
UBUNTU_VERSION="${UBUNTU_VERSION:-24.04.5}"
UBUNTU_EXTRA_DEBS="${UBUNTU_EXTRA_DEBS:-tzdata ca-certificates git python3 make g++}"
PI_WEB_UI_VERSION="${PI_WEB_UI_VERSION:?请设置 pi-web-ui 版本号（如 0.119.0）}"
PI_WEB_UI_TGZ="${PI_WEB_UI_TGZ:-}"                    # 指向 npm pack 产物则离线安装
PI_SDK_VERSION="${PI_SDK_VERSION:-latest}"
PI_SDK_SKIP_SHA="${PI_SDK_SKIP_SHA:-0}"
MIRROR_UBUNTU_CD="${MIRROR_UBUNTU_CD:-https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage}"
MIRROR_UBUNTU_ARCHIVE="${MIRROR_UBUNTU_ARCHIVE:-https://mirrors.aliyun.com/ubuntu-ports}"
UBUNTU_BASE_URL_arm64="$MIRROR_UBUNTU_CD/ubuntu-base/releases/$UBUNTU_VERSION/release/ubuntu-base-$UBUNTU_VERSION-base-arm64.tar.gz"
UBUNTU_BASE_URL_x86_64="$MIRROR_UBUNTU_CD/ubuntu-base/releases/$UBUNTU_VERSION/release/ubuntu-base-$UBUNTU_VERSION-base-amd64.tar.gz"
UBUNTU_BASE_SHA256_arm64="${UBUNTU_BASE_SHA256_arm64:-}"
UBUNTU_BASE_SHA256_x86_64="${UBUNTU_BASE_SHA256_x86_64:-}"
PROOT_VERSION="${PROOT_VERSION:-5.1.107.102}"
PROOT_SHA256_arm64="${PROOT_SHA256_arm64:-}"
PROOT_SHA256_x86_64="${PROOT_SHA256_x86_64:-}"
PROOT_POOL_URL="${PROOT_POOL_URL:-https://packages.termux.dev/apt/termux-main/pool/main/p/proot}"
TERMUX_POOL_BASE="${TERMUX_POOL_BASE:-https://packages.termux.dev/apt/termux-main/pool/main}"
LIBTALLOC_VERSION="${LIBTALLOC_VERSION:-2.5.0}"
LIBTALLOC_SHA256="${LIBTALLOC_SHA256:-}"
LIBSHMEM_VERSION="${LIBSHMEM_VERSION:-0.7}"
LIBSHMEM_SHA256="${LIBSHMEM_SHA256:-}"
MIRROR_NODE="${MIRROR_NODE:-https://registry.npmmirror.com/-/binary/node}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

case "$ABI" in
arm64)
	DEB_ARCH="arm64"; TERMUX_ARCH="aarch64"; QEMU="qemu-aarch64-static"; QEMU_BIN="/usr/bin/qemu-aarch64-static"
	MIRROR_DEB="${MIRROR_DEB:-https://mirrors.aliyun.com/ubuntu-ports}"
	NODE_DIST_ARCH="arm64"; NODE_SHA_KEY="linux-arm64"
	UBUNTU_BASE_URL="$UBUNTU_BASE_URL_arm64"; PROOT_SHA256="$PROOT_SHA256_arm64"; ASSET_ABI="arm64-v8a"
	;;
x86_64)
	DEB_ARCH="amd64"; TERMUX_ARCH="x86_64"; QEMU="qemu-x86_64-static"; QEMU_BIN="/usr/bin/qemu-x86_64-static"
	MIRROR_DEB="${MIRROR_DEB:-https://mirrors.aliyun.com/ubuntu}"
	NODE_DIST_ARCH="x64"; NODE_SHA_KEY="linux-x64"
	UBUNTU_BASE_URL="$UBUNTU_BASE_URL_x86_64"; PROOT_SHA256="$PROOT_SHA256_x86_64"; ASSET_ABI="x86_64"
	;;
esac

VOLUME_BYTES=104857600   # 100MiB per APK asset slice
ROOT="$WORK/rootfs"

fetch() { # fetch <url> <dest> [sha256]
	local url="$1" dest="$2" want="${3:-}"
	if [[ -n "$want" ]]; then
		if ! curl -fsSL --retry 3 -o "$dest" "$url"; then echo "下载失败: $url" >&2; exit 1; fi
		local got
		got="$(sha256sum "$dest" | awk '{print $1}')"
		if [[ "$got" != "$want" ]]; then echo "sha256 不符: $url ($got != $want)" >&2; exit 1; fi
	else
		if ! curl -fsSL --retry 3 -o "$dest" "$url"; then echo "下载失败: $url" >&2; exit 1; fi
		echo "警告: $url 未提供 sha256 pin（$dest）" >&2
	fi
}

	if [[ "$(uname -m)" != "x86_64" && "$ABI" == "x86_64" ]] || [[ "$(uname -m)" != "aarch64" && "$ABI" == "arm64" ]]; then
		# 异架构才需要 qemu-user-static；同架构（如 x86_64 容器内构建 x86_64 包）直接 chroot。
		if [[ ! -f "$QEMU_BIN" ]]; then
			echo "缺少 $QEMU_BIN（apt install qemu-user-static binfmt-support）" >&2
			exit 1
		fi
		NEED_QEMU=1
	else
		NEED_QEMU=0
	fi

# 容器/瘦环境自举：镜像源切阿里云（archive.ubuntu.com 在 fake-ip 代理下不可达），CA 由宿主挂载
sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true
sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list 2>/dev/null || true
if [[ -f /host-ca/ca-bundle.crt ]]; then
	mkdir -p /etc/ssl/certs
	cp /host-ca/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt
	export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
fi
if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || ! command -v xz >/dev/null; then
	apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates python3 xz-utils >/dev/null
fi

echo "==> 1/7 Ubuntu base rootfs"
sha_var="UBUNTU_BASE_SHA256_$ABI"
if [[ -n "${UBUNTU_BASE_TAR:-}" && -f "$UBUNTU_BASE_TAR" ]]; then
	# 本地 rootfs tar（docker export ubuntu:24.04 --platform=linux/<arch>），构建容器免外网拉 base
	EngineLog="本地 rootfs tar: $UBUNTU_BASE_TAR"
	echo "$EngineLog"
	mkdir -p "$ROOT"
	tar -xf "$UBUNTU_BASE_TAR" -C "$ROOT"
else
	fetch "$UBUNTU_BASE_URL" "$WORK/ubuntu.tgz" "${!sha_var:-}"
	mkdir -p "$ROOT"
	tar -xzf "$WORK/ubuntu.tgz" -C "$ROOT"
fi

echo "==> 2/7 chroot 内 apt 安装工具链（$UBUNTU_EXTRA_DEBS）"
mounts=("/proc" "/sys" "/dev")
for m in "${mounts[@]}"; do mount --bind "$m" "$ROOT$m"; done
cleanup_mounts() { for m in "${mounts[@]}"; do umount -l "$ROOT$m" 2>/dev/null || true; done; }
trap 'cleanup_mounts; rm -rf "$WORK"' EXIT
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"   # 容器化 rootfs 的 resolv.conf 常为空，chroot 内 apt 需要宿主 DNS
[[ -f /etc/ssl/certs/ca-certificates.crt ]] && mkdir -p "$ROOT/etc/ssl/certs" && cp /etc/ssl/certs/ca-certificates.crt "$ROOT/etc/ssl/certs/ca-certificates.crt"
if [[ "$NEED_QEMU" == "1" ]]; then cp "$QEMU_BIN" "$ROOT/usr/bin/"; fi
cat > "$ROOT/etc/apt/sources.list.d/ports.list" <<EOF
deb $MIRROR_DEB noble main universe
deb $MIRROR_DEB noble-updates main universe
EOF
chroot "$ROOT" /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	bash -ec "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y dist-upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $UBUNTU_EXTRA_DEBS && rm -rf /var/lib/apt/lists/*"
if [[ "$NEED_QEMU" == "1" ]]; then rm -f "$ROOT/usr/bin/$QEMU"; fi

echo "==> 3/7 Node v$NODE_VERSION"
NODE_FILE="node-v$NODE_VERSION-linux-$NODE_DIST_ARCH.tar.xz"
fetch "$MIRROR_NODE/v$NODE_VERSION/$NODE_FILE" "$WORK/$NODE_FILE"
NODE_SHASUMS_URL="https://registry.npmmirror.com/-/binary/node/v$NODE_VERSION/SHASUMS256.txt"
NODE_WANT="$(curl -fsSL "$NODE_SHASUMS_URL" | awk -v f="$NODE_FILE" '$2 == f {print $1}')"
if [[ -z "$NODE_WANT" ]]; then echo "无法获取 Node SHASUMS256（$NODE_SHA_KEY）" >&2; exit 1; fi
NODE_GOT="$(sha256sum "$WORK/$NODE_FILE" | awk '{print $1}')"
[[ "$NODE_GOT" == "$NODE_WANT" ]] || { echo "Node sha256 不符（$NODE_GOT != $NODE_WANT）" >&2; exit 1; }
tar -xJf "$WORK/$NODE_FILE" -C "$ROOT/usr/local" --strip-components=1

echo "==> 4/7 安装 pi-web-ui@$PI_WEB_UI_VERSION 与 pi SDK@$PI_SDK_VERSION"
if [[ -n "$PI_WEB_UI_TGZ" ]]; then cp "$PI_WEB_UI_TGZ" "$WORK/pi-web-ui.tgz"; PI_WEB_UI_SPEC="/pi-web-ui.tgz"; else PI_WEB_UI_SPEC="pi-web-ui@$PI_WEB_UI_VERSION"; fi
cat > "$ROOT/install-packages.sh" <<EOF
#!/bin/bash
set -euo pipefail
export npm_config_registry="$NPM_REGISTRY"
export npm_config_nodedir="/usr/local"   # node-gyp 用本地 headers，不走网络下载
npm install -g "$PI_WEB_UI_SPEC"
npm install -g "@earendil-works/pi-coding-agent@$PI_SDK_VERSION"
node -e "require('/usr/local/lib/node_modules/pi-web-ui/node_modules/node-pty')" || { echo "node-pty native 绑定不可用" >&2; exit 1; }
node --version
EOF
if [[ "$NEED_QEMU" == "1" ]]; then cp "$QEMU_BIN" "$ROOT/usr/bin/"; fi
chroot "$ROOT" /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	bash /install-packages.sh
if [[ "$NEED_QEMU" == "1" ]]; then rm -f "$ROOT/usr/bin/$QEMU"; fi
rm -f "$ROOT/install-packages.sh"
[[ -f "$ROOT/usr/local/lib/node_modules/pi-web-ui/dist/server/index.js" ]] || { echo "pi-web-ui dist/server 缺失" >&2; exit 1; }
[[ -f "$ROOT/usr/local/lib/node_modules/pi-web-ui/dist/server/resolve-global-sdk.js" ]] || { echo "SDK hook 缺失" >&2; exit 1; }
[[ -d "$ROOT/usr/local/lib/node_modules/@earendil-works/pi-coding-agent" ]] || { echo "pi SDK 缺失" >&2; exit 1; }
# rename 的 ENOSYS 降级不在 rootfs 里做：它由 APK 侧的 preload（assets/pi-localengine/rename-compat.cjs）统一接管，
# 见 docs/mobile-local-engine.md「App 沙箱与 rename」。

echo "==> 5/7 proot ($PROOT_VERSION)"
fetch "$PROOT_POOL_URL/proot_${PROOT_VERSION}_${TERMUX_ARCH}.deb" "$WORK/proot.deb" "$PROOT_SHA256"
dpkg-deb -x "$WORK/proot.deb" "$WORK/proot-pkg"
PROOT_BIN="$(find "$WORK/proot-pkg" -type f -name proot | head -1)"
[[ -n "$PROOT_BIN" ]] || { echo "deb 内没有 proot 二进制" >&2; exit 1; }
cp "$PROOT_BIN" "$ROOT/usr/local/bin/proot"
# proot 的 termux 依赖闭包（NEEDED: libtalloc.so.2 / libandroid-shmem.so），Service 以 LD_LIBRARY_PATH 提供
fetch "$TERMUX_POOL_BASE/libt/libtalloc/libtalloc_${LIBTALLOC_VERSION}_${TERMUX_ARCH}.deb" "$WORK/libtalloc.deb" "$LIBTALLOC_SHA256"
dpkg-deb -x "$WORK/libtalloc.deb" "$WORK/libtalloc-pkg"
find "$WORK/libtalloc-pkg" -name 'libtalloc.so*' -exec cp -a {} "$ROOT/usr/local/lib/" \;
fetch "$TERMUX_POOL_BASE/liba/libandroid-shmem/libandroid-shmem_${LIBSHMEM_VERSION}_${TERMUX_ARCH}.deb" "$WORK/shmem.deb" "$LIBSHMEM_SHA256"
dpkg-deb -x "$WORK/shmem.deb" "$WORK/shmem-pkg"
find "$WORK/shmem-pkg" -name 'libandroid-shmem.so*' -exec cp -a {} "$ROOT/usr/local/lib/" \;
# loader（execve 时重映射 ELF interpreter，Service 传 PROOT_LOADER 指向它）
mkdir -p "$ROOT/usr/local/libexec"
cp -a "$WORK/proot-pkg/data/data/com.termux/files/usr/libexec/proot" "$ROOT/usr/local/libexec/"
chmod 755 "$ROOT/usr/local/bin/proot"

echo "==> 6/7 清理 + 打包分卷"
cleanup_mounts   # 先卸载 /proc /sys /dev，避免虚拟文件系统被打进 rootfs
cleanup_mounts() { for m in "${mounts[@]}"; do umount -l "$ROOT$m" 2>/dev/null || true; done; }
trap 'cleanup_mounts; rm -rf "$WORK"' EXIT
cleanup_mounts
rm -rf "$ROOT/root/.npm" "$ROOT/var/cache/apt" "$ROOT/tmp"/*
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/rootfs.tgz.part-* "$OUT_DIR/runtime.json"
BASE_ID="$(printf '%s|%s|%s|%s' "$ABI" "$UBUNTU_VERSION" "$NODE_VERSION" "$UBUNTU_EXTRA_DEBS" | sha256sum | awk '{print $1}')"
pushd "$WORK" >/dev/null
VOLUMES_JSON=""
INDEX=0
BYTES_TOTAL=0
tar -czf - -C "$ROOT" --exclude=./proc --exclude=./sys --exclude=./dev . | split -d -b "$VOLUME_BYTES" - "$OUT_DIR/rootfs.tgz.part-"
for part in "$OUT_DIR"/rootfs.tgz.part-*; do
	SUM="$(sha256sum "$part" | awk '{print $1}')"
	SIZE="$(stat -c%s "$part")"
	BYTES_TOTAL=$((BYTES_TOTAL + SIZE))
	NAME="$(basename "$part")"
	VOLUMES_JSON+="${VOLUMES_JSON:+,}{\"name\":\"$NAME\",\"bytes\":$SIZE,\"sha256\":\"$SUM\"}"
done
popd >/dev/null

cat > "$OUT_DIR/runtime.json" <<EOF
{
  "version": "$RUNTIME_REVISION",
  "abi": "$ASSET_ABI",
  "node": "$NODE_VERSION",
  "piWebUi": "$PI_WEB_UI_VERSION",
  "baseId": "$BASE_ID",
  "bytesTotal": $BYTES_TOTAL,
  "volumes": [$VOLUMES_JSON]
}
EOF
python3 -c "import json,sys; json.load(open(sys.argv[1])); print('runtime.json OK')" "$OUT_DIR/runtime.json"

echo "==> 7/7 同步到插件 assets"
if [[ "$SYNC_ASSETS" == "--sync-assets" ]]; then
	mkdir -p "$ASSETS_DIR"
	rm -f "$ASSETS_DIR"/rootfs.tgz.part-* "$ASSETS_DIR/runtime.json"
	cp "$OUT_DIR"/rootfs.tgz.part-* "$ASSETS_DIR/"
	cp "$OUT_DIR/runtime.json" "$ASSETS_DIR/runtime.json"
	echo "已同步到 $ASSETS_DIR"
fi

VOLUME_COUNT=$(ls "$OUT_DIR"/rootfs.tgz.part-* | wc -l)
echo "完成：$OUT_DIR（volumes=$VOLUME_COUNT, revision=$RUNTIME_REVISION, abi=$ASSET_ABI）"
echo "真机侧：npx cap sync android 后，assets 将随 APK 打包。"
