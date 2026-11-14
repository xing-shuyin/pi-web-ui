import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	BROWSER_DESIGN_KINDS,
	type BrowserDesignDocument,
	type BrowserDesignKind,
	type BrowserDesignStatus,
} from "../contracts.js";

/**
 * 浏览器自定义资产（新标签页 HTML / 主题覆盖 CSS）。
 *
 * 设计约束：
 * - 代码是缓存、状态要独立：用户内容只住 `dataDir/custom/`，绝不写进 `dist/browser/renderer`
 *   （打包后是只读的，重建构建时也会被清掉）。
 * - 一个 kind 一个文件：新标签页就是一份自包含 HTML（inline CSS/JS 随便写），
 *   主题就是一份 CSS；不做多文件工程，也不做模板语法。
 * - 大小上限挡住「AI 把 20MB 的 base64 图片塞进新标签页」这类事故，超了直接报错而不是截断。
 */
export const DESIGN_FILES: Record<BrowserDesignKind, string> = {
	newtab: "newtab.html",
	theme: "theme.css",
};

export const MAX_DESIGN_BYTES = 512 * 1024;

/**
 * 新标签页起步模板：一份能直接跑的设计稿，同时把宿主桥的用法演示清楚。
 * `piBrowserShell.call` 只在浏览器内部页里存在；自定义页可调只读子集，凭据类仅限内置页。
 * 里面的注释就是给模型与用户的 API 说明。
 */
export const NEWTAB_STARTER = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>新标签页</title>
<style>
  :root { color-scheme: dark; --bg: #0f1116; --fg: #e8ebf2; --dim: #8b93a7; --accent: #6aa8ff; --line: #262b38; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(120% 120% at 50% 0%, #1b2233 0%, var(--bg) 62%);
    color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: min(720px, 88vw); display: grid; gap: 24px; }
  .clock { font-size: clamp(52px, 12vw, 104px); font-weight: 200; letter-spacing: -0.02em; text-align: center; font-variant-numeric: tabular-nums; }
  .date { margin-top: -18px; text-align: center; color: var(--dim); }
  form { display: flex; gap: 10px; padding: 8px 8px 8px 20px; border: 1px solid var(--line); border-radius: 999px; background: #181b23; }
  form:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 22%, transparent); }
  input { flex: 1; min-width: 0; border: 0; background: none; color: inherit; font: inherit; outline: none; }
  button { padding: 8px 18px; border: 0; border-radius: 999px; background: var(--accent); color: #06101f; font: inherit; font-weight: 600; cursor: pointer; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  nav a { padding: 6px 14px; border: 1px solid var(--line); border-radius: 999px; background: #181b23; color: var(--fg); font-size: 14px; text-decoration: none; }
  nav a:hover { border-color: var(--accent); }
  footer { position: fixed; bottom: 14px; width: 100%; text-align: center; color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<main>
  <div>
    <div class="clock" id="clock">--:--</div>
    <div class="date" id="date"></div>
  </div>
  <form id="search">
    <input id="query" placeholder="搜索或输入网址" autocomplete="off" autofocus />
    <button type="submit">搜索</button>
  </form>
  <nav id="links"></nav>
</main>
<footer>自定义新标签页 · 在浏览器设置的「新标签页 / 主题」里随时改回默认</footer>
<script>
  // 宿主桥：只在 AI Browser 的内部页里存在；自定义页可调只读子集，凭据类仅限内置页。
  // 常用动作：settings.get / bookmarks.list / tabs.create({url}) / navigate({url})
  const shell = window.piBrowserShell;
  const call = (action, args) => (shell ? shell.call(action, args) : Promise.reject(new Error("no bridge")));
  const ENGINES = {
    bing: "https://www.bing.com/search?q=",
    google: "https://www.google.com/search?q=",
    baidu: "https://www.baidu.com/s?wd=",
    duckduckgo: "https://duckduckgo.com/?q=",
  };
  let engine = "bing";
  let newTabMode = "current";

  function paintClock() {
    const now = new Date();
    document.getElementById("clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    document.getElementById("date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  }
  paintClock();
  setInterval(paintClock, 15000);

  function flatten(nodes, out) {
    for (const node of nodes || []) {
      if (node.type === "folder") flatten(node.children, out);
      else if (node.url) out.push(node);
      if (out.length >= 8) return out;
    }
    return out;
  }

  (async () => {
    try {
      const settings = await call("settings.get");
      engine = settings.searchEngine || engine;
      newTabMode = settings.newTabOpenMode || newTabMode;
    } catch {}
    try {
      const links = document.getElementById("links");
      for (const bookmark of flatten(await call("bookmarks.list"), [])) {
        const a = document.createElement("a");
        a.href = bookmark.url;
        a.textContent = bookmark.name;
        a.target = newTabMode === "current" ? "_self" : "_blank";
        links.append(a);
      }
    } catch {}
  })();

  document.getElementById("search").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = document.getElementById("query").value.trim();
    if (!value) return;
    const looksLikeUrl = /^[a-z][a-z\\d+.-]*:\\/\\//i.test(value) || /^[\\w-]+(\\.[\\w-]+)+(\\/|$)/.test(value);
    const url = looksLikeUrl ? (value.includes("://") ? value : "https://" + value) : (ENGINES[engine] || ENGINES.bing) + encodeURIComponent(value);
    if (shell) call("tabs.create", { url }).catch(() => { location.href = url; });
    else location.href = url;
  });
</script>
</body>
</html>
`;

/** 主题的起步内容：一份注释齐活的覆盖样式，说明能改什么。 */
export const DEFAULT_THEME_HINT = `/* 主题覆盖：这段 CSS 会注入到浏览器外壳 / 面板 / 新标签页 / 工作区。
   想改配色，覆盖 :root 与 html[data-theme="..."] 里的 --pb-* 变量即可；
   想改某个部件，直接用浏览器里看到的选择器覆盖（后注入的同名规则优先）。 */
:root {
  /* --pb-accent: #6aa8ff; */
  /* --pb-bg: #101318; */
}
`;

const objectKind = (value: unknown): BrowserDesignKind => {
	if (typeof value !== "string" || !(BROWSER_DESIGN_KINDS as readonly string[]).includes(value))
		throw new Error(`Invalid design kind: ${String(value)} (expected newtab or theme)`);
	return value as BrowserDesignKind;
};

export function parseDesignKind(value: unknown): BrowserDesignKind {
	return objectKind(value);
}

export class BrowserCustomization {
	/** 用户内容目录：`<browser data dir>/custom/`。 */
	readonly dir: string;

	constructor(browserDataDir: string) {
		this.dir = path.join(browserDataDir, "custom");
	}

	path(kind: BrowserDesignKind): string {
		// 单漏斗：所有读写都从这里拿路径，没人能把 kind 拼成 `../` 之类的东西
		return path.join(this.dir, DESIGN_FILES[objectKind(kind)]);
	}

	read(kind: BrowserDesignKind): string | null {
		try {
			return fs.readFileSync(this.path(kind), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	status(kind: BrowserDesignKind): BrowserDesignStatus {
		const file = this.path(kind);
		try {
			const stat = fs.statSync(file);
			if (!stat.isFile()) throw new Error(`${DESIGN_FILES[kind]} is not a file`);
			return {
				kind,
				file: DESIGN_FILES[kind],
				path: file,
				custom: true,
				bytes: stat.size,
				updatedAt: stat.mtimeMs,
				maxBytes: MAX_DESIGN_BYTES,
			};
		} catch {
			return { kind, file: DESIGN_FILES[kind], path: file, custom: false, bytes: 0, maxBytes: MAX_DESIGN_BYTES };
		}
	}

	statuses(): BrowserDesignStatus[] {
		return BROWSER_DESIGN_KINDS.map((kind) => this.status(kind));
	}

	document(kind: BrowserDesignKind): BrowserDesignDocument {
		const content = this.read(kind);
		return {
			status: this.status(kind),
			content: content ?? (kind === "newtab" ? NEWTAB_STARTER : DEFAULT_THEME_HINT),
			starter: content === null,
		};
	}

	/** 空内容等于「删掉这份自定义」，语义与 reset 一致，避免留一个空白页把人困住。 */
	write(kind: BrowserDesignKind, value: unknown): BrowserDesignStatus {
		if (typeof value !== "string") throw new Error("Design content must be a string");
		const content = value.replace(/^\uFEFF/, "");
		if (!content.trim()) return this.reset(kind);
		if (content.includes("\u0000")) throw new Error("Design content must be text, not binary");
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_DESIGN_BYTES)
			throw new Error(
				`Design content is ${Math.round(bytes / 1024)}KB; the limit is ${Math.round(MAX_DESIGN_BYTES / 1024)}KB`,
			);
		const target = this.path(kind);
		const temp = `${target}.${randomUUID()}.tmp`;
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		try {
			fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			fs.renameSync(temp, target);
		} finally {
			fs.rmSync(temp, { force: true });
		}
		return this.status(kind);
	}

	reset(kind: BrowserDesignKind): BrowserDesignStatus {
		fs.rmSync(this.path(kind), { force: true });
		return this.status(kind);
	}

	/** 主题覆盖 CSS：没有就返回空串（调用方按「不注入」处理）。 */
	themeCss(): string {
		return this.read("theme") ?? "";
	}

	/** 新标签页最终该打开的地址：有自定义文件就用它，否则回落内置页。 */
	newTabUrl(builtin: string): string {
		return this.status("newtab").custom ? pathToFileURL(this.path("newtab")).href : builtin;
	}

	/** 某个 URL 是否就是自定义新标签页文件（含查询串 / 锚点）。 */
	isNewTabFile(value: string): boolean {
		return sameFilePath(value, this.path("newtab"));
	}

	/** 某个 URL 是否落在自定义目录里（用于把过期标签还原成新标签页）。 */
	isCustomFile(value: string): boolean {
		return BROWSER_DESIGN_KINDS.some((kind) => sameFilePath(value, this.path(kind)));
	}
}

function sameFilePath(value: string, target: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "file:") return false;
		// fileURLToPath 自己会丢掉查询串 / 锚点，Windows 盘符与百分号编码也归它管
		return path.resolve(fileURLToPath(url)) === path.resolve(target);
	} catch {
		return false;
	}
}
