# 远程工作区（SSH）桥接

> 覆盖「远程目录当工作区」时，SDK 的文件类工具如何被重定向到 SFTP：注入点、契约完备性、
> 图片判定口径、流式读取，以及已知边界。

## 目录

- [事实源](#事实源)
- [为什么需要桥接层](#为什么需要桥接层)
- [契约覆盖表（SDK ops 是可选演进的）](#契约覆盖表sdk-ops-是可选演进的)
- [图片 MIME：扩展名优先，无名文件才嗅探魔数](#图片-mime扩展名优先无名文件才嗅探魔数)
- [文本读取必须走流](#文本读取必须走流)
- [已知边界](#已知边界)

## 事实源

| 关注点                                                                                                                                      | 文件                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 桥接实现（`createRemoteSdkOperations`：给 SDK 的 read/write/edit/ls/find ops，`grepExecute`，终端与命令）                                   | `server/remote-ssh-service.ts` ★                                                 |
| 本地会话目录 ↔ `ssh://…` URI 的映射与还原（`resolveWorkspaceSessionDir` / `mapResolvedPathToRemote` / `restoreWorkspaceUriFromSessionDir`） | `server/remote-ssh-service.ts` ★                                                 |
| 图片判定（`imageMimeOfExt` / `sniffImageMime`）与嗅探字节数（`IMAGE_SNIFF_BYTES`）                                                          | `server/text-sniff.ts` ★                                                         |
| ops 注入口（把 `remoteOps.*` 传给 `create*ToolDefinition`）                                                                                 | `server/read-tool.ts` · `server/tool-guards.ts` · `server/agent-service.ts`      |
| 契约锚点守卫                                                                                                                                | `tests/unit/remote-ops-contract.test.ts` · `tests/unit/remote-workspace.test.ts` |

## 为什么需要桥接层

SDK 的每个文件工具都把文件系统操作收成一个可注入的 ops 接口（`ReadOperations` / `WriteOperations` /
`EditOperations` / `LsOperations` / `FindOperations` …）。远程工作区没有本地挂载点，所以桥接层负责把
「本地会话目录下的绝对路径」翻回远端绝对路径，再用 SFTP / `find` / `rg` 执行同一个语义。

注入点只有一处：**我们自己造工具时**（`createReadToolDefinition(cwd, { operations })`）。因此远程目录下
看到的行为，取决于桥接层是否把契约**实现完整**——漏一个成员不会报错，工具会退回默认行为（本地文件系统），
或者在不该降级的地方降级。

## 契约覆盖表（SDK ops 是可选演进的）

`ReadOperations` 里 `detectImageMimeType` 与 `createReadStream` 都是**可选项**：`?` 天然绕过 TypeScript
的赋值检查，上游加成员时桥接层也不会得到任何提示。这是本模块唯一反复踩的坑，所以：

1. 每组 ops 都写 `satisfies <SDK 的 Ops 类型>`（挡住必选项缺失 + 让「这一组实现的是谁的契约」写在代码里）；
2. `tests/unit/remote-ops-contract.test.ts` 用 `Record<keyof Required<XxxOperations>, true>` 字面量 +
   运行时键比对，**上游任何成员变更（含可选项）都会让这个文件编译失败**——逼迫桥接层做一次显式决定：
   实现它，或在锚点旁写下不实现的理由。

新增/升级 SDK 时的动作：先跑 `npm run typecheck`，红了就按上面的方式收口，不要用 `as any` 绕过。

`grep` 不在锚点范围内：远程 grep 是整体替换 `execute`（`grepExecute` 走远端 `rg`/`grep`），不是填
`GrepOperations`，而后者唯一的可选成员 `readFile` 已被上游标为 deprecated。

**镜像不是必须的**：能「拿 SDK 默认实现打底、只覆盖原语」就别整组手写——`bash` 就是这么做的
（`server/bash-tool.ts` 用 `createLocalBashOperations()` 打底，只覆盖 `exec`，SDK 新增成员自动继承）。
`read`/`write`/`edit`/`ls`/`find` 没有对应的导出原语，才只能整组手写 + 锚点兜底；哪天上游导出了
「由 `{stat, read, readdir}` 端口生成 ops」的适配器，桥接层应当换成那一套。

## 图片 MIME：扩展名优先，无名文件才嗅探魔数

`read` 先 `access` → `detectImageMimeType` → 命中图片才 `readFile` + `processImage`，否则按文本读。
远程侧判据（`server/remote-ssh-service.ts`）：

| 情况                                                            | 行为                                                   | 代价         |
| --------------------------------------------------------------- | ------------------------------------------------------ | ------------ |
| 扩展名是图片（`.png/.jpg/.jpeg/.gif/.webp/.bmp`，大小写不敏感） | 直接返回 MIME                                          | 0 次额外往返 |
| 有扩展名但不是图片（`.md` / `.svg` / `.ts` …）                  | 返回 `null`，按文本读                                  | 0 次额外往返 |
| 没有扩展名（构建产物、截图导出）                                | 读 `IMAGE_SNIFF_BYTES` 字节文件头按魔数判              | 1 次 SFTP 读 |
| 0 字节 / 读不出来                                               | 返回 `null`（契约要求「不是图片」返回 null，不抛异常） | —            |

**扩展名优先是刻意的**：远端一次往返比本地一次 `open` 贵几个数量级，而「命名正确的图片」是绝对主流；
`previewKind`（UI 预览分类）也是按扩展名判的，两处口径一致。与本地 `read`（SDK 只按魔数判，且校验更严：
拒绝 APNG/JPEG-LS、校验 PNG IHDR 与 BMP 结构）的差异只有一种：**文件名撒谎**（`foo.png` 里装文本、
`foo.ts` 里装 PNG）时行为不同——本地按内容，远程按名字。这是已知并接受的取舍。

`IMAGE_SNIFF_BYTES = 4100` 与 SDK 本地探测的 `IMAGE_TYPE_SNIFF_BYTES` 对齐，单源在 `server/text-sniff.ts`。

## 文本读取必须走流

`createReadStream` 缺失时，SDK 退回 `readFile`：远程 `read` 哪怕只要 20 行，也会把**整个文件**通过 SFTP
传回并 `Buffer.concat` 进服务端堆（远端 1 GB 日志就能把进程打爆）。桥接层的实现复用
`sftpCreateReadStream`，分行/截断/`offset` 仍由 SDK 负责，桥接层只负责「一块一块地给」并在 `signal`
abort 时销毁流（否则连接会挂到空闲超时才回收）。

## 已知边界

- **扩展提供同名工具时桥接不生效**：`composeWith: (base) => withReadDirSupport(base, cwd)` 里的 `base` 是
  扩展自己造的工具，它的 ops 指向本地文件系统。此时远程工作区里 `read` 的文件分支会回到本地路径（目录分支
  不受影响，因为 `ls` 在包装层重建并注入了 `remoteOps.ls`）。需要覆盖远程读取的扩展必须自己处理这条路径。
- **写侧不做远端能力探测**：`write` 只保证「写成功/报错」，`mkdir` 递归由 SFTP 侧实现。
- 桥接层不缓存文件内容：一次 `read` 内的 `access` / `detectImageMimeType` / `readFile` 各自独立往返。
