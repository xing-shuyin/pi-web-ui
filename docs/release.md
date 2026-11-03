# 发布流程

> npm 发布者账号是 `xingshuyin`（`npm whoami` 验证）。`dist/`、`web/dist/` 被 gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；`prepublishOnly` 会在发布前自动 `npm run build`。

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

# 6) 打 tag 并推送（tag 带 v 前缀，数字与 npm 版本一一对应；issue #103 前缺的 tag 已回补）
#    漏打 tag 会导致 GitHub 看到的"最新版"落后于 npm，务必每次都打。
git tag vX.Y.Z
git push origin vX.Y.Z

# 7) GitHub Release（自动公示，无需手写）
#    tag 一推送，Action（.github/workflows/release-notes.yml）自动跑：
#    取 CHANGELOG 该版小节 + 按上个 tag 现场生成 ### i18n，创建 Release（已存在则更新 notes）。
#    本地只预览确认实际会发什么；Action 失败时才手动补发：
node scripts/release-notes.mjs X.Y.Z --base v<上个版本>   # 预览（输出到 stdout）
# node scripts/release-notes.mjs X.Y.Z --base v<上个版本> --out /tmp/notes.md --create

# 8) 发布 npm（会自动跑 prepublishOnly 构建）
npm publish

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
- 大改动发布前先问用户是否要 `npm publish`（会真实消耗账号权限、触发构建）。
- **升级后的重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、某功能一直加载中」。界面内「立即更新」（顶栏更新下拉）现在是在可见终端 tab 中跑 `npm i -g pi-web-ui@latest`（复用 SCM/插件卸载同款 tab 模式），完成后需手动重启服务生效：`pi-web-ui server restart`（launchd/systemd 由服务管理器拉起；Docker 需 `docker compose restart`）。服务端保留 `PI_WEB_RESTART_CHILD` 端口等待握手（restart-handoff-test 回归），供外部编排的替换子进程使用。
- **改桌面出包 workflow 先空跑再重推 tag**：`gh workflow run desktop-release.yml --ref main` 先验证三个平台 job 全绿，再重推 tag——重推 tag 会重建并 `--clobber` 覆盖 Release 资产，是正式出包的唯一路径。
- **发布前检查示例文件不泄密**：`deploy/`、`README` 等随 npm 包（`files` 白名单含 `deploy/`）和 GitHub 分发的文件**绝不放真实 IP / 域名 / 密钥**——用占位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真实环境配置只在本地改，不进仓库。

## 代码及文档不要泄露任何公网IP
