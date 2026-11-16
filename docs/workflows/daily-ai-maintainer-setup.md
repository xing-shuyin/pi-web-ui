[English](./daily-ai-maintainer-setup.en.md) · **简体中文** · [繁體中文](./daily-ai-maintainer-setup.zh-TW.md)

# 每日 GitHub 维护画布

已保存工程并启用每日任务，未立即运行。

- 工程名称：每日 GitHub Issue 与 PR 维护。
- 工程 ID：`graph_1793377347784_-GitHub-Issue-PR-`。
- 定时任务 ID：`task-pdjues`，cron `0 9 * * *`，已启用。
- 已核对本机时区为 `Asia/Shanghai`，每天北京时间 09:00；下次 2026-10-31 09:00。
- 共 8 个节点、7 条依赖边。旧工程及旧任务已删除。

节点顺序：启动核对 → GitHub 完整收集 → 分类排优先级 → PR 静态审查与实现 → 独立逐行复核 → 组合产物实际验证 → 单一合并发布与回复 → 状态归档。

范围仅为 GitHub Issue、PR、审查与评论，以及相关 npm/GitHub Release 发布。不需要其他社区平台的连接或权限。

节点目录为 `E:/pi-web-ui`，引擎为 pi，模型留空以跟随默认配置。实现、复核、验证节点启用隔离工作树，源基线必须干净。第三方代码运行仍需容器或虚拟机；工作树隔离不能替代执行沙箱。

首次运行核对 GitHub 权限、仓库外私有状态目录、可靠锁和隔离执行环境；缺失能力时报告阻塞，不能伪造验证通过。对外写操作集中于发布节点，连线完成不代表可以跳过审查和保护规则。

备份工程为 `daily-ai-maintainer.canvas.json`，可通过画布导入 JSON 恢复；导入会生成新 ID，恢复时须重新绑定定时任务，避免重复启用。完整规范见 `../daily-ai-maintainer-workflow.md`，并已内嵌节点指令。
