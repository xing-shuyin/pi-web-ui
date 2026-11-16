[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# mobile/local-engine

手機本機引擎（Android）：APK 內自帶 Linux rootfs + Node + pi-web-ui，前臺服務託管，proot 免 root 執行。
設計文件與事實源：[`docs/mobile-local-engine.md`](../../../docs/mobile-local-engine.zh-TW.md)。

## 目錄

| 路徑                       | 內容                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `runtime/build-runtime.sh` | rootfs 構建指令碼（Linux/CI，需 root + qemu-user-static）             |
| `runtime/out/<abi>/`       | 構建產物留檔（gitignore）                                             |
| `../native/local-engine/`  | Capacitor 本地外掛：TS 橋 + Java 原生層（安裝器 / 前臺服務 / 狀態機） |

## 構建（CI 或 WSL/Linux）

```bash
cd mobile/local-engine/runtime
sudo RUNTIME_REVISION=r1 ./build-runtime.sh arm64 --sync-assets
```

- `--sync-assets` 把 `runtime.json + rootfs.tgz.part-*` 覆蓋到
  `mobile/native/local-engine/android/src/main/assets/localengine/`（gitignore；未填充時 APK 無法安裝執行環境並給出明確報錯）。
- 分卷 100MiB；`runtime.json.volumes` 記錄每卷 bytes/sha256，安裝器流式校驗後才提交解壓。
- pin 輸入：Ubuntu base / Node LTS / proot（termux 靜態二進位制）；映象與 URL 均可用環境變數覆蓋。
- x86_64 包用於模擬器冒煙：`sudo RUNTIME_REVISION=r1 ./build-runtime.sh x86_64 --sync-assets`。

## 階段 A 冒煙（無 Android 真機時）

在同一臺 Linux 機器上：

```bash
chroot out-rootfs env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root \
  PI_WEB_HOST=127.0.0.1 PI_WEB_PORT=0 PI_WEB_DATA_DIR=/tmp/pwu-data PI_WEB_CWD=/tmp/pwu-ws \
  node --import /usr/local/lib/node_modules/pi-web-ui/dist/server/resolve-global-sdk.js \
       /usr/local/lib/node_modules/pi-web-ui/dist/server/index.js
```

驗收：`node-pty` 可載入、首頁可訪問、`PI_WEB_TOKEN` 生效。proot 形態的真機驗證在階段 B/C。

## 已知限制（MVP）

- 升級事務未實現：已安裝後換版本需先「重置本機引擎」（`reset` 保留 `filesDir/data` 使用者資料）。
- proot 主程序被殺後殘留 node 的兜底：服務停止時 destroy → 3s 後 destroyForcibly；極端 ROM 下可能有孤兒程序，重啟引擎前會重新分配埠，不影響可用性。
- iOS 橋未實現（本期不做）。
