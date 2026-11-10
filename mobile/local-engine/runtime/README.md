# mobile/local-engine

手机本机引擎（Android）：APK 内自带 Linux rootfs + Node + pi-web-ui，前台服务托管，proot 免 root 运行。
设计文档与事实源：[`docs/mobile-local-engine.md`](../../../docs/mobile-local-engine.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `runtime/build-runtime.sh` | rootfs 构建脚本（Linux/CI，需 root + qemu-user-static） |
| `runtime/out/<abi>/` | 构建产物留档（gitignore） |
| `../native/local-engine/` | Capacitor 本地插件：TS 桥 + Java 原生层（安装器 / 前台服务 / 状态机） |

## 构建（CI 或 WSL/Linux）

```bash
cd mobile/local-engine/runtime
sudo RUNTIME_REVISION=r1 ./build-runtime.sh arm64 --sync-assets
```

- `--sync-assets` 把 `runtime.json + rootfs.tgz.part-*` 覆盖到
  `mobile/native/local-engine/android/src/main/assets/localengine/`（gitignore；未填充时 APK 无法安装运行环境并给出明确报错）。
- 分卷 100MiB；`runtime.json.volumes` 记录每卷 bytes/sha256，安装器流式校验后才提交解压。
- pin 输入：Ubuntu base / Node LTS / proot（termux 静态二进制）；镜像与 URL 均可用环境变量覆盖。
- x86_64 包用于模拟器冒烟：`sudo RUNTIME_REVISION=r1 ./build-runtime.sh x86_64 --sync-assets`。

## 阶段 A 冒烟（无 Android 真机时）

在同一台 Linux 机器上：

```bash
chroot out-rootfs env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root \
  PI_WEB_HOST=127.0.0.1 PI_WEB_PORT=0 PI_WEB_DATA_DIR=/tmp/pwu-data PI_WEB_CWD=/tmp/pwu-ws \
  node --import /usr/local/lib/node_modules/pi-web-ui/dist/server/resolve-global-sdk.js \
       /usr/local/lib/node_modules/pi-web-ui/dist/server/index.js
```

验收：`node-pty` 可加载、首页可访问、`PI_WEB_TOKEN` 生效。proot 形态的真机验证在阶段 B/C。

## 已知限制（MVP）

- 升级事务未实现：已安装后换版本需先「重置本机引擎」（`reset` 保留 `filesDir/data` 用户数据）。
- proot 主进程被杀后残留 node 的兜底：服务停止时 destroy → 3s 后 destroyForcibly；极端 ROM 下可能有孤儿进程，重启引擎前会重新分配端口，不影响可用性。
- iOS 桥未实现（本期不做）。
