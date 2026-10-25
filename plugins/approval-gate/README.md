# 定时任务拍板中心 (Approval Gate)

面向定时任务、后台批处理及外部调用的异步待办拍板中心插件。

> **架构概念辨析**：
> 本插件为**异步任务决策台账**（定时任务发现待办事项后登记，人工在界面集中查阅并跳转会话处理）；
> 智能体运行时的高危工具实时调用拦截、弹窗放行、白名单记忆管理与决策流日志属于服务端**内建安全能力**（`server/tool-approval.ts`），不依赖本插件。

## 功能特性

1. **集中待办台账**：顶栏「拍板」选项卡与红点徽标展示待拍板数量，聚合所有未决事项。
2. **通用 CLI 工具**：提供命令行工具 `bin/approval-gate.mjs`，供任意 Cron 脚本或自动化任务一键登记。
3. **会话联动与自动清账**：
   - 登记时关联指定 `conversationId`；
   - 点击待办项一键切入该会话进行审查；
   - 支持 `--auto-session` 模式：先登记待办项，自动由 `pi -p` 启动快照会话生成提示模板，用户在会话内拍板后自动清账。
4. **安全鉴权**：CLI 通过 HTTP 请求头（`x-pi-token` / `Authorization: Bearer`）安全传递鉴权口令，杜绝在 URL 查询串中泄露 Token。

## CLI 用法

```bash
# 登记普通拍板项
approval-gate register --task "每日备份检查" --title "发现 3 个过期未归档镜像，是否清理？" --project /path/to/project

# 自动建立快照会话并联动
approval-gate register --task "依赖安全告警" --title "发现 CVE-2026-xxxx" --auto-session "请审查依赖漏洞并评估升级方案"

# 查看待办列表
approval-gate list --pending

# 标记完成或忽略
approval-gate resolve --id apv-xxx --status resolved
approval-gate resolve --id apv-xxx --status dismissed
```
