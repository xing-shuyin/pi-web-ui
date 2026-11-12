# 发布流程

> npm 发布者账号是 `xingshuyin`（`npm whoami` 验证）。`dist/server/`、`web/dist/` 被 gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；`dist/` 根目录的本地测试文件与桌面产物不进入 npm 包；`prepublishOnly` 会在发布前自动 `npm run build`；服务端构建先清理 `dist/server/`，再编译，避免已删除源码的旧输出留在发布包。

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

# 8) 发布 npm（会自动跑 prepublishOnly 构建）
#    账号开了 2FA：用「绕过 2FA 的 granular token」直接 npm publish 会被 registry 降级成
#    staged 发布（版本几分钟后才落库，期间重试只会 409 Cannot publish over previously
#    staged version；unpublish / 改 dist-tag 更是直接 403）。走带 OTP 的封装：
NPM_OTP=123456 npm run release:npm     # 预检脏工作区/账号/tag + 带 OTP 发布 + staged 自愈
#    等价手工命令：npm publish --otp=123456
#    只想看会打出什么：npm run release:npm -- --dry-run

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

# 8.6) 手机端 APK + 桌面安装包（本地一键，推荐）
#    一条命令出齐：桌面（当前平台）+ 手机 arm64（含引擎运行时），并挂到该 tag 的 Release：
npm run release:local -- vX.Y.Z                # 全量：桌面 + 手机（手机那步 qemu 构建 15–25 分钟）
npm run release:local -- vX.Y.Z --skip-mobile  # 只打桌面
npm run release:local -- vX.Y.Z --skip-desktop # 只打手机
npm run release:local -- vX.Y.Z --no-upload    # 只打包，不碰 Release
npm run release:local -- vX.Y.Z --portable     # 额外出便携版（内置 Git/Node，较慢）
#    脚本会先校验 tag 与 package.json 版本一致，然后：npm run build → 桌面打包 → （可选）构建
#    arm64 运行时并打 APK → 生成 SHA256SUMS.txt → gh release upload --clobber。
#    为什么本地优先：手机 APK 里带 280 MB 引擎运行时，CI 那份 qemu 又慢又每次换 debug 签名
#    （新包装不上旧包，连手机上的引擎数据一起清）；桌面 Windows 安装包本地几分钟就出。
#    两个已知限制：
#      - Windows 的 NSIS 安装包本地生不出来（electron-builder 打完要执行刚产出的 setup.exe
#        生成卸载器，本机被系统拦下：ERR_ELECTRON_BUILDER_CANNOT_EXECUTE / exit code null），
#        所以本地出的是免安装 zip（release/pi-web-ui-desktop-<版本>-win-x64-portable.zip）；
#        需要正式安装包时用 CI 的 desktop-release windows job。
#      - macOS / Linux 安装包只能在对应系统上打，仍由 .github/workflows/desktop-release.yml 出。
#    .github/workflows/mobile-release.yml 保留但改成手动触发（Actions 里点），用于云端兜底；
#    它需要可选的 MOBILE_KEYSTORE_BASE64 等 secrets 才能发出可升级的包。

# 9) 验证
npm view pi-web-ui version        # 应显示新版本（registry 有缓存延迟属正常）
curl -s https://registry.npmjs.org/pi-web-ui/latest | jq .version
git ls-remote --tags origin       # 应能看到 vX.Y.Z
```

## 注意事项

- 版本号**必须**高于 npm registry 上已有的（用 `npm view pi-web-ui version` 查当前值）。
- 版本号格式：npm 不带 `v` 前缀（`0.70.0`），git tag / GitHub Release 带 `v` 前缀（`v0.70.0`）。
- 提交信息不要带 `Co-authored-by`（P1 规则，仓库 hook 会拦）。
- `.pi/commands.json` 是**每个项目各自**的个人命令（当前 cwd 的 `.pi/ 下），已被 gitignore，永远不会进公开仓库；切换 cwd 时命令列表自动刷新为该项目的命令。
- CI 绿标守护模式下，必须先完成最终提交的 CI 验证，再展示版本与 Release Notes 请求发布确认；同一次确认涵盖该版本的 tag 推送及 `npm publish`。
- **升级后的重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、某功能一直加载中」。界面内「立即更新」（顶栏更新下拉）现在是在可见终端 tab 中跑 `npm i -g pi-web-ui@latest`（复用 SCM/插件卸载同款 tab 模式），完成后需手动重启服务生效：`pi-web-ui server restart`（launchd/systemd 由服务管理器拉起；Docker 需 `docker compose restart`）。服务端保留 `PI_WEB_RESTART_CHILD` 端口等待握手（restart-handoff-test 回归），供外部编排的替换子进程使用。
- **改桌面出包 workflow 先空跑再重推 tag**：`gh workflow run desktop-release.yml --ref main` 先验证三个平台 job 全绿，再重推 tag——重推 tag 会重建并 `--clobber` 覆盖 Release 资产，是正式出包的唯一路径。
- **发布前检查示例文件不泄密**：`deploy/`、`README` 等随 npm 包（`files` 白名单含 `deploy/`）和 GitHub 分发的文件**绝不放真实 IP / 域名 / 密钥**——用占位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真实环境配置只在本地改，不进仓库。

## 代码及文档不要泄露任何公网IP
