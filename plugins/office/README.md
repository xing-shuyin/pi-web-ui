# Office 高保真预览与编辑插件 📑

为 pi-web-ui 带来真正的原生画布级 Office 渲染体验（基于 DreamNum Univer 引擎）。

## 功能与特色

- **接管工作区文档点击**：在文件树中点击任何 `.pptx` / `.pptm` / `.ppsx` / `.potx` / `.xlsx` / `.xlsm` / `.docx`，直接弹出原生画布渲染窗口；
- **100% 真实渲染**：基于 2D Canvas / WebGL 渲染管线，真实还原 PPT 幻灯片矢量图形、母版背景、艺术字、图层、表格与图片，绝非简陋 HTML 模拟；
- **双向编辑与保存**：支持幻灯片放映与文字排版、Excel 表格批量编辑与快捷键保存（Ctrl+S 写回磁盘）；
- **自包含离线运行**：首次使用按需流式下载解压独立运行时（~34MB，不占用源码与 npm 发布体积），下载完成后本地离线秒级解析运行。

## 安装

```bash
# 建立软链接到用户插件目录（推荐）
ln -s /e/pi-web-ui/plugins/office ~/.pi-web/plugins/office
```
