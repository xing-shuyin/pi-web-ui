# 流式消息稳定性约束

流式内容变化需要重新渲染；稳定性要求是已有内容不因身份交接而卸载、重置状态或移动用户阅读位置。

## 身份贯穿三层

1. `MessageList` 将 stream ID 映射到正式消息的稳定 render key。集群外层同样使用首消息的稳定 key。不能仅稳定内层 Message 的 key：React key 只在同一父节点下有效。
2. 助手连续输出保持相同 React 父级归属。普通模式中包含正文的集群使用透明容器，不把正文放进密集工具外观；flow 模式保留回合容器。消息从空帧到思考、工具、正文、定稿时不迁移父节点。主题切换或会话切换不承诺保持相同节点。
3. `Message` 内部块按块位置标识，不使用会在定稿时变化的 message.id。`StreamMarkdown` 的冻结段与活动尾段使用同一种 Segment 组件和同一 keyed list，避免尾段冻结时改变组件类型。

块位置规则依赖协议的内容块追加顺序。若未来允许在已有块前插入、重排或删除，必须引入稳定 block ID，不能继续依赖索引。

同一个流式消息的 pending 边界不会被后续快照覆盖。旧消息定稿与新流开始可以分帧或同帧抵达，但不能让下一条消息继承旧消息的身份。

## 渲染与滚动

流式生成过的文本块在定稿后保留 StreamMarkdown，不为了“最终校正”切回另一棵静态 Markdown 树。段落冻结立即使用最新文本，但保留 MarkdownBody。代码围栏关闭后启用完整语法高亮，允许高亮内部节点变化。

用户向上滚动后，定稿不得重新吸底。浏览器测试通过实际 wheel 语义退出贴底，再检查 scrollTop；仅脚本设置 scrollTop 不能替代用户滚动行为。

图片、公式、插件异步加载可能有合理的尺寸变化，不能把它们的完成误判为身份重建。本套测试不承诺任何内容变化都完全没有布局变化。

## 自动门禁

`npm test` 自动发现以下组件测试：

- `message-finalization-dom.test.ts`：真实 Message → StreamMarkdown → MarkdownBody，定稿保留正文节点。
- `stream-segment-identity.test.ts`：真实 Markdown，段落冻结保留 p/行内 code，长尾冻结不丢字，代码围栏正常高亮。
- `message-list-identity.test.ts`：真实列表分支下检查挂载生命周期与节点，覆盖普通/flow、空帧→工具→正文、旧流定稿与新流交接。

`node tests/stream-stability-ui-test.mjs` 使用独立 Vite 与 Chrome，不请求模型、不操作用户浏览器。覆盖真实 MessageList/Markdown、普通与 flow 布局、段落冻结、正常/中止/错误定稿、思考转正文，以及用户阅读位置。已登记到 `tests/run-smoke.mjs`，CI 冒烟执行；没有 Chrome 时按仓库惯例 SKIP。flow 测试开启主题能力令牌，未加载完整自定义主题样式。

测试夹具仅位于 tests/fixtures，不进入生产入口。断言以 DOM identity、生命周期与滚动位置为主，不依赖截图像素或 React 渲染次数。
