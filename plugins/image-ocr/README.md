# 图片文字识别 / Image OCR

在任意图片预览中点击“识别文字”。未安装时同一个按钮会安装本插件，安装后再次点击即可识别。

- 默认识别简体中文和英文，结果可选择或一键复制。
- 无需 API Key；图片在浏览器本地识别，不上传到 OCR 服务。
- 首次使用需要从 jsDelivr 下载 Tesseract.js 6.0.1、WASM 与字库；字库缓存于浏览器。下载期间可取消。
- 远程图片需要服务端允许 CORS。读取失败时，可把图片保存为本地附件再识别。
- 字体很小、旋转、手写或低清图片可能识别不准。
- 取消、关闭预览、切换图片或禁用插件会停止任务。没有后台轮询或常驻识别引擎。

`view:false` / `preload:true`：客户端顶层只注册宿主 API v15 的 `imageOcrProviders`，点击才创建 Worker。图片读取沿用应用原始地址及同源身份验证，不把应用凭据发给 CDN。

Image OCR recognizes Simplified Chinese and English in the shared image preview. The first click installs the plugin when needed. Recognition runs locally, requires no API key, and supports cancellation and copying. First use needs internet access for engine/language downloads. Remote images require CORS; attach them locally if access is blocked.
