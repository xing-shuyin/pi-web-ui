# 发布流程

> npm 发布者账号是 `xingshuyin`（`npm whoami` 验证）。`dist/server/`、`web/dist/` 被 gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；`dist/` 根目录的本地测试文件与桌面产物不进入 npm 包。`build:release`（也就是 `prepublishOnly`）会编译 P2P 助手、检查 Windows 桌面编码组件及其源码和重链接材料，再执行 `npm run build`；服务端构建先清理 `dist/server/`，避免已删除源码的旧输出留在发布包。发布前必须先准备下文所述的 Windows 构建产物。真正发出去的包由 `scripts/pack-npm.mjs` 打出（`npm pack` → 归一化 bin 可执行位 → 复查），不要裸 `npm publish`。

## 步骤

```bash
# 1) 升版本（patch/minor 视改动；npm 上已存在该版本会 404 拒绝）
#    两处都要改，保持一致：
#      package.json 的 "version" 和 package-lock.json 的 "version"（第 3 行 + packages[""]）

# 2) 写 CHANGELOG（每次发布固定一步，不可跳过）
#    在 CHANGELOG.md 顶部加新版本小节：Added / Fixed / Changed / i18n 四类，
#    按「实际合入该版本发布的提交」归档（git log 上个版本 bump 提交..HEAD），
#    日期写 npm 发布时间（UTC+8 日历日）；底部的版本链接定义同步加一条。
#    Unreleased 小节有内容就并入新版本、清空；无内容就只建空小节占位。
#    i18n 小节不用手写：改完文案后跑一次，自动记入 ## [Unreleased]（幂等，可反复跑）：
#    npm run changelog:i18n

# 3) 自检 + 构建
npm run typecheck
npm run build

# 4) 提交（Conventional Commits：feat/fix/perf/chore(scope): 描述，说明 why）
git add -A
git commit -m "feat(files): <一句话描述>"

# 5) 推送 GitHub（仓库公开：xing-shuyin/pi-web-ui，分支 main）
git push origin main

# 5.5) CI 绿标守护：按本次提交 SHA 找到 main 的 CI，等待全部成功。
#      失败则 gh run view <run-id> --log-failed，定位根因、本地复验、提交推送，
#      重新等待新 SHA 的 CI；旧提交的绿标不能替代本次提交。
#      全绿后展示版本和最终 Release Notes，取得用户发布确认，才可继续 tag / npm。
gh run list --branch main --workflow CI --commit "$(git rev-parse HEAD)"
gh run watch <run-id> --exit-status

# 6) 打 tag 并推送（tag 带 v 前缀，数字与 npm 版本一一对应；issue #103 前缺的 tag 已回补）
#    漏打 tag 会导致 GitHub 看到的"最新版"落后于 npm，务必每次都打。
git tag vX.Y.Z
git push origin vX.Y.Z

# 7) GitHub Release（自动公示，无需手写）
#    tag 一推送，Action（.github/workflows/release-notes.yml）自动跑：
#    安装锁定的解析依赖（不运行安装脚本），取 CHANGELOG 小节 + 按上个 tag 生成 ### i18n，
#    创建 Release（已存在则更新 notes）。本地可先预览：
node scripts/release-notes.mjs X.Y.Z --base v<上个版本>   # 预览（输出到 stdout）
#    自动任务失败并修复工作流后，从 main 的工作流重新处理已发布 tag；会校验并检出该 tag，
#    再安装该 tag 的锁定依赖、生成及更新说明：
# gh workflow run release-notes.yml --ref main -f tag=vX.Y.Z
#    若工作流仍不可用，可在本地依赖齐备后手动补发：
# node scripts/release-notes.mjs X.Y.Z --base v<上个版本> --out /tmp/notes.md --create

# 8) 发布 npm（封装里自带：构建 → 打包归一化 → 带 OTP 发布 → staged 自愈）
#    账号开了 2FA：用「绕过 2FA 的 granular token」直接 npm publish 会被 registry 降级成
#    staged 发布（版本几分钟后才落库，期间重试只会 409 Cannot publish over previously
#    staged version；unpublish / 改 dist-tag 更是直接 403）。走带 OTP 的封装：
NPM_OTP=123456 npm run release:npm     # 预检脏工作区/账号/tag + 构建 + 打包 + 带 OTP 发布 + staged 自愈
#    只想看会打出什么（构建 + 打包 + 复查，不上传）：npm run release:npm -- --dry-run
#    发布重试（复用现有 dist/，不再重复构建）：npm run release:npm -- --skip-build
#    把待发布 tarball 留在指定目录（可直接喂给 hub 升级验收的 --candidate）：
#      npm run release:npm -- --out=release/npm
#    复查已经发出的包：node scripts/pack-npm.mjs --verify-only pi-web-ui-X.Y.Z.tgz
#    ⚠ 不要裸 npm publish：它会把工作区目录重新打一遍包，Windows 打包机上 bin 脚本的可执行位
#      又回到 0644，全局安装后 pwu / pi-web-ui 会 `Permission denied`（issue #922）。

# 8.5) 桌面安装包（自动，三平台并行，无需手写）
#    同一个 tag 也触发 .github/workflows/desktop-release.yml，三个 job 同时跑
#    （都是 npm run build + build:desktop + electron-builder）：
#      windows-latest  --win            → *.exe (+ .blockmap) + latest.yml
#      macos-latest    --mac            → *.dmg + *.zip + latest-mac.yml
#      ubuntu-latest   --linux AppImage → *.AppImage + latest-linux.yml
#    三者都把产物附到该 tag 的 Release（--clobber，重推 tag 即整批重跑+覆盖资产；
#    workflow_dispatch 只出 workflow artifact、不动 Release 资产）。
#    注意两点：
#      - runner 默认出宿主架构：Windows/Linux 是 x64，macos-latest 是 arm64
#        （Intel Mac 需另加 --mac --x64，一行事，当前没做）；
#      - 三平台都未签名（Windows 首启 SmartScreen 提示、macOS 首次需右键→打开，
#        macOS 证书也不在 SignPath 范围内）；首启/终端没把握就先在真机上跑一遍
#        dmg/AppImage 再广而告之。
#    签名（SignPath Foundation）以后加在这个 workflow 里——SignPath 只签 CI 产物，
#    本地 npm run desktop:dist 永远签不上（本地打包只能验证 Windows）。

# 8.6) 手机端 APK：tag 推送后自动出（本地命令仅作兜底）
#    mobile-release.yml 现在也跟 tag 走（v*）：构建 arm64 引擎运行时 → 打 APK → 自动挂到该 tag 的 Release，
#    并且必须先对 tag 与 package.json 版本一致，否则直接拒绝出包。
#    之所以能自动：签名密钥已固定入库（secrets MOBILE_KEYSTORE_BASE64 / _PASSWORD / KEY_ALIAS / KEY_PASSWORD），
#    每次产物同一张证书，能覆盖升级；此前不自动是因为 CI 每次新生成 debug keystore（新包装不上旧包，还会清引擎数据）。
#    本地兜底（云端挂了、或要出一个不走 CI 的包时，仍是同一条命令一套产物）：
npm run release:local -- vX.Y.Z                # 全量：桌面 + 手机（手机那步 qemu 构建 15–25 分钟）
npm run release:local -- vX.Y.Z --skip-mobile  # 只打桌面
npm run release:local -- vX.Y.Z --skip-desktop # 只打手机
npm run release:local -- vX.Y.Z --skip-desktop --reuse-runtime  # 只打手机且不重建运行时（引擎没变时首选，几分钟）
npm run release:local -- vX.Y.Z --no-upload    # 只打包，不碰 Release
npm run release:local -- vX.Y.Z --portable     # 额外出便携版（内置 Git/Node，较慢）
#    注意：上面的本地命令现在只在兜底时用；正常发版不需要跑——tag 一推，Release 说明 / 桌面三平台 /
#    浏览器扩展 / 手机 APK 会并行自动出。唯一必须本地手动跑的仍是第 8 步的 npm 发布（2FA/OTP）。
#    --reuse-runtime 只在「服务端代码没变、只动了外壳/插件」时成立：运行时里装的就是本仓库
#    npm pack 的服务端包，piWebUi 版本对不上时脚本会直接拦下（确认真没改可加 --allow-stale-engine）。
#    脚本会先校验 tag 与 package.json 版本一致，然后：npm run build → 桌面打包 → （可选）构建
#    arm64 运行时并打 APK → 生成 SHA256SUMS.txt → gh release upload --clobber。
#    签名是升级信任根：同一把密钥签出来的 APK 才能覆盖安装；换钥=用户必须卸载（引擎数据一起清）。
#    密钥本体请离线备份（生成脚本见下），丢了就再也发不出可升级的包。
#    两个已知限制：
#      - Windows 的 NSIS 安装包本地生不出来（electron-builder 打完要执行刚产出的 setup.exe
#        生成卸载器，本机被系统拦下：ERR_ELECTRON_BUILDER_CANNOT_EXECUTE / exit code null），
#        所以本地出的是免安装 zip（release/pi-web-ui-desktop-<版本>-win-x64-portable.zip）；
#        需要正式安装包时用 CI 的 desktop-release windows job。
#        本机确实需要安装包时走 MSI：`npm run desktop:msi` → release/pi-web-ui-desktop-<版本>-win-x64.msi
#        （WiX 4 直接把 win-unpacked 压成 MSI，不执行产物，所以不受上面那条限制；未签名，首启有 SmartScreen 提示）。
#        MSI 是可选目标，不在 electron-builder.yml 的 win.target 里——CI 的 `--win` 只出 exe，避免白打一个不收的包。
#      - macOS / Linux 安装包只能在对应系统上打，仍由 .github/workflows/desktop-release.yml 出。
#    .github/workflows/mobile-release.yml 同时保留 workflow_dispatch：云端兜底时在 Actions 里手点
#    （或 `gh workflow run mobile-release.yml --ref vX.Y.Z`，ref 是 tag 时才会自动挂到 Release）。
#    它依赖 MOBILE_KEYSTORE_BASE64 等 secrets；没有这些 secrets 时退回 debug 签名（装不上旧包）。

# 9) 验证
npm run release:check -- vX.Y.Z  # npm 版本是否已发 + Release 资产是否齐全（桌面 3 平台 + 扩展 + 手机 APK + SHA256SUMS）
npm run release:check:npm       # 只核 npm：registry 上有没有 package.json 当前版本、latest 是否指着它
npm view pi-web-ui version        # 应显示新版本（registry 有缓存延迟属正常）
curl -s https://registry.npmjs.org/pi-web-ui/latest | jq .version
git ls-remote --tags origin       # 应能看到 vX.Y.Z
```

## 注意事项

- 版本号**必须**高于 npm registry 上已有的（用 `npm view pi-web-ui version` 查当前值）。
- **手机签名密钥是升级信任根，必须离线备份**：APK 能覆盖升级的前提是「同一张证书」，所以 `MOBILE_KEYSTORE_BASE64` / `MOBILE_KEYSTORE_PASSWORD` / `MOBILE_KEY_ALIAS` / `MOBILE_KEY_PASSWORD` 这四条 secrets 一旦丢失或更换，用户就得卸载重装（本地引擎数据一起清）。备份的是**密钥文件本体 + 口令**，不是 secrets 本身（secrets 只能覆盖写、读不出来）。
  换钥 / 首次生成（PKCS12，JDK 21 与 apksigner 都认；本机没有 keytool 时 openssl 就够）：

  ```bash
  PASS=$(openssl rand -hex 16)
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 10950 -nodes -subj '/CN=pi-web-ui Mobile/O=<你的组织>'
  openssl pkcs12 -export -inkey key.pem -in cert.pem -name pi-mobile -out pi-mobile.p12 -passout pass:"$PASS"
  base64 -w0 pi-mobile.p12 > pi-mobile.p12.b64
  gh secret set MOBILE_KEYSTORE_BASE64 < pi-mobile.p12.b64
  gh secret set MOBILE_KEYSTORE_PASSWORD --body "$PASS"
  gh secret set MOBILE_KEY_ALIAS --body pi-mobile
  gh secret set MOBILE_KEY_PASSWORD --body "$PASS"
  ```

  密钥与口令请存进密码管理器/离线介质；仓库、Release 资产、issue 里都不许出现（守卫只看 CI，不会替你防泄露）。
  **密钥住哪**：本机固定放 `/.signing/`（已被 `.gitignore` 忽略、根级白名单登记，见该目录里的 `README.md`）。
  它**不是**可提交的内容——公开仓库一旦收了私钥，任何人都能签出同身份的 APK，且 git 历史删不掉；所以即便「只想存本地」也必须是忽略状态，别 `git add -f`。
  同一块盘挡不住重装系统 / 磁盘损坏，务必再存一份到仓库之外。

  当前在用密钥（新钥生成后请同步更新这里）：

  ```text
  subject  CN=pi-web-ui Mobile, O=xing-shuyin
  sha256   F3:3A:96:A9:60:1A:55:16:CA:49:4E:38:E8:8A:DA:13:B2:28:A4:E5:67:84:54:A7:55:C8:97:96:AF:C2:9B:8A
  valid    2026-11-23 → 2056-11-15
  ```

  自检两条：`openssl pkcs12 -in pi-mobile.p12 -nokeys -passin pass:<口令> | openssl x509 -noout -fingerprint -sha256`（对得上上面的指纹），
  以及 `apksigner verify --print-certs <刚发的 apk>`（发出的包确实是这把钥签的）。

- **发完 npm 必须看得见（issue #949）**：第 8 步是整条流程里唯一必须本地带 OTP 手动跑的步骤（tag 推送会自动出 Release / 桌面包 / 扩展 / 手机 APK，全部有 `release:check` 盯着） —— 唯独 npm 落后时全绿，用户 `npm i -g` 拿到几周前的旧包（#949 报的就是这个：registry 停在 0.120.0，仓库已经 0.121.3）。所以：
  - `npm run release:check` 现在**先核 npm**（`scripts/check-npm-version.mjs`，纯读 registry，不需要登录态），缺版本 / `latest` 指向旧版 / registry 比本地新都直接 exit 1；只差 npm 时先跑 `npm run release:check:npm` 就能确认。
  - `.github/workflows/npm-drift.yml` 每天 03:17 UTC 跑一次同样的校验，漂移就红（红叉 + GitHub 通知），不需要任何人想起来手查。
  - 漏发了补就是 `NPM_OTP=<验证码> npm run release:npm`（脚本自带「registry 已有该版本就跳过」的幂等预检），补完再跑一次 `release:check`。
- 版本号格式：npm 不带 `v` 前缀（`0.70.0`），git tag / GitHub Release 带 `v` 前缀（`v0.70.0`）。
- 提交信息不要带 `Co-authored-by`（P1 规则，仓库 hook 会拦）。
- `.pi/commands.json` 是**每个项目各自**的个人命令（当前 cwd 的 `.pi/ 下），已被 gitignore，永远不会进公开仓库；切换 cwd 时命令列表自动刷新为该项目的命令。
- CI 绿标守护模式下，必须先完成最终提交的 CI 验证，再展示版本与 Release Notes 请求发布确认；同一次确认涵盖该版本的 tag 推送及 `npm publish`。
- **npm 包里 bin 入口的可执行位写在 tarball 头里**：npm 的 bin 链接只在「新建符号链接」时补 x 位（`bin-links` 的 `fixBin`），链接已存在而目标文件被重新解压时会跳过，用户拿到 0644 就 `Permission denied`；而 Windows 打包机上 fs 根本没有 x 位，`npm pack` 只能写 0644。所以 `npm run release:npm` / `npm run pack:npm` 在 `npm pack` 之后按条目改写 tarball 头的 mode（`bin/` 下有 shebang 的脚本、linux/darwin 原生助手 → 0755，PE 与许可证之类保持 0644），再复查「声明的 bin 存在 + 有 shebang + 0755」才发布（单源：`scripts/lib/npm-tarball.mjs`，守卫 `npm-tarball-modes.test.ts`）。`bin/` 下没有 shebang 的 `.mjs`（`hub-upgrade.mjs`、`device-hub-cli.mjs`、`frp-manager.mjs`）是被 `node` 拉起的内部入口，不进 `bin` 字段、也不需要 x 位。
- **`files` 必须覆盖服务端运行时要读的目录**：`dist/server/index.js` 的第一条 import 就是 `../shared/hide-console-windows.js`，而 `files` 曾只写 `dist/server/` —— 本地/CI 全绿（源码树上 `shared/` 就在旁边），发出去的 tarball 一启动就 `ERR_MODULE_NOT_FOUND`，`npm i -g pi-web-ui` 的人全变成「Agent 暂时不可用 / server 提前退出（code=1）」（2026-11-21 实机）。现在 `files` 含 `dist/shared/`，并由 `tests/unit/npm-package-files.test.ts` 扫 `server/**` 的跨目录 import 反向核（桌面安装包同一条约束见 `desktop/electron-builder.yml` 的 `dist/shared`）。
- **升级后的重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、某功能一直加载中」。界面内「立即更新」（顶栏更新下拉）现在是在可见终端 tab 中跑 `npm i -g pi-web-ui@latest`（复用 SCM/插件卸载同款 tab 模式），完成后需手动重启服务生效：`pi-web-ui server restart`（launchd/systemd 由服务管理器拉起；Docker 需 `docker compose restart`）。服务端保留 `PI_WEB_RESTART_CHILD` 端口等待握手（restart-handoff-test 回归），供外部编排的替换子进程使用。
- **改桌面出包 workflow 先空跑再重推 tag**：`gh workflow run desktop-release.yml --ref main` 先验证三个平台 job 全绿，再重推 tag——重推 tag 会重建并 `--clobber` 覆盖 Release 资产，是正式出包的唯一路径。
- **发布前检查示例文件不泄密**：`deploy/`、`README` 等随 npm 包（`files` 白名单含 `deploy/`）和 GitHub 分发的文件**绝不放真实 IP / 域名 / 密钥**——用占位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真实环境配置只在本地改，不进仓库。

## 桌面运行时签名（壳 + 运行时双层模型）

运行时归档的信任根是**壳里内置的 ed25519 公钥**（`desktop/runtime-config.ts` 的 `RUNTIME_PUBLIC_KEY_PEM`，当前指纹
`c144c102c473edbfcbfecafdc1662151`）。配套私钥只存 GitHub Actions secret `DESKTOP_RUNTIME_SIGNING_KEY`（PEM 原文，
或换行写成 `
` 的单行都可以），**绝不进仓库**。

```bash
# 生成新密钥对（只在需要轮换时做）
npm run build:desktop-runtime -- --keygen
#   私钥 → GitHub secret DESKTOP_RUNTIME_SIGNING_KEY
#   公钥 → desktop/runtime-config.ts（要发一次壳才生效）

# 出运行时产物（core 归档 + 清单 + 签名）；CI 的三个 job 在出完安装包后自动跑这一步
npm run build:desktop-runtime -- --platform <p> --arch <a> --out release/runtime --from <已组装好的 app 目录>
# 干跑验收（CI 必跑；没有公钥时 verify 会拒绝）
npm run verify:desktop-runtime   --manifest release/runtime/runtime-<p>-<a>.json   --signature release/runtime/runtime-<p>-<a>.sig   --public-key release/runtime/runtime-<p>-<a>.pub.pem   --archive release/runtime/core-*-<p>-<a>.tar.zst
```

- 公钥留空 = **一律拒绝任何运行时更新**（fail closed）；改公钥属于改信任根，必须跟文档与发版一起走。
- `natives`（ffmpeg / codec / p2p）载荷暂未纳入下载通道，运行时清单目前只带 `core`。
- 本地实机验证可用 `PI_DESKTOP_UPDATE_FEED=<静态目录 URL>` 配 `PI_DESKTOP_RUNTIME_AUTOCHECK=1`、`PI_DESKTOP_RUNTIME_AUTOAPPLY=1`。

## 代码及文档不要泄露任何公网IP

## P2P npm 候选包

完整候选包通过 `npm run pack:p2p` 生成，需要 Node.js 与 Go ≥1.24。发布者先在 Windows x64 构建机运行 `npm run build:desktop-codec`；如果在 macOS/Linux 打包，须先将该构建机的 `bin/desktop-codec/win32-x64/` 和 `bin/ffmpeg/win32-x64/nvenc-compat/` 一同复制到发布工作区。命令会交叉编译五个平台助手、准备默认 Windows FFmpeg、校验原生组件和材料、构建 Web/服务端，最后走 `scripts/pack-npm.mjs` 打包（与正式发布同一个打包器，所以 Windows 上打出的候选包也带着 linux/darwin 助手的 0755）。发布前也可单独运行 `npm run verify:desktop-codec`。缺少或篡改必需产物时，`pack:p2p` 和 npm 发布前检查会失败；不要用 `npm pack --ignore-scripts` 绕过检查发布。

`bin/device-p2p/` 助手以及 Windows 编码器和重链接材料是生成物，不提交 Git，由 npm 的 `bin/` 文件白名单收录。Windows 桌面安装包的 release workflow 会从源码构建这些组件。源码、许可证与重链接材料随包提供，正式发布前由维护者检查第三方依赖的适用许可要求。

发布前执行 `node --import tsx tests/device-p2p-test.mjs` 和相关设备权限/访问单测；从打出的 tarball 安装并检查五份助手及清单，验证包内而非工作区的连接助手。Go 交叉编译通过不等于 macOS/Linux 实机通过，发布说明必须区分。

## Hub 发布包升级验收

发布前测试应安装 npm 将要交付的 `.tgz`，从已发布的 Hub 升级到该包，并使用真实的系统服务和浏览器。只在源码目录启动服务或单测中模拟 `/health`，不能证明打包内容、安装路径、npm 依赖和服务重启正确。

### 本地运行

```bash
node scripts/prepare-hub-release.mjs
node tests/hub-upgrade-release-test.mjs --candidate /absolute/path/pi-web-ui-VERSION.tgz --baseline pi-web-ui@0.117.0 --output /absolute/path/results
```

第一条命令将当前源码复制到独立临时目录，完整执行发布构建，再执行 `npm pack --ignore-scripts`，不覆盖正在使用的工作区 `dist/`。构建使用当前工作区已安装的依赖；CI 使用干净 `npm ci` 构建同一个候选包。可通过 `PI_HUB_TEST_TMP` 指定临时目录（Windows 开发环境建议 `E:/tmp`）。

第二条命令会安装候选包与指定 npm 公开版本，用真实服务管理器运行旧版本，再升级到候选包。它使用唯一的 `pi-device-hub-smoke-<随机值>` 名称、独立服务配置和数据目录，结束后卸载测试服务，不改动默认 Hub。首轮基线启动使用候选 CLI 生成隔离名称的服务定义，服务入口和运行代码来自实际公开包；格式与旧版本安装的定义相同。需要 npm registry 网络、可用的用户服务会话、服务管理权限和 Chromium/Chrome。已有 Chrome 会自动检测；否则运行 `npx playwright-core install chromium --with-deps`。

可以传 `--background` 后台运行并查看输出目录的 `acceptance.log`、`commands.log` 和 `result.json`。脚本返回结果或 `result.json` 的终态为 `passed` 才算通过。失败时保留安装目录和诊断信息；清理服务失败也会使验收失败。

### 实际验证的行为

1. 安装准确的候选 tarball 和公开版本依赖，检查真实包内容及独立 Hub 启动。
2. 通过真实 OS 服务启动公开版本，创建账号、配对设备、同步 Bot 并创建群组。
3. 用候选 CLI 将旧服务升级到候选包，检查实例 ID、登录 Cookie、设备和群组仍存在。兼容旧版不含版本/启动标识的健康接口。
4. 用真实 Chromium 点击网页「一键升级」，绑定本次 POST 返回的新任务 ID，经过真实 npm 安装、独立更新任务、服务停止和重启；只接受本次任务与界面的预期终态、目标版本及新启动标识。意外失败会立即报告，旧任务结果不能代替本次结果。
5. 使用不存在的包模拟安装失败，断言页面显示失败、旧 Hub 的启动标识没有变化。
6. 创建可正常导入但启动函数会抛错的候选包，让真实服务实际尝试启动该包；确认自动恢复旧服务，界面报告失败且群组数据保留。预期失败即使返回 HTTP 503，也须确认磁盘记录的是本次新建的失败任务，不能把网络错误或旧任务当作通过。
7. 卸载隔离测试服务并清理受管安装目录。

输出包含报告 JSON/Markdown、候选包 SHA-256、基线和候选版本、Node 与操作系统，以及浏览器成功/失败/回滚截图。失败时还会在卸载服务前收集本次任务的允许字段、限量脱敏日志和服务管理器状态；macOS 分别检查 gui/user 域，Windows 保存任务状态、启动事件，以及失败端口的 TCP 状态和所属 PID；不记录远端地址或其他进程命令。升级和回滚在停止任务后都要完成有界的 TCP 资源释放检查，再启动对应版本；随后继续检查版本、实例和新启动标识。诊断不复制完整配置、数据目录、环境块或凭据。

### 发布门禁

`.github/workflows/hub-upgrade.yml` 先构建一次候选 tarball，再将同一文件交给 Windows、Linux、macOS × Node 22/24 的六组真实服务验收。基线默认为 npm 当前 `latest`，可通过手动触发指定具体版本。Linux 会准备 systemd 用户会话。报告和截图作为工作流产物上传。

发布应等待相关单测、类型检查和六组验收通过，核对 `result.json` 中的 tarball SHA-256，然后发布**同一份已测试文件**：

```bash
npm publish /absolute/path/to/the-tested-candidate.tgz
```

不要在测试后重新构建或直接对源码目录执行发布，否则校验过的文件与用户获得的文件可能不同。工作流本身不执行 npm 发布；分支保护和发布权限应将这个检查设为门禁。

### 结果的适用范围

本机通过证明该候选包在本机 OS、Node、账号权限及服务配置下完成了这些升级场景。矩阵通过再增加对应干净系统环境的证据。它们不能保证所有用户机器的网络、代理、磁盘、权限、系统版本和自定义部署都相同；生产数据兼容性也需要随 schema 改动增加历史数据夹具。

更强的交付约束是：扩大已支持环境矩阵，使用上一公开版本的真实历史数据样本，发布同一份验证过的包，并保留明确失败状态、诊断日志和旧运行版本。未跑过的平台应标记待验证，不能用源码单测通过替代。
