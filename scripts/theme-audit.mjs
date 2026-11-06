/**
 * 主题视觉审计：把「样式重构前后到底变没变」变成可比对的像素数据。
 *
 * 用法：
 *   node scripts/theme-audit.mjs --out .theme-audit/before
 *   ... 改样式 ...
 *   node scripts/theme-audit.mjs --out .theme-audit/after
 *   node scripts/theme-diff.mjs .theme-audit/before .theme-audit/after
 *
 * 为什么用**静态 fixture** 而不是真实会话：真实应用的历史消息是「尾部窗口 + 懒挂载 +
 * 分页补齐」，同一主题两次加载渲染条数都不同，像素 diff 会全是噪声。这里用一份
 * 覆盖关键界面的固定 DOM（气泡 / Markdown / 表格 / 代码 / 思考卡 / 工具卡 / 胶囊流 /
 * 输入岛 / 下拉菜单 / 徽标），配上 `web/src/styles.css` + 目标主题（服务端同款
 * `@import` 内联）渲染，于是**同一主题同一输入必然像素一致**，差异只会来自样式改动。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../tests/lib/chrome.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT_DIR = join(REPO_ROOT, argOf("out", ".theme-audit/out"));
const WIDTH = Number(argOf("width", "1280"));
const ONLY = argOf("themes", "");
const ROOT = argOf("root", REPO_ROOT);

const IMPORT_RE = /@import\s+["'](\.[^"']+\.css)["']\s*(?:layer\(([^)]+)\))?\s*;?[\r\n]*/g;

/**
 * 与服务端 `/themes/:id.css` 同款：把相对 `@import` 就地内联（单文件、无瀑布请求）。
 * 不直接复用 server/themes.ts，是因为本脚本跑在纯 node 上（不能 import .ts）。
 */
function readThemeCss(filePath, visited = new Set(), depth = 0) {
	if (depth > 3 || visited.has(filePath)) return "";
	visited.add(filePath);
	if (!existsSync(filePath) || !statSync(filePath).isFile()) return "";
	const content = readFileSync(filePath, "utf8");
	const dir = dirname(filePath);
	return content.replace(IMPORT_RE, (_m, rel, layerName) => {
		const target = resolve(dir, rel);
		if (!existsSync(target) || !statSync(target).isFile()) return "";
		const inner = readThemeCss(target, visited, depth + 1);
		// `@import "x.css" layer(base);` → 内联内容必须落在同名层里；否则那个
		return layerName ? `@layer ${layerName} {\n${inner}\n}\n` : inner + "\n";
	});
}

/** styles.css + 它的 @import 一起喂进去（浏览器里再 @import 相对路径不可靠）。 */
const BASE_CSS = readThemeCss(join(ROOT, "web", "src", "styles.css"));
const BASE_IS_LAYERED = /@layer\s+base\s*\{/.test(BASE_CSS);
const wrapTheme = (css) => (BASE_IS_LAYERED && css.trim() ? `@layer theme {\n${css}\n}\n` : css);
const THEMES_DIR = join(ROOT, "themes");

const FIXTURE = `
<div id="root">
<div class="app"><div class="layout"><main class="main">
  <header class="topbar">
    <button class="chip" title="新对话">＋</button>
    <span class="chip tab active">对话</span>
    <span class="chip">终端</span>
    <span class="chip github">GitHub</span>
    <span class="badge">5</span>
  </header>
  <div class="messages-wrap"><div class="messages anchor-live">
    <div class="msg-slot msg-slot-user"><div class="msg msg-user" data-role="user">
      <div class="msg-meta"><span class="msg-role">你</span><span class="msg-time">21:52</span></div>
      <div class="msg-body"><div class="msg-text"><div class="markdown"><p>顺手把 ToolInspectorModal 的未使用 import 也清掉 并提交</p></div></div></div>
    </div></div>

    <div class="msg-slot msg-slot-assistant"><div class="msg msg-assistant" data-role="assistant">
      <div class="msg-meta"><span class="msg-role">Pi</span><span class="msg-time">21:52</span></div>
      <div class="msg-body">
        <div class="msg-text"><div class="markdown">
          <p>先清掉那个未使用 import。<strong>关键约束</strong>：<code>locales/*.json</code> 是交叉文件。</p>
          <h2>根因</h2>
          <ul><li>第一项</li><li>第二项</li></ul>
          <pre><code>npm run typecheck\nnpm run lint</code></pre>
          <table><thead><tr><th>批次</th><th>文件</th><th>归属</th></tr></thead>
            <tbody><tr><td>本对话</td><td>server/message-window.ts</td><td>两轮</td></tr>
            <tr><td>工具详情</td><td>ToolInspectorModal.tsx</td><td>之前</td></tr></tbody></table>
          <p>参考 <a href="#">文档链接</a> 与行内 <code>code</code>。</p>
        </div></div>
      </div>
    </div></div>

    <div class="turn-tools-trail">
      <div class="msg msg-assistant"><div class="msg-body">
        <div class="thinking ok"><div class="chead thinking-head">
          <span class="chead-icon thinking-icon">✦</span><span class="chead-title thinking-name">think</span>
        </div></div>
      </div></div>
      <div class="msg msg-assistant"><div class="msg-body">
        <div class="toolcall ok"><div class="chead toolcall-head">
          <span class="chead-icon toolcall-icon tc-tone-exec">&gt;_</span>
          <span class="chead-title toolcall-name">bash</span>
          <span class="toolcall-cmd">npm run typecheck</span>
          <span class="toolcall-status">✓</span>
        </div></div>
      </div></div>
      <div class="msg msg-assistant"><div class="msg-body">
        <div class="toolcall err"><div class="chead toolcall-head">
          <span class="chead-icon toolcall-icon tc-tone-edit">✎</span>
          <span class="chead-title toolcall-name">edit</span>
          <span class="toolcall-path">web/src/components/Message.tsx</span>
          <span class="toolcall-status">✗</span>
        </div></div>
      </div></div>
    </div>

    <div class="flow-turn">
      <div class="msg msg-assistant"><div class="msg-body">
        <div class="thinking ok"><div class="chead thinking-head"><span class="chead-icon thinking-icon">✦</span><span class="chead-title thinking-name">think</span></div></div>
        <div class="toolcall ok"><div class="chead toolcall-head"><span class="chead-icon toolcall-icon tc-tone-exec">&gt;_</span><span class="chead-title toolcall-name">bash</span></div></div>
        <div class="toolcall ok"><div class="chead toolcall-head"><span class="chead-icon toolcall-icon tc-tone-edit">✎</span><span class="chead-title toolcall-name">edit</span></div></div>
        <div class="toolcall ok"><div class="chead toolcall-head"><span class="chead-icon toolcall-icon tc-tone-exec">&gt;_</span><span class="chead-title toolcall-name">bash</span></div></div>
        <div class="msg-text"><div class="markdown"><p>修好了，而且根因不在 pt.json 本身。</p></div></div>
        <div class="toolcall ok"><div class="chead toolcall-head"><span class="chead-icon toolcall-icon tc-tone-exec">&gt;_</span><span class="chead-title toolcall-name">bash</span></div></div>
      </div></div>
    </div>

    <div class="msg-slot msg-slot-assistant"><div class="msg msg-assistant">
      <div class="msg-body">
        <div class="msg-text"><div class="markdown"><p>两个提交都落好了，工作区现在是干净的。</p></div></div>
        <div class="msg-actions"><button class="msg-action">⧉</button><button class="msg-action">↻</button></div>
      </div>
    </div></div>
  </div></div>

  <div class="inputbar"><div class="inputbox">
    <textarea rows="1">给 pi 发送消息 — Enter 发送，/ 查看命令</textarea>
    <div class="input-actions">
      <button class="btn">📎</button>
      <button class="btn send">↑</button>
    </div>
  </div></div>

  <div class="dd-menu"><div class="dd-item active">深色</div><div class="dd-item">极简行文</div><div class="dd-item">白色</div></div>

  <!-- 「主题为准」区域：分层后由 theme 层胜出的几处（quick-chip / bar-item / 插件图标 /
       hide-model-row 下的消息内边距）。故意纳入夹具，让闸门看得见它们，
       防止后人把它们当成「被基线压住了」又改回去。 -->
  <div class="quick-chips-wrapper">
    <button class="quick-chip">继续</button>
    <button class="quick-chip active">上传发布</button>
  </div>
  <aside class="side-dock">
    <button class="bar-item"><span class="bar-item-icon">⧉</span><span class="bar-item-text">工具</span></button>
    <button class="bar-item"><span class="bar-item-icon">⚙</span><span class="bar-item-text">设置</span></button>
  </aside>
  <div class="plugin-manager-item"><span class="plugin-icon-svg">🧩</span><span>插件</span></div>
</main>
<main class="main hide-model-row">
  <div class="messages">
    <div class="msg msg-assistant"><div class="msg-body"><div class="msg-text"><div class="markdown"><p>紧凑模式下的一条消息</p></div></div></div></div>
    <div class="msg msg-assistant"><div class="msg-body"><div class="msg-text"><div class="markdown"><p>第二条消息</p></div></div></div></div>
  </div>
</main>
</div></div>
</div>
`;

function themeIds() {
	const ids = readdirSync(THEMES_DIR)
		.filter((f) => f.endsWith(".css"))
		.map((f) => f.replace(/\.css$/, ""));
	const order = ["dark", ...ids.filter((id) => id !== "dark")];
	return ONLY ? order.filter((id) => ONLY.split(",").includes(id)) : order;
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 1 });
mkdirSync(OUT_DIR, { recursive: true });

const themes = themeIds();
console.log(`审计 ${themes.length} 个主题 → ${OUT_DIR}`);
for (const id of themes) {
	const themeCss = id === "dark" ? "" : wrapTheme(readThemeCss(join(THEMES_DIR, `${id}.css`)));
	await page.setContent(
		`<!doctype html><html><head><meta charset="utf-8">
		 <style>${BASE_CSS}</style>
		 <style id="theme">${themeCss}</style>
		 <style>*,*::before,*::after{animation:none !important;transition:none !important}.msg-time{visibility:hidden}</style>
		 </head><body>${FIXTURE}</body></html>`,
		{ waitUntil: "load" },
	);
	await page.evaluate(() => document.fonts?.ready);
	await page.waitForTimeout(100);
	await page.screenshot({ path: join(OUT_DIR, `${id}.png`) });
}
await browser.close();
console.log(`完成：${themes.length} 张截图`);
