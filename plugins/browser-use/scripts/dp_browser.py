#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
browser-use — DrissionPage 常驻浏览器控制后端

原理:
  每次调用通过 Chromium(port) 连接或启动一个常驻 Chrome(默认端口 9333)。
  浏览器进程在命令结束后保持运行，多次调用共享同一个浏览器窗口：
  标签页、登录态、页面滚动状态全部持续存在，可反复 open / snapshot / click / input。
  页面快照只采集人类可见元素(链接/按钮/输入框/下拉/文本/标题/图片)，
  不包含 CSS / JS / 内部实现信息，极其节省 Token。

用法:
  python dp_browser.py <命令> [参数...]    (全部命令输出 JSON)
  或: python dp_browser.py help
"""

import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
from collections import Counter
from pathlib import Path
from typing import NoReturn

SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_DIR = SCRIPT_DIR.parent
CMD = ""




def out(obj, code=0) -> NoReturn:
    print(json.dumps(obj, ensure_ascii=False, default=str))
    sys.exit(code)


def fail(msg, hint=None) -> NoReturn:
    d = {"ok": False, "cmd": CMD, "error": msg}
    if hint:
        d["hint"] = hint
    out(d, 1)




def _has_dp(py):
    try:
        return (
            subprocess.run(
                [str(py), "-c", "import DrissionPage"],
                capture_output=True,
                timeout=30,
            ).returncode
            == 0
        )
    except Exception:
        return False


def _ensure_python():
    """返回带 DrissionPage 的解释器路径。
    当前解释器可用时返回 None；否则优先查找 cwd 的 .venv，最后在插件目录自建 .venv。
    """
    if _has_dp(sys.executable):
        return None
    for cand in (Path.cwd() / ".venv", Path.cwd() / "venv"):
        py = cand / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if py.exists() and _has_dp(py):
            return str(py)
    venv = PLUGIN_DIR / ".venv"
    py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not py.exists():
        print(
            ">>> DrissionPage 未安装，首次使用自动创建虚拟环境并安装(约 30 秒，需联网)...",
            file=sys.stderr,
        )
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run(
            [
                str(py),
                "-m",
                "pip",
                "install",
                "-q",
                "--disable-pip-version-check",
                "drissionpage",
            ],
            check=True,
        )
    return str(py)




def get_browser(port):
    from DrissionPage import Chromium, ChromiumOptions  # type: ignore[reportMissingImports]

    co = ChromiumOptions().set_local_port(port)
    co.set_load_mode("eager")
    ud = os.environ.get("DP_USER_DATA", "")
    if ud:
        Path(ud).mkdir(parents=True, exist_ok=True)
        co.set_user_data_path(ud)

    headless = os.environ.get("DP_HEADLESS", "1").strip().lower() not in ("0", "false", "no", "off")
    if headless:
        co.headless(True)

    return Chromium(co)


def need_tab(browser):
    tabs = browser.get_tabs()
    if not tabs:
        fail("没有打开的标签页 — 先运行: open <url> 或 new <url>")
    return browser.latest_tab



LOC_PREFIXES = ("css:", "xpath:", "x:", "text:", "t:", "tag:", "@")
_CSSISH = re.compile(r"^[a-z][a-z0-9-]*$")


def resolve_loc(s):
    """把输入转成 DrissionPage 定位串:
    带前缀的(css:/xpath:/text:/@ 等)原样透传;
    裸 #id/.class/[attr]/标签名 当 css; 其余当 text 包含匹配。
    """
    s = s.strip()
    if s.startswith(LOC_PREFIXES):
        return s
    if s[0] in "#.[:" or _CSSISH.match(s):
        return "css:" + s
    return "text:" + s


def find_ele(tab, loc, timeout=8):
    return tab.ele(resolve_loc(loc), timeout=timeout)



SNAPSHOT_JS = r"""
const SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,' +
  '[contenteditable=""],[contenteditable="true"],summary,details,' +
  '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],' +
  '[role="menuitem"],[role="switch"],[role="searchbox"],[role="combobox"],[role="slider"]';
function isVis(el) {
  if (el.getClientRects().length === 0) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
  if (parseFloat(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
function textOf(el, n) { return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, n) || null; }
try {
  const interactive = [];
  document.querySelectorAll(SEL).forEach(el => {
    if (!isVis(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS') return;
    let value = null, checked = null;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      value = el.value;
      if (value !== undefined) {
        if (el.type === 'password') value = '\u2022'.repeat(Math.min(12, String(value).length));
        else value = String(value).slice(0, 60);
      }
      checked = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null;
    }
    let label = null;
    if (el.labels && el.labels.length) label = textOf(el.labels[0], 80);
    interactive.push({
      i: interactive.length + 1,
      tag: tag,
      text: textOf(el, 200),
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      id: el.getAttribute('id'),
      href: el.hasAttribute('href') ? el.href : null,
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      value: value, checked: checked,
      disabled: el.disabled ? true : null,
      label: label
    });
  });

  const textSel = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd,figcaption';
  const headings = [], paragraphs = [];
  document.querySelectorAll(textSel).forEach(el => {
    if (!isVis(el)) return;
    if (el.closest(SEL)) return;
    if (el.querySelector(textSel)) return;
    const t = textOf(el, 160);
    if (!t) return;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) headings.push({level: +tag[1], text: t});
    else paragraphs.push({tag: tag, text: t});
  });

  const images = [];
  document.querySelectorAll('img').forEach(el => {
    if (!isVis(el)) return;
    const r = el.getBoundingClientRect();
    images.push({src: el.currentSrc || el.src || null,
                 alt: (el.alt || '').slice(0, 120) || null,
                 w: Math.round(r.width), h: Math.round(r.height)});
  });

  const iframes = [];
  document.querySelectorAll('iframe').forEach(el => {
    if (!isVis(el)) return;
    iframes.push({src: el.src || null, title: el.getAttribute('title')});
  });

  const page = {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || null,
    viewportW: innerWidth, viewportH: innerHeight,
    scrollY: Math.round(scrollY || 0),
    documentHeight: Math.max(document.body ? document.body.scrollHeight : 0,
                             document.documentElement.scrollHeight)
  };
  return JSON.stringify({page: page, interactive: interactive,
                         headings: headings, paragraphs: paragraphs,
                         images: images, iframes: iframes,
                         icap: interactive.length,
                         truncated: {
                           interactive: interactive.length >= 400,
                           headings: headings.length >= 60,
                           paragraphs: paragraphs.length >= 300,
                           images: images.length >= 100,
                           iframes: iframes.length >= 20
                         }});
} catch (e) {
  return JSON.stringify({error: String(e)});
}
"""

INDEX_JS = r"""
const SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,' +
  '[contenteditable=""],[contenteditable="true"],summary,details,' +
  '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],' +
  '[role="menuitem"],[role="switch"],[role="searchbox"],[role="combobox"],[role="slider"]';
function isVis(el) {
  if (el.getClientRects().length === 0) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
  if (parseFloat(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
const els = [];
document.querySelectorAll(SEL).forEach(el => {
  if (!isVis(el)) return;
  if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') return;
  els.push(el);
});
const N = arguments[0];
return els[N] || null;
"""

TAG_NAMES = {
    "a": "链接",
    "button": "按钮",
    "input": "输入框",
    "select": "下拉",
    "textarea": "文本域",
    "summary": "折叠",
    "details": "折叠框",
}


def snapshot_data(tab):
    last_err = None
    for attempt in range(4):
        try:
            try:
                tab.wait.doc_loaded(timeout=2)
            except Exception:
                pass
            raw = tab.run_js(SNAPSHOT_JS)
            data = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(data, dict):
                if "error" in data:
                    fail(f"页面 JS 异常: {data['error']}")
                return data
        except Exception as e:
            last_err = e
            time.sleep(0.4)
    fail(f"快照执行失败: {last_err}")


def snapshot_payload(tab, interactive_only):
    data = snapshot_data(tab)
    inter = data["interactive"]
    counts = Counter()
    for e in inter:
        key = TAG_NAMES.get(e["tag"])
        if key is None:
            key = f"role:{e['role']}" if e.get("role") else e["tag"]
        counts[key] += 1
    summary = " · ".join(f"{k} {v}" for k, v in counts.most_common())
    payload = {
        "ok": True,
        "cmd": CMD,
        "interactive_only": interactive_only,
        "page": data["page"],
        "count": len(inter),
        "summary": summary or "(无交互元素)",
        "elements": inter,
        "hint": "点击: click N(快照序号) 或 click 'text:文本' / click 'css:...'; 输入: input <定位> <文本>",
        "truncated": data["truncated"],
    }
    if not interactive_only:
        payload["headings"] = data["headings"]
        payload["paragraphs"] = data["paragraphs"]
        payload["images"] = data["images"]
        payload["iframes"] = data["iframes"]
    return payload




def _norm_url(url):
    """补全 scheme: 已有 scheme 的保留(data:/file:/about:/https: 等),
    host:port 补 http://,其余补 https://。"""
    if re.match(r"^[a-z][a-z0-9+.\-]*:", url, re.I):
        return url
    if re.match(r"^[a-zA-Z0-9.\-]+:\d+", url):
        return "http://" + url
    return "https://" + url


def cmd_open(browser, args):
    if not args:
        fail("open 需要网址参数: open <url>")
    url = _norm_url(args[0])
    tabs = browser.get_tabs()
    tab = browser.latest_tab if tabs else None
    if tab is None:
        tab = browser.new_tab()
    ensure_console_hook(tab)
    tab.get(url)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_new(browser, args):
    if not args:
        fail("new 需要网址参数: new <url>")
    url = _norm_url(args[0])
    tab = browser.new_tab()
    ensure_console_hook(tab)
    tab.get(url)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "tab_id": tab.tab_id,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_tabs(browser, args):
    tabs = browser.get_tabs()
    latest = browser.latest_tab if tabs else None
    lst = [
        {
            "i": n,
            "id": t.tab_id,
            "title": t.title or "",
            "url": t.url or "",
            "current": (latest is not None and t.tab_id == latest.tab_id),
        }
        for n, t in enumerate(tabs, 1)
    ]
    out({"ok": True, "cmd": CMD, "count": len(lst), "tabs": lst})


def cmd_switch(browser, args):
    if not args:
        fail("switch 需要一个参数: <序号|id|网址/标题片段>")
    target = args[0]
    tabs = browser.get_tabs()
    if not tabs:
        fail("没有打开的标签页")
    if target.isdigit():
        n = int(target)
        if not 1 <= n <= len(tabs):
            fail(f"标签页序号越界(当前共 {len(tabs)} 个)")
        tab = tabs[n - 1]
    else:
        tab = (
            next((t for t in tabs if t.tab_id == target), None)
            or next((t for t in tabs if target in (t.url or "")), None)
            or next((t for t in tabs if target in (t.title or "")), None)
        )
        if tab is None:
            fail(f"找不到标签页: {target}")
    browser.activate_tab(tab.tab_id)
    time.sleep(0.2)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_close(browser, args):
    tabs = browser.get_tabs()
    if not tabs:
        fail("没有打开的标签页")
    if args and args[0].isdigit():
        n = int(args[0])
        if not 1 <= n <= len(tabs):
            fail(f"标签页序号越界(当前共 {len(tabs)} 个)")
        tab = tabs[n - 1]
    else:
        tab = browser.latest_tab
    closed_url = tab.url
    before = len(browser.get_tabs())
    try:
        tab.close()
    except Exception:
        pass
    after = len(browser.get_tabs())
    if after >= before:
        fail("关闭标签页失败(标签页仍存在)")
    out({"ok": True, "cmd": CMD, "closed": closed_url, "tabs": after})


def cmd_url(browser, args):
    tab = need_tab(browser)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_back(browser, args):
    tab = need_tab(browser)
    tab.back()
    out({"ok": True, "cmd": CMD, "url": tab.url, "title": tab.title})


def cmd_forward(browser, args):
    tab = need_tab(browser)
    tab.forward()
    out({"ok": True, "cmd": CMD, "url": tab.url, "title": tab.title})


def cmd_refresh(browser, args):
    tab = need_tab(browser)
    ensure_console_hook(tab)
    tab.refresh()
    out({"ok": True, "cmd": CMD, "url": tab.url, "title": tab.title})


def cmd_wait(browser, args):
    sec = float(args[0]) if args else 1.0
    time.sleep(sec)
    out({"ok": True, "cmd": CMD, "slept": sec})


def cmd_snapshot(browser, args):
    tab = need_tab(browser)
    interactive_only = any(a in ("-i", "--interactive") for a in args)
    out(snapshot_payload(tab, interactive_only))


def cmd_click(browser, args):
    tab = need_tab(browser)
    by_js = False
    rest = [a for a in args if a != "--js"]
    if len(rest) != len(args):
        by_js = True
    if not rest:
        fail("click 需要一个参数: 定位串 / 文本 / 快照序号")
    target = rest[0]
    if target.isdigit():
        el = tab.run_js(INDEX_JS, int(target) - 1)
        if el is None:
            fail(f"交互元素 #{target} 不存在 — 先运行 snapshot -i 查看当前序号")
        desc = f"#{target}(按快照序号)"
    else:
        el = find_ele(tab, target)
        if el is None:
            fail(
                f"找不到元素: {target}",
                "先运行 snapshot -i 看可见元素; 定位支持 text:文本 / css:选择器 / xpath:... / 数字序号",
            )
        desc = target
    try:
        el.click(by_js=by_js)
    except Exception as e:
        fail(f"点击失败: {e}", f"可尝试 click --js {target} 强制用 JS 点击")
    try:
        tab.wait.doc_loaded(timeout=3)
    except Exception:
        pass
    out(
        {
            "ok": True,
            "cmd": CMD,
            "target": desc,
            "by_js": by_js,
            "url": tab.url,
            "title": tab.title,
        }
    )


def cmd_input(browser, args):
    tab = need_tab(browser)
    if len(args) < 2:
        fail("input 需要两个参数: <定位> <文本>")
    loc, text = args[0], args[1]
    el = find_ele(tab, loc)
    if el is None:
        fail(f"找不到元素: {loc}", "先 snapshot -i 确认定位")
    try:
        el.click()
    except Exception:
        pass
    el.input(text, clear=True)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "target": loc,
            "len": len(text),
            "url": tab.url,
            "title": tab.title,
        }
    )


def cmd_select(browser, args):
    tab = need_tab(browser)
    if len(args) < 2:
        fail("select 需要两个参数: <定位> <选项文本/值/序号>")
    loc, opt = args[0], args[1]
    el = find_ele(tab, loc)
    if el is None:
        fail(f"找不到元素: {loc}")
    sel = el.select
    if sel is False:
        fail(f"{loc} 不是 <select> 下拉元素")
    errs = []
    for fn, kw in (
        (sel.by_text, dict(text=opt)),
        (sel.by_value, dict(value=opt)),
    ):
        try:
            fn(**kw)
            out({"ok": True, "cmd": CMD, "target": loc, "option": opt})
            return
        except Exception as e:
            errs.append(str(e))
    if opt.isdigit():
        try:
            sel.by_index(int(opt))
            out({"ok": True, "cmd": CMD, "target": loc, "option": f"#{opt}"})
            return
        except Exception as e:
            errs.append(str(e))
    fail(f'下拉没有匹配选项: {opt} ({"; ".join(errs[:2])})')


def cmd_check(browser, args):
    tab = need_tab(browser)
    if not args:
        fail(f"{CMD} 需要一个定位参数")
    loc = args[0]
    el = find_ele(tab, loc)
    if el is None:
        fail(f"找不到元素: {loc}")
    if el.tag != "input" and el.attr("role") not in (
        "checkbox",
        "radio",
        "switch",
    ):
        fail(f"{loc} 不是复选框/单选钮")
    el.check(uncheck=(CMD == "uncheck"))
    out({"ok": True, "cmd": CMD, "target": loc})


def cmd_type(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("type 需要一个文本参数(向当前焦点元素输入)")
    tab.actions.type(args[0])
    out({"ok": True, "cmd": CMD, "len": len(args[0])})


MODIFIERS = {"CONTROL", "CTRL", "SHIFT", "ALT", "META", "COMMAND"}
ALIAS = {
    "ARROWDOWN": "DOWN",
    "ARROWUP": "UP",
    "ARROWLEFT": "LEFT",
    "ARROWRIGHT": "RIGHT",
    "ESC": "ESCAPE",
    "RETURN": "ENTER",
    "PAGEUP": "PAGE_UP",
    "PAGEDOWN": "PAGE_DOWN",
    "DEL": "DELETE",
    "INS": "INSERT",
    "SPACEBAR": "SPACE",
}
KEYS_HELP = (
    "ENTER ESCAPE TAB BACKSPACE DELETE SPACE UP DOWN LEFT RIGHT HOME END "
    "PAGE_UP PAGE_DOWN F1-F12 SHIFT CONTROL ALT 或组合如 ctrl+a"
)


def cmd_press(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("press 需要一个按键/组合，如 Enter、ctrl+a、Escape")
    combo = args[0]
    parts = [
        ALIAS.get(p.upper(), p.upper()) for p in combo.split("+") if p.strip()
    ]
    mods = [p for p in parts if p in MODIFIERS]
    rest = [p for p in parts if p not in MODIFIERS]
    a = tab.actions
    try:
        for m in mods:
            a.key_down(m)
        for r in rest:
            if len(r) == 1:
                a.type(r)
            else:
                a.key_down(r)
                a.key_up(r)
        for m in reversed(mods):
            a.key_up(m)
    except ValueError as e:
        fail(f"{e}  支持的按键: {KEYS_HELP}")
    try:
        tab.wait.doc_loaded(timeout=3)
    except Exception:
        pass
    out(
        {
            "ok": True,
            "cmd": CMD,
            "keys": combo,
            "url": tab.url,
            "title": tab.title,
        }
    )


def cmd_hover(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("hover 需要一个定位参数")
    el = find_ele(tab, args[0])
    if el is None:
        fail(f"找不到元素: {args[0]}")
    el.hover()
    out({"ok": True, "cmd": CMD, "target": args[0]})


def cmd_scroll(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("scroll 用法: top | bottom | up [px] | down [px] | to <y> | <px>")
    w = args[0].lower()
    y = None
    try:
        if w == "top":
            tab.scroll.to_top()
            y = tab.run_js("return Math.round(scrollY);")
        elif w == "bottom":
            tab.scroll.to_bottom()
            y = tab.run_js("return Math.round(scrollY);")
        elif w in ("up", "down"):
            n = int(args[1]) if len(args) > 1 else 600
            y = tab.run_js(
                f'window.scrollBy(0, {"-" if w == "up" else ""}{n}); return Math.round(scrollY);'
            )
        elif w == "to":
            y = tab.run_js(
                f"window.scrollTo(0, {int(args[1])}); return Math.round(scrollY);"
            )
        elif w.isdigit():
            y = tab.run_js(
                f"window.scrollBy(0, {int(w)}); return Math.round(scrollY);"
            )
        else:
            fail(f"未知滚动参数: {w}")
    except Exception as e:
        fail(f"滚动失败: {e}")
    out({"ok": True, "cmd": CMD, "action": w, "scrollY": int(y) if y else 0})


def cmd_wait_ele(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("wait_ele 需要定位参数")
    loc = args[0]
    timeout = float(args[1]) if len(args) > 1 else 10
    el = tab.ele(resolve_loc(loc), timeout=timeout)
    out(
        {
            "ok": el is not None,
            "cmd": CMD,
            "found": el is not None,
            "target": loc,
        },
        code=0 if el is not None else 1,
    )


def _sanitize(r, depth=0):
    if r is None or isinstance(r, (str, int, float, bool)):
        return r
    if depth > 3:
        return str(r)[:200]
    if isinstance(r, dict):
        return {k: _sanitize(v, depth + 1) for k, v in list(r.items())[:100]}
    if isinstance(r, (list, tuple)):
        return [_sanitize(x, depth + 1) for x in r[:100]]
    if hasattr(r, "tag"):
        return {"element": True, "tag": r.tag, "text": (r.text or "")[:200]}
    return str(r)[:500]


def cmd_js(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("js 需要一段 JS 代码(函数体形式, 可用 return; 多行请加引号)")
    code = args[0]
    try:
        r = tab.run_js(code, as_expr=(CMD == "jsx"))
    except Exception as e:
        fail(f"JS 执行失败: {e}")
    out({"ok": True, "cmd": CMD, "result": _sanitize(r)})



CONSOLE_HOOK_JS = r"""
(function() {
  if (window.__pi_console_installed) return;
  window.__pi_console_installed = true;
  window.__pi_console_logs = window.__pi_console_logs || [];
  const MAX_LOGS = 300;
  const MAX_STR_LEN = 2000;

  function safeSerialize(arg) {
    if (arg === undefined) return 'undefined';
    if (arg === null) return 'null';
    if (arg instanceof Error) return arg.stack || (arg.name + ': ' + arg.message);
    if (typeof arg === 'function') return '[Function: ' + (arg.name || 'anonymous') + ']';
    if (typeof arg === 'symbol') return arg.toString();
    if (typeof arg === 'object') {
      if (arg.nodeType && typeof arg.nodeName === 'string') {
        const id = arg.id ? '#' + arg.id : '';
        const cls = arg.className ? '.' + String(arg.className).trim().split(/\s+/).join('.') : '';
        return '<' + arg.nodeName.toLowerCase() + id + cls + '>';
      }
      try {
        const seen = new WeakSet();
        const json = JSON.stringify(arg, (key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          if (value instanceof Error) {
            return { name: value.name, message: value.message, stack: value.stack };
          }
          return value;
        });
        return json.length > MAX_STR_LEN ? json.slice(0, MAX_STR_LEN) + '... (truncated)' : json;
      } catch (e) {
        return Object.prototype.toString.call(arg);
      }
    }
    const str = String(arg);
    return str.length > MAX_STR_LEN ? str.slice(0, MAX_STR_LEN) + '... (truncated)' : str;
  }

  function pushLog(level, text, source) {
    const d = new Date();
    const timeStr = [
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
      String(d.getSeconds()).padStart(2, '0')
    ].join(':');
    window.__pi_console_logs.push({
      level: level,
      text: text,
      time: timeStr,
      source: source || null
    });
    if (window.__pi_console_logs.length > MAX_LOGS) {
      window.__pi_console_logs.shift();
    }
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
    const orig = console[level];
    console[level] = function(...args) {
      try {
        const text = args.map(safeSerialize).join(' ');
        pushLog(level, text);
      } catch (_) {}
      if (typeof orig === 'function') {
        return orig.apply(console, args);
      }
    };
  });

  window.addEventListener('error', function(e) {
    try {
      if (e.error) {
        pushLog('error', 'Uncaught ' + safeSerialize(e.error), e.filename ? (e.filename + ':' + e.lineno + ':' + e.colno) : null);
      } else if (e.target && (e.target.src || e.target.href)) {
        const src = e.target.src || e.target.href;
        const tag = (e.target.tagName || 'ELEMENT').toLowerCase();
        pushLog('error', 'Resource load failed: <' + tag + '> ' + src);
      } else {
        pushLog('error', 'Uncaught error: ' + (e.message || String(e)), e.filename ? (e.filename + ':' + e.lineno + ':' + e.colno) : null);
      }
    } catch (_) {}
  }, true);

  window.addEventListener('unhandledrejection', function(e) {
    try {
      pushLog('error', 'Unhandled Promise Rejection: ' + safeSerialize(e.reason));
    } catch (_) {}
  });
})();
"""

GET_CONSOLE_LOGS_JS = r"""
const args = arguments;
const level = (args[0] || 'all').toLowerCase();
const filter = (args[1] || '').toLowerCase();
const limit = Math.max(1, Math.min(300, parseInt(args[2], 10) || 100));
const clear = !!args[3];

const allLogs = window.__pi_console_logs || [];
let filtered = allLogs;
if (level && level !== 'all') {
  filtered = filtered.filter(item => (item.level || '').toLowerCase() === level);
}
if (filter) {
  filtered = filtered.filter(item => (item.text || '').toLowerCase().includes(filter));
}

const result = filtered.slice(-limit);

if (clear) {
  if (level === 'all' && !filter) {
    window.__pi_console_logs = [];
  } else {
    const matchSet = new Set(result);
    window.__pi_console_logs = allLogs.filter(item => !matchSet.has(item));
  }
}

return JSON.stringify({
  total: allLogs.length,
  matched: filtered.length,
  returned: result.length,
  logs: result
});
"""


def ensure_console_hook(tab):
    if tab is None:
        return
    try:
        tab.add_init_js(CONSOLE_HOOK_JS)
    except Exception:
        pass
    try:
        tab.run_js(CONSOLE_HOOK_JS)
    except Exception:
        pass


def cmd_console(browser, args):
    tab = need_tab(browser)
    ensure_console_hook(tab)

    level = "all"
    clear = False
    limit = 100
    filter_query = ""

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--level" and i + 1 < len(args):
            level = args[i + 1].strip().lower()
            i += 2
        elif a == "--clear":
            clear = True
            i += 1
        elif a == "--limit" and i + 1 < len(args):
            try:
                limit = int(args[i + 1])
            except ValueError:
                pass
            i += 2
        elif (a == "--filter" or a == "--query") and i + 1 < len(args):
            filter_query = args[i + 1].strip()
            i += 2
        else:
            if a.lower() in ("all", "error", "warn", "info", "log", "debug"):
                level = a.lower()
            elif a == "clear":
                clear = True
            else:
                filter_query = a
            i += 1

    try:
        raw = tab.run_js(GET_CONSOLE_LOGS_JS, level, filter_query, limit, clear)
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception as e:
        fail(f"读取控制台日志失败: {e}")

    out(
        {
            "ok": True,
            "cmd": CMD,
            "url": tab.url,
            "title": tab.title,
            "level": level,
            "filter": filter_query or None,
            "total": data.get("total", 0),
            "matched": data.get("matched", 0),
            "cleared": clear,
            "logs": data.get("logs", []),
        }
    )


SEARCH_EXTRACT_JS = r"""
const rawEngine = (arguments[0] || 'bing').toLowerCase();
const limit = Math.max(1, Math.min(20, parseInt(arguments[1], 10) || 8));
const officialOnly = !!arguments[2];
const rawQuery = (arguments[3] || '').toLowerCase();
const queryClean = rawQuery.replace(/官网|官方|网站|中文网|社区|下载|最新|版|教程|site|docs|official/g, '').trim();
const queryWords = queryClean.split(/[\s+\-_:]+/).filter(w => w.length >= 2);

function clean(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function textOf(el, maxLen) {
  if (!el) return null;
  const t = clean(el.innerText || el.textContent || '');
  if (!t) return null;
  return maxLen ? t.slice(0, maxLen) : t;
}

try {
  // 1. 全局验证码 / 反爬 / 安全检测拦截识别
  // 关键：拦截必须与「真的没有结果」区分开，否则用户只会看到「未找到有效自然搜索结果」，根因被掩盖。
  const pageText = (document.body ? document.body.innerText : '') || '';
  const pageTitle = document.title || '';
  const pageUrl = location.href || '';
  const bodyText = pageTitle + ' ' + pageText;

  // 1.1 网络不可达 / 导航失败的空白页（无标题、几乎无正文）
  if (!pageTitle.trim() && pageText.trim().length < 40) {
    return JSON.stringify({
      blocked: true,
      kind: 'network',
      engine: rawEngine,
      error: '页面空白（网络不可达或导航失败，可能是境外引擎被墙或缺少代理）'
    });
  }

  // 1.1b Chrome 错误页（ERR_CONNECTION_TIMED_OUT / 无法访问此网站 等）
  const errMatch = (bodyText.match(/ERR_[A-Z_]+|net::ERR_[A-Z_]+/) || [])[0];
  if (
    errMatch ||
    /无法访问此网站|网页无法打开|此网站无法提供安全连接|This site can'?t be reached|This page isn'?t working/i.test(bodyText) ||
    document.querySelector('#main-frame-error, .error-page-container, #error-information-button, .neterror')
  ) {
    return JSON.stringify({
      blocked: true,
      kind: 'network',
      engine: rawEngine,
      error: '浏览器网络错误' + (errMatch ? '（' + errMatch + '）' : '') + '：域名不可达，境内环境需给浏览器配置代理'
    });
  }

  // 1.2 各引擎的验证码 / 反爬页面（URL 特征优先，避免正文里提到「验证码」造成误判）
  const urlSignals = [
    [/wappass\.baidu\.com|\/static\/captcha/i, '百度安全验证'],
    [/antispider/i, '搜狗反爬拦截'],
    [/qcaptcha\.so\.com|captcha\.so\.com/i, '360 访问异常验证'],
    [/google\.[a-z.]+\/sorry|\/consent\./i, 'Google 人机验证'],
    [/\/captcha|\/challenge|\/verify/i, '人机验证页面'],
  ];
  for (const [re, label] of urlSignals) {
    if (re.test(pageUrl)) {
      return JSON.stringify({ blocked: true, kind: 'blocked', engine: rawEngine, error: label + '（页面被重定向到验证页 ' + pageUrl.slice(0, 120) + '）' });
    }
  }

  const textSignals = [
    [/百度安全验证|网络不给力，请稍后重试|系统检测到异常访问/, '百度安全验证'],
    [/搜狗验证码|验证码拦截|请输入验证码/, '搜狗人机验证'],
    [/360安全验证|访问异常页面|访问过于频繁/, '360 访问异常验证'],
    [/Please show you're not a robot|verify you are human|unusual traffic|Access Denied|Security Challenge|Too Many Requests/i, '反爬拦截'],
  ];
  for (const [re, label] of textSignals) {
    if (re.test(bodyText)) {
      return JSON.stringify({ blocked: true, kind: 'blocked', engine: rawEngine, error: label });
    }
  }
  if (document.querySelector('form#captcha-form, #recaptcha, div.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="captcha"]')) {
    return JSON.stringify({ blocked: true, kind: 'blocked', engine: rawEngine, error: '页面出现验证码控件' });
  }

  // 1.3 引擎自述「没有结果」——这是真的没结果，不是被拦
  const emptySignals = /没有找到|未找到|找不到和|没有与此相关的结果|No results found|did not match any documents|找不到该搜索/i;
  const declaredEmpty = emptySignals.test(pageText);

  let instantAnswer = null;
  const items = [];
  const seenUrls = new Set();
  const relatedQueries = [];

  function isAdCard(el) {
    if (!el) return false;
    const txt = (el.innerText || '');
    if (/^(广告|商业推广|推广|赞助商|Sponsored|Ad)$/im.test(txt)) return true;
    if (el.closest('.b_ad, .ad_sc, [id*="b_ad"], .ec_wise_ad, .ec_ad_results, [data-is-ad], .sponsor, .biz_rb, .e-prom, .res-ad, #taw, #bottomads, [data-text-ad], .uEierd, [data-ad], .ad-container, [id*="google_ads"]')) return true;
    return false;
  }

  // 权威站点域名与官方认证徽章检测
  const AUTH_HOSTS = [
    'github.com', 'gitlab.com', 'gitee.com', 'apache.org', 'cncf.io',
    'developer.mozilla.org', 'w3.org', 'wikipedia.org', 'readthedocs.io',
    'npmjs.com', 'pypi.org', 'crates.io', 'pkg.go.dev', 'golang.org',
    'python.org', 'nodejs.org', 'rust-lang.org', 'react.dev', 'vuejs.org',
    'deepseek.com', 'openai.com', 'microsoft.com', 'google.com', 'docker.com'
  ];

  function isOfficialBadge(card, href, title, site) {
    let hostname = '';
    try {
      if (href) hostname = new URL(href).hostname.toLowerCase();
    } catch (e) {}

    const citeText = ((site || '') + ' ' + (card ? (card.querySelector('cite, .res-linkinfo, .c-showurl, .citeurl') || {}).innerText || '' : '')).toLowerCase();

    // 1. 知名公共权威平台与组织
    const checkAuthHost = (h) => {
      if (!h) return false;
      const lower = h.toLowerCase().trim();
      if (AUTH_HOSTS.some(d => lower === d || lower.endsWith('.' + d) || lower.includes('/' + d) || lower.includes('www.' + d))) return true;
      if (/\.(edu|gov|org)(\.[a-z]{2})?(\/|$)/i.test(lower)) return true;
      return false;
    };
    if (checkAuthHost(hostname) || checkAuthHost(citeText)) return true;

    // 2. 搜索词实体与主域名强匹配 (Entity-Domain Match，例如搜 "Docker"，匹配 "docker.com" 或 "www.docker.com")
    for (const word of queryWords) {
      if (word.length >= 3) {
        const regex = new RegExp('^(www\\.)?' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.[a-z]{2,}(\\.[a-z]{2})?$', 'i');
        if (regex.test(hostname)) return true;
        if (citeText.includes(word + '.com') || citeText.includes(word + '.io') || citeText.includes(word + '.org') || citeText.includes(word + '.cn') || citeText.includes(word + '.dev') || citeText.includes(word + '.net')) {
          // 排除常见第三方博客/软件站/镜像
          const isMirror = /(p2hp|csdn|zhihu|cnblogs|runoob|softbox|baoku|360软件宝库|mydocker)/i.test(hostname + ' ' + citeText);
          if (!isMirror) return true;
        }
      }
    }

    // 3. 页面角标与文字
    if (card) {
      const cardText = card.innerText || '';
      if (/^官网$|官方认证|官方网站|Official Site/m.test(cardText)) {
        const isMirror = /(p2hp|csdn|zhihu|cnblogs|runoob|softbox|baoku|360软件宝库|mydocker)/i.test(hostname + ' ' + citeText);
        if (!isMirror) return true;
      }
      if (card.querySelector('.c-icon-v, .c-icon-auth, .icon-official, .mohe-official, .vr-official, [class*="official"], [data-is-official]')) {
        return true;
      }
    }
    if (title && (/^https?:\/\/(www\.)?[a-z0-9-]+\.[a-z]+/i.test(title.trim()) || /官方网站|官方文档|Official Site/i.test(title))) {
      return true;
    }
    return false;
  }

  // 提取日期 / 相对时间辅助函数
  function extractDate(card, snippetText) {
    if (!card && !snippetText) return null;
    const txt = (card ? (card.innerText || '') : '') + ' ' + (snippetText || '');
    // 匹配常规日期格式：2024年3月15日, 2024-03-15, 2024.03.15, 2024/03/15
    const dMatch = txt.match(/\b(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)\b/);
    if (dMatch) {
      return dMatch[1].replace(/[年月]/g, '-').replace(/日/g, '').replace(/\./g, '-').replace(/\//g, '-');
    }
    // 匹配相对时间：xx小时前 / xx天前 / xx周前 / xx月前 / xx ago
    const relMatch = txt.match(/\b(\d+\s*(?:小时|分钟|天|周|个月|年)前|昨天|前天)\b/) ||
      txt.match(/\b(\d+\s+(?:hours?|mins?|days?|weeks?|months?|years?)\s+ago)\b/i);
    if (relMatch) {
      return relMatch[1];
    }
    // 专用时间选择器
    if (card) {
      const timeEl = card.querySelector('time, .news_dt, .c-color-gray2, span.LEwnzc, .cite_date, span[class*="date"]');
      if (timeEl) {
        const t = clean(timeEl.innerText || timeEl.getAttribute('datetime') || '');
        if (t && t.length <= 25 && !/http|www/i.test(t)) {
          return t;
        }
      }
    }
    return null;
  }

  // 还原与清洗追踪跳转 URL
  function cleanUrl(href, card) {
    if (!href) return '';
    try {
      // 1. Google 跳转解码
      if (href.includes('google.com/url?') || href.includes('google.com.hk/url?')) {
        const u = new URL(href);
        const q = u.searchParams.get('url') || u.searchParams.get('q');
        if (q && q.startsWith('http')) return q;
      }
      // 2. DuckDuckGo 跳转解码
      if (href.includes('uddg=')) {
        const match = href.match(/uddg=([^&]+)/);
        if (match) return decodeURIComponent(match[1]);
      }
      // 3. Bing 检查
      if (href.includes('bing.com/ck/a?') && card) {
        const citeEl = card.querySelector('cite, .b_attribution');
        const citeText = clean(citeEl ? citeEl.innerText : '');
        if (citeText && /^https?:\/\//i.test(citeText)) {
          return citeText.split(' ')[0];
        }
      }
      // 4. Baidu 真实落地页探测
      if (card && (href.includes('baidu.com/link?') || href.includes('baidu.com/s?'))) {
        const mu = card.getAttribute('mu') || (card.querySelector('a[data-landurl]') || {}).getAttribute?.('data-landurl');
        if (mu && mu.startsWith('http')) return mu;
        const tools = card.getAttribute('data-tools');
        if (tools && tools.includes('url')) {
          try {
            const p = JSON.parse(tools);
            if (p && p.url && p.url.startsWith('http')) return p.url;
          } catch (e) {}
        }
        const showUrlEl = card.querySelector('.c-showurl');
        const showUrl = clean(showUrlEl ? showUrlEl.innerText : '');
        if (showUrl && !showUrl.includes('...') && /^https?:\/\//i.test(showUrl)) {
          return showUrl;
        }
      }
      // 5. Sogou / 360 检查 data-url
      if (card) {
        const dataUrl = card.getAttribute('data-url') || (card.querySelector('h3 a, a[href]') || {}).getAttribute?.('data-url');
        if (dataUrl && dataUrl.startsWith('http')) return dataUrl;
      }
    } catch (e) {}
    return href;
  }

  // 2. 针对各大主流引擎的专属结构化提取
  if (rawEngine === 'bing') {
    const ansEl = document.querySelector('#b_ans, .b_ans, .b_top, .rwrl, .b_rich');
    if (ansEl) instantAnswer = textOf(ansEl, 400);

    const cards = document.querySelectorAll('#b_results > li.b_algo');
    for (const card of cards) {
      if (isAdCard(card)) continue;
      const linkEl = card.querySelector('h2 a') || card.querySelector('a[href^="http"]');
      if (!linkEl) continue;
      let rawHref = linkEl.href;
      if (!rawHref || rawHref.startsWith('javascript:')) continue;
      const href = cleanUrl(rawHref, card);
      if (!href || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const title = textOf(linkEl, 150) || textOf(card.querySelector('h2'), 150);
      const snippetEl = card.querySelector('.b_caption p, .b_snippet, .b_lineclamp2, .b_algoSlug, .b_paractl');
      const snippet = textOf(snippetEl, 300);
      const sourceEl = card.querySelector('cite, .b_attribution, .news_dt');
      const site = textOf(sourceEl, 80);
      const isOfficial = isOfficialBadge(card, href, title, site);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: site || null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  } else if (rawEngine === 'baidu') {
    const ansEl = document.querySelector('.op_exacturl_main, .op-soft-title, .c-result-content, .c-border');
    if (ansEl) instantAnswer = textOf(ansEl, 400);

    const cards = document.querySelectorAll('#content_left .result.c-container, #content_left .c-container');
    for (const card of cards) {
      if (isAdCard(card)) continue;
      const linkEl = card.querySelector('h3 a') || card.querySelector('a[href^="http"]');
      if (!linkEl) continue;

      let rawHref = linkEl.href;
      const href = cleanUrl(rawHref, card);
      if (!href || href.startsWith('javascript:') || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const title = textOf(linkEl, 150) || textOf(card.querySelector('h3'), 150);
      const snippetEl = card.querySelector('.c-abstract, .content-right_8Zs40, div[class*="content"]');
      const snippet = textOf(snippetEl, 300);
      const sourceEl = card.querySelector('.c-showurl, .c-color-gray2, .c-color-gray');
      const site = textOf(sourceEl, 80);
      const isOfficial = isOfficialBadge(card, href, title, site);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: site || null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  } else if (rawEngine === 'sogou') {
    const ansEl = document.querySelector('.vrwrap[data-vr-type], .vrResult');
    if (ansEl) instantAnswer = textOf(ansEl, 400);

    const cards = document.querySelectorAll('.results .vrwrap, .results .rb, .results .vrResult, #main .results > div');
    for (const card of cards) {
      if (isAdCard(card)) continue;
      const linkEl = card.querySelector('h3 a, .vr-title a, h3.pt a, a[href^="http"]');
      if (!linkEl) continue;

      let rawHref = linkEl.getAttribute('data-url') || linkEl.href;
      const href = cleanUrl(rawHref, card);
      if (!href || href.startsWith('javascript:') || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const title = textOf(linkEl, 150);
      const snippetEl = card.querySelector('.str_info, .ft, .fz-mid, .space-txt, p');
      const snippet = textOf(snippetEl, 300);
      const sourceEl = card.querySelector('cite, .citeurl, .cite_url');
      const site = textOf(sourceEl, 80);
      const isOfficial = isOfficialBadge(card, href, title, site);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: site || null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  } else if (rawEngine === 'so' || rawEngine === '360') {
    const ansEl = document.querySelector('.mohe-wrap, .res-comm_head, .res-rich');
    if (ansEl) instantAnswer = textOf(ansEl, 400);

    const cards = document.querySelectorAll('ul.result > li.res-list, .result li, #main .res-list');
    for (const card of cards) {
      if (isAdCard(card)) continue;
      const linkEl = card.querySelector('h3 a, a[href^="http"]');
      if (!linkEl) continue;

      let rawHref = linkEl.getAttribute('data-url') || linkEl.href;
      const href = cleanUrl(rawHref, card);
      if (!href || href.startsWith('javascript:') || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const title = textOf(linkEl, 150);
      const snippetEl = card.querySelector('p.res-desc, .res-rich, p');
      const snippet = textOf(snippetEl, 300);
      const sourceEl = card.querySelector('cite, .res-linkinfo');
      const site = textOf(sourceEl, 80);
      const isOfficial = isOfficialBadge(card, href, title, site);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: site || null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  } else if (rawEngine === 'duckduckgo') {
    const ansEl = document.querySelector('.zci__body, .zci');
    if (ansEl) instantAnswer = textOf(ansEl, 400);

    const cards = document.querySelectorAll('.result:not(.result--ad)');
    for (const card of cards) {
      const linkEl = card.querySelector('.result__title a, a.result__url');
      if (!linkEl) continue;
      let rawHref = linkEl.href;
      const href = cleanUrl(rawHref, card);
      if (!href || href.startsWith('javascript:') || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const title = textOf(linkEl, 150);
      const snippetEl = card.querySelector('.result__snippet');
      const snippet = textOf(snippetEl, 300);
      const isOfficial = isOfficialBadge(card, href, title, null);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  } else if (rawEngine === 'brave') {
    const ansEl = document.querySelector('.infobox, .answer');
    if (ansEl) instantAnswer = textOf(ansEl, 400);

    const cards = document.querySelectorAll('#results .snippet, .search-result');
    for (const card of cards) {
      if (isAdCard(card)) continue;
      const linkEl = card.querySelector('a.title, h3 a, a[href^="http"]');
      if (!linkEl) continue;
      const href = cleanUrl(linkEl.href, card);
      if (!href || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const title = textOf(linkEl, 150);
      const snippetEl = card.querySelector('.snippet-description, .content, p');
      const snippet = textOf(snippetEl, 300);
      const isOfficial = isOfficialBadge(card, href, title, null);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  } else if (rawEngine === 'yahoo') {
    const cards = document.querySelectorAll('#web .algo, #main .algo');
    for (const card of cards) {
      if (isAdCard(card)) continue;
      const linkEl = card.querySelector('h3 a, a[href^="http"]');
      if (!linkEl) continue;
      const href = cleanUrl(linkEl.href, card);
      if (!href || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const title = textOf(linkEl, 150);
      const snippetEl = card.querySelector('.compText, p');
      const snippet = textOf(snippetEl, 300);
      const isOfficial = isOfficialBadge(card, href, title, null);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  } else {
    // 默认 google 结构
    const ansEl = document.querySelector('div[data-attrid], .kp-blk, .hgKElc, .IZ6rdc');
    if (ansEl) instantAnswer = textOf(ansEl, 400);

    const cards = document.querySelectorAll('#search .g, div.g:not(.g-blk), #rso > div.MjjYud');
    for (const card of cards) {
      if (isAdCard(card)) continue;
      const linkEl = card.querySelector('a[href^="http"]:not([href*="google.com/search"])');
      if (!linkEl) continue;
      const href = cleanUrl(linkEl.href, card);
      if (!href || seenUrls.has(href)) continue;
      seenUrls.add(href);

      const titleEl = card.querySelector('h3') || linkEl;
      const title = textOf(titleEl, 150);
      const snippetEl = card.querySelector('div[data-sncf], .VwiC3b, .yXK7lf, .MUxGbd');
      const snippet = textOf(snippetEl, 300);
      const sourceEl = card.querySelector('cite, span.LEwnzc');
      const site = textOf(sourceEl, 80);
      const isOfficial = isOfficialBadge(card, href, title, site);
      const date = extractDate(card, snippet);

      items.push({ title: title || '无标题', url: href, snippet: snippet || '', site: site || null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  }

  // 3. 通用自适应启发式兜底抽取器（Universal Heuristic Fallback）
  if (items.length === 0) {
    const candidateHeadings = document.querySelectorAll('h2 a[href^="http"], h3 a[href^="http"], h4 a[href^="http"]');
    for (const linkEl of candidateHeadings) {
      if (linkEl.closest('nav, header, footer, aside, form, .nav, .menu')) continue;
      if (isAdCard(linkEl)) continue;
      const href = cleanUrl(linkEl.href, linkEl.parentElement);
      if (!href || seenUrls.has(href)) continue;

      const title = textOf(linkEl, 150);
      if (!title || title.length < 3) continue;

      let snippet = '';
      const parent = linkEl.closest('div, li, article, section') || linkEl.parentElement;
      if (parent) {
        if (isAdCard(parent)) continue;
        const pEl = parent.querySelector('p, div[class*="desc"], div[class*="content"], div[class*="snippet"]');
        snippet = textOf(pEl, 300);
      }

      seenUrls.add(href);
      const isOfficial = isOfficialBadge(parent, href, title, null);
      const date = extractDate(parent, snippet);
      items.push({ title: title, url: href, snippet: snippet || '', site: null, date: date || null, isOfficial: isOfficial });
      if (items.length >= limit) break;
    }
  }

  // 4. 相关搜索建议词采集
  try {
    const relEls = document.querySelectorAll('#b_rs a, #rs a, .hint_wrapper a, #botstuff a, .k8XOCe, #hint a, .related-searches a, ul.res-related a');
    for (const relEl of relEls) {
      const qText = clean(relEl.innerText || relEl.textContent || '');
      if (qText && qText.length >= 2 && qText.length <= 40 && qText.toLowerCase() !== rawQuery && !relatedQueries.includes(qText)) {
        // 过滤系统功能链接与噪音
        if (/反馈|投诉|举报|免责|帮助|纠错|声明|广告/i.test(qText)) continue;
        relatedQueries.push(qText);
        if (relatedQueries.length >= 6) break;
      }
    }
  } catch (e) {}

  // 5. 官网与权威站点加权置顶与过滤
  let finalResults = items;
  if (officialOnly) {
    const only = items.filter(it => it.isOfficial);
    if (only.length > 0) finalResults = only;
  }
  // 置顶官方认证条目
  finalResults.sort((a, b) => (b.isOfficial ? 1 : 0) - (a.isOfficial ? 1 : 0));

  if (finalResults.length === 0 && !declaredEmpty) {
    // 没有任何结果、也没有解析到拦截特征：多半是版式变化或 JS 未就绪，如实报告而不是谎称「搜不到」
    return JSON.stringify({
      ok: true,
      engine: rawEngine,
      empty: true,
      parse_miss: true,
      instantAnswer: instantAnswer,
      count: 0,
      related_queries: relatedQueries,
      results: []
    });
  }

  return JSON.stringify({
    ok: true,
    engine: rawEngine,
    empty: finalResults.length === 0,
    declared_empty: finalResults.length === 0 && declaredEmpty,
    instantAnswer: instantAnswer,
    count: finalResults.length,
    related_queries: relatedQueries,
    results: finalResults
  });
} catch (e) {
  return JSON.stringify({ error: String(e) });
}
"""


def _build_search_url(query: str, engine: str, time_range: str = "all", page: int = 1) -> str:
    import urllib.parse
    q = urllib.parse.quote_plus(query.strip())
    eng = engine.lower()
    tr = (time_range or "all").lower().strip()
    p = max(1, int(page or 1))

    if eng in ("bing", "auto"):
        url = f"https://www.bing.com/search?q={q}"
        if tr == "day":
            url += '&filters=ex1:"ez1"'
        elif tr == "week":
            url += '&filters=ex1:"ez2"'
        elif tr == "month":
            url += '&filters=ex1:"ez3"'
        elif tr == "year":
            url += '&filters=ex1:"ez4"'
        if p > 1:
            url += f"&first={(p - 1) * 10 + 1}"
        return url
    elif eng == "baidu":
        url = f"https://www.baidu.com/s?wd={q}&ie=utf-8"
        if tr in ("day", "week", "month", "year"):
            tr_code = {"day": "1", "week": "2", "month": "3", "year": "4"}.get(tr, "1")
            url += f"&gpc=stf%3D{tr_code}%26ft%3D{tr_code}"
        if p > 1:
            url += f"&pn={(p - 1) * 10}"
        return url
    elif eng == "sogou":
        url = f"https://www.sogou.com/web?query={q}"
        if tr in ("day", "week", "month", "year"):
            t_num = {"day": "1", "week": "2", "month": "3", "year": "4"}.get(tr, "1")
            url += f"&time={t_num}"
        if p > 1:
            url += f"&page={p}"
        return url
    elif eng in ("360", "so"):
        url = f"https://www.so.com/s?q={q}"
        if tr in ("day", "week", "month", "year"):
            t_key = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(tr, "d")
            url += f"&adv_t={t_key}"
        if p > 1:
            url += f"&pn={p}"
        return url
    elif eng == "duckduckgo":
        url = f"https://html.duckduckgo.com/html/?q={q}"
        if tr in ("day", "week", "month", "year"):
            df = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(tr, "d")
            url += f"&df={df}"
        if p > 1:
            url += f"&s={(p - 1) * 30}"
        return url
    elif eng == "brave":
        url = f"https://search.brave.com/search?q={q}"
        if p > 1:
            url += f"&offset={p - 1}"
        return url
    elif eng == "yahoo":
        url = f"https://search.yahoo.com/search?p={q}"
        if p > 1:
            url += f"&b={(p - 1) * 10 + 1}"
        return url
    elif eng == "google":
        url = f"https://www.google.com/search?q={q}&hl=zh-CN"
        if tr in ("day", "week", "month", "year"):
            qdr = {"day": "d", "week": "w", "month": "m", "year": "y"}.get(tr, "d")
            url += f"&tbs=qdr:{qdr}"
        if p > 1:
            url += f"&start={(p - 1) * 10}"
        return url
    else:
        url = f"https://www.bing.com/search?q={q}"
        if p > 1:
            url += f"&first={(p - 1) * 10 + 1}"
        return url


def _execute_search_on_tab(
    tab,
    query: str,
    engine: str,
    limit: int,
    official_only: bool = False,
    time_range: str = "all",
    page: int = 1,
    fast_search: bool = True,
):
    url = _build_search_url(query, engine, time_range=time_range, page=page)
    try:
        tab.get(url, timeout=6.0)
    except Exception as nav_err:
        return {
            "ok": False,
            "kind": "network",
            "blocked": True,
            "engine": engine,
            "error": f"导航加载超时（{_safe_host(url)}）：{nav_err}",
        }

    try:
        tab.wait.doc_loaded(timeout=3.0)
    except Exception:
        pass

    wait_sel = {
        "bing": "#b_results",
        "baidu": "#content_left",
        "sogou": ".results, #main",
        "360": "ul.result, #main",
        "so": "ul.result, #main",
        "duckduckgo": ".results, .result",
        "brave": "#results",
        "yahoo": "#web, #main",
        "google": "#search, #rso",
    }.get(engine, "#b_results")

    try:
        tab.ele(wait_sel, timeout=3.5)
    except Exception:
        pass

    raw = None
    for attempt in range(2):
        try:
            raw = tab.run_js(SEARCH_EXTRACT_JS, engine, limit, official_only, query)
            break
        except Exception as js_err:
            err_str = str(js_err)
            if attempt == 0 and ("页面被刷新" in err_str or "destroyed" in err_str or "reload" in err_str.lower() or "context" in err_str.lower()):
                time.sleep(0.6)
                try:
                    tab.wait.doc_loaded(timeout=3.0)
                except Exception:
                    pass
                continue
            raise js_err

    data = json.loads(raw) if isinstance(raw, str) else raw
    return data


def _apply_domain_diversity(items: list, max_per_domain: int = 2) -> list:
    """域名多样性过滤：除官网/权威认证条目外，单一主域名最多保留 max_per_domain 条结果。"""
    if not items:
        return items

    import urllib.parse

    domain_counts = {}
    filtered = []

    for it in items:
        if it.get("isOfficial"):
            filtered.append(it)
            continue

        raw_url = it.get("url", "")
        host = ""
        try:
            host = urllib.parse.urlparse(raw_url).hostname or ""
            parts = host.split(".")
            if len(parts) >= 2:
                host = ".".join(parts[-2:])
        except Exception:
            pass

        if not host:
            filtered.append(it)
            continue

        c = domain_counts.get(host, 0)
        if c < max_per_domain:
            domain_counts[host] = c + 1
            filtered.append(it)

    return filtered



SEARCH_WORKER_NAME = "__dp_search_worker__"

ENGINE_HOSTS = {
    "bing": "www.bing.com",
    "baidu": "www.baidu.com",
    "sogou": "www.sogou.com",
    "so": "www.so.com",
    "google": "www.google.com",
    "duckduckgo": "html.duckduckgo.com",
    "brave": "search.brave.com",
    "yahoo": "search.yahoo.com",
}


def _safe_host(url: str) -> str:
    try:
        from urllib.parse import urlparse

        return urlparse(url).hostname or url[:60]
    except Exception:
        return url[:60]


def _env_float(name: str, default: float) -> float:
    try:
        v = float(os.environ.get(name, "").strip())
        return v if v >= 0 else default
    except Exception:
        return default


def _search_state_dir() -> Path:
    """搜索状态目录（互斥锁 + 引擎健康缓存），跟随 DP_USER_DATA 落在插件数据目录下。"""
    ud = os.environ.get("DP_USER_DATA", "").strip()
    base = (Path(ud).parent if ud else Path(tempfile.gettempdir())) / "search-state"
    try:
        base.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return base


def _health_path() -> Path:
    return _search_state_dir() / "engine-health.json"


def _load_health() -> dict:
    try:
        data = json.loads(_health_path().read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_health(data: dict) -> None:
    try:
        _health_path().write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    except Exception:
        pass


def _tcp_reachable(host: str, timeout: float = 2.5) -> bool:
    import socket

    try:
        with socket.create_connection((host, 443), timeout=timeout):
            return True
    except Exception:
        return False


def _engine_reachable(health: dict, engine: str, ttl: float):
    """TCP 探测引擎可达性（带缓存）。返回 (reachable, note)。"""
    host = ENGINE_HOSTS.get(engine)
    if not host:
        return True, ""
    entry = health.get(host) or {}
    now = time.time()
    if isinstance(entry.get("tcp"), bool) and now - float(entry.get("at") or 0) < ttl:
        return bool(entry["tcp"]), "探测结果缓存"
    ok = _tcp_reachable(host)
    health[host] = {"tcp": ok, "at": now}
    _save_health(health)
    return ok, "TCP 连接超时（无代理或网络被阻）"


def _mark_engine_unreachable(health: dict, engine: str) -> None:
    host = ENGINE_HOSTS.get(engine)
    if host:
        health[host] = {"tcp": False, "at": time.time()}
        _save_health(health)


def _mark_engine_reachable(health: dict, engine: str) -> None:
    host = ENGINE_HOSTS.get(engine)
    if host and (health.get(host) or {}).get("tcp") is not True:
        health[host] = {"tcp": True, "at": time.time()}
        _save_health(health)


def _engine_blocked_reason(health: dict, engine: str, ttl: float) -> str:
    entry = health.get(f"blocked:{engine}") or {}
    if entry and time.time() - float(entry.get("at") or 0) < ttl:
        return str(entry.get("reason") or "反爬拦截")
    return ""


def _mark_engine_blocked(health: dict, engine: str, reason: str) -> None:
    health[f"blocked:{engine}"] = {"at": time.time(), "reason": reason}
    _save_health(health)


def _clear_engine_blocked(health: dict, engine: str) -> None:
    if health.pop(f"blocked:{engine}", None) is not None:
        _save_health(health)


@contextlib.contextmanager
def _search_lock():
    """跟进程互斥：并发搜索共用同一个 worker 标签页会互相踩，结果串味/误报无结果。
    用 O_CREAT|O_EXCL 文件锁串行化；超时（默认 90s）后放弃加锁，宁可并发也不卡死。
    """
    path = _search_state_dir() / "search.lock"
    timeout = _env_float("DP_SEARCH_LOCK_TIMEOUT", 90.0)
    stale = _env_float("DP_SEARCH_LOCK_STALE", 120.0)
    deadline = time.time() + timeout
    fd = None
    while True:
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode("ascii", "ignore"))
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > stale:
                    path.unlink()
                    continue
            except Exception:
                pass
            if time.time() >= deadline:
                break
            time.sleep(0.2)
        except Exception:
            break
    try:
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass
            try:
                path.unlink()
            except Exception:
                pass


def cmd_search(browser, args):
    with _search_lock():
        _search_locked(browser, args)


def _search_locked(browser, args):
    if not args:
        fail(
            "search 需要关键词: search <query> [--engine <auto|bing|sogou|so|baidu|google|duckduckgo|brave|yahoo>] "
            "[--time-range <all|day|week|month|year>] [--page <N>] [--fetch-top] [--limit <N>] [--official-only] [--no-fallback]"
        )

    query = ""
    engine = os.environ.get("DP_DEFAULT_ENGINE", "auto").strip().lower() or "auto"
    limit = 8
    page = 1
    fallback = True
    official_only = False
    time_range = "all"
    fetch_top = False
    fast_search = os.environ.get("DP_FAST_SEARCH", "1").strip().lower() not in ("0", "false", "no", "off")
    tab_isolation = os.environ.get("DP_SEARCH_ISOLATION", "1").strip().lower() not in ("0", "false", "no", "off")

    i = 0
    query_parts = []
    while i < len(args):
        a = args[i]
        if a == "--engine" and i + 1 < len(args):
            engine = args[i + 1].lower()
            i += 2
        elif a in ("--time-range", "-t", "--timerange") and i + 1 < len(args):
            time_range = args[i + 1].lower()
            i += 2
        elif a in ("--page", "-p") and i + 1 < len(args):
            try:
                page = max(1, min(20, int(args[i + 1])))
            except ValueError:
                page = 1
            i += 2
        elif a in ("--fetch-top", "--fetch-top-content", "--read-top"):
            fetch_top = True
            i += 1
        elif a == "--limit" and i + 1 < len(args):
            try:
                limit = int(args[i + 1])
            except ValueError:
                limit = 8
            i += 2
        elif a in ("--official-only", "--official"):
            official_only = True
            i += 1
        elif a in ("--no-fallback", "--no-fall"):
            fallback = False
            i += 1
        else:
            query_parts.append(a)
            i += 1

    query = " ".join(query_parts).strip()
    if not query:
        fail("搜索关键词不能为空")

    tabs = browser.get_tabs()
    original_tab = browser.latest_tab if tabs else None

    search_tab = None
    if tab_isolation and tabs:
        orphans = []
        for t in tabs:
            try:
                if t.run_js("return window.name") == SEARCH_WORKER_NAME:
                    if search_tab is None:
                        search_tab = t
                    else:
                        orphans.append(t)
            except Exception:
                pass
        for t in orphans:
            try:
                t.close()
            except Exception:
                pass

        if search_tab is None:
            search_tab = browser.new_tab()
            try:
                search_tab.run_js(
                    "window.name = '" + SEARCH_WORKER_NAME + "'; document.title = 'Search Worker';"
                )
            except Exception:
                pass
    else:
        search_tab = browser.latest_tab if tabs else browser.new_tab()

    primary_engine = "bing" if engine == "auto" else engine
    candidate_engines = [primary_engine]
    if fallback:
        all_fallbacks = ["sogou", "so", "bing", "baidu", "duckduckgo", "brave", "google", "yahoo"]
        for fb in all_fallbacks:
            if fb not in candidate_engines:
                candidate_engines.append(fb)

    health = _load_health()
    health_ttl = _env_float("DP_ENGINE_HEALTH_TTL", 600.0)
    block_ttl = _env_float("DP_ENGINE_BLOCK_TTL", 900.0)

    fallback_from = None
    attempts = []

    try:
        for eng in candidate_engines:
            is_primary = eng == primary_engine

            reachable, net_note = _engine_reachable(health, eng, health_ttl)
            if not reachable and not is_primary:
                attempts.append(
                    {
                        "engine": eng,
                        "kind": "network",
                        "reason": f"{ENGINE_HOSTS.get(eng, eng)} 不可达（{net_note}）",
                    }
                )
                if not fallback_from and eng != candidate_engines[-1]:
                    fallback_from = eng
                continue

            recent_block = _engine_blocked_reason(health, eng, block_ttl)
            if recent_block and not is_primary:
                attempts.append(
                    {"engine": eng, "kind": "blocked", "reason": f"{recent_block}（近期已拦截，跳过）"}
                )
                if not fallback_from and eng != candidate_engines[-1]:
                    fallback_from = eng
                continue

            try:
                res = _execute_search_on_tab(
                    search_tab,
                    query,
                    eng,
                    limit,
                    official_only=official_only,
                    time_range=time_range,
                    page=page,
                    fast_search=fast_search,
                )
            except Exception as e:
                attempts.append({"engine": eng, "kind": "error", "reason": f"{type(e).__name__}: {e}"})
                if not fallback_from and eng != candidate_engines[-1]:
                    fallback_from = eng
                continue

            if not isinstance(res, dict):
                attempts.append({"engine": eng, "kind": "error", "reason": "搜索结果解析失败"})
                continue

            if res.get("blocked") or res.get("error"):
                reason = res.get("error") or "页面被拦截或验证码"
                kind = res.get("kind") or "blocked"
                attempts.append({"engine": eng, "kind": kind, "reason": str(reason)})
                if kind == "network":
                    _mark_engine_unreachable(health, eng)
                else:
                    _mark_engine_blocked(health, eng, str(reason))
                if not fallback_from and eng != candidate_engines[-1]:
                    fallback_from = eng
                continue

            _mark_engine_reachable(health, eng)
            results = res.get("results") or []
            if not results:
                empty_note = "该引擎确实没有结果" if res.get("declared_empty") else "版式变化，未解析到结果"
                attempts.append({"engine": eng, "kind": "empty", "reason": empty_note})
                if not fallback_from and eng != candidate_engines[-1]:
                    fallback_from = eng
                continue

            _clear_engine_blocked(health, eng)

            results = _apply_domain_diversity(results, max_per_domain=2)
            results = results[:limit]

            top_content = None
            if fetch_top and results:
                first_url = results[0].get("url")
                if first_url and first_url.startswith("http"):
                    content_tab = None
                    try:
                        content_tab = browser.new_tab(first_url)
                        try:
                            content_tab.wait.doc_loaded(timeout=4.0)
                            content_tab.wait.ele_loaded("article, main, body", timeout=3.0)
                        except Exception:
                            pass
                        raw_top = content_tab.run_js(ARTICLE_EXTRACT_JS, 2000)
                        top_data = json.loads(raw_top) if isinstance(raw_top, str) else raw_top
                        if top_data and top_data.get("ok"):
                            top_content = {
                                "title": top_data.get("title") or results[0].get("title"),
                                "url": first_url,
                                "content": top_data.get("content", ""),
                            }
                    except Exception:
                        pass
                    finally:
                        if content_tab is not None:
                            try:
                                content_tab.close()
                            except Exception:
                                pass

            out(
                {
                    "ok": True,
                    "cmd": CMD,
                    "query": query,
                    "engine": eng,
                    "fallback_from": fallback_from,
                    "time_range": time_range if time_range != "all" else None,
                    "page": page,
                    "count": len(results),
                    "instant_answer": res.get("instantAnswer"),
                    "related_queries": res.get("related_queries") or [],
                    "top_content": top_content,
                    "results": results,
                    "attempts": attempts,
                }
            )
            return

        out(
            {
                "ok": True,
                "cmd": CMD,
                "query": query,
                "engine": None,
                "fallback_from": None,
                "time_range": time_range if time_range != "all" else None,
                "page": page,
                "count": 0,
                "instant_answer": None,
                "related_queries": [],
                "top_content": None,
                "results": [],
                "attempts": attempts,
            }
        )
    finally:
        if tab_isolation and original_tab is not None and original_tab != search_tab:
            try:
                browser.activate_tab(original_tab)
            except Exception:
                pass


ARTICLE_EXTRACT_JS = r"""
const maxChars = Math.max(500, Math.min(30000, parseInt(arguments[0], 10) || 5000));

function clean(str) {
  return (str || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

try {
  // 1. 查找最可能的正文容器 (Readability 启发式选择器)
  const candidateSelectors = [
    'article',
    'main',
    '[role="main"]',
    '.markdown-body',
    '.post-content',
    '.article-content',
    '#article_content',
    '.entry-content',
    '.blog-content',
    '.content',
    '#content'
  ];

  let root = null;
  for (const sel of candidateSelectors) {
    const el = document.querySelector(sel);
    if (el && (el.innerText || '').length > 200) {
      root = el;
      break;
    }
  }
  if (!root) {
    root = document.body || document.documentElement;
  }

  // 2. 克隆节点以避免破坏当前网页的原有渲染
  const clone = root.cloneNode(true);

  // 3. 剥离脚本、样式、导航、侧栏、页脚与广告营销噪音元素
  const removeSelectors = [
    'script', 'style', 'noscript', 'iframe', 'svg',
    'header', 'footer', 'nav', 'aside',
    '.ad', '.ads', '.advertisement', '.sidebar',
    '.comment', '.comments', '#comments',
    '.share', '.social', '.related',
    '[aria-hidden="true"]',
    '.modal', '.popup', '[class*="cookie"]', '[class*="paywall"]',
    '[class*="reward"]', '[class*="donate"]', '[class*="qrcode"]',
    '.author-card', '.feedback-btn', '[class*="subscribe"]'
  ];
  removeSelectors.forEach(sel => {
    clone.querySelectorAll(sel).forEach(el => el.remove());
  });

  // 辅助：提取代码块语言标签
  function detectCodeLang(node) {
    const cls = ((node.className || '') + ' ' + ((node.parentElement && node.parentElement.className) || '')).toLowerCase();
    const m = cls.match(/(?:language|lang)-([a-z0-9_+-]+)/i) || cls.match(/\b(javascript|typescript|python|bash|sh|json|html|css|sql|rust|go|java|c|cpp|csharp|php|ruby|yaml|yml|dockerfile|toml)\b/i);
    if (m) return m[1];
    const dataLang = node.getAttribute('data-lang') || (node.parentElement && node.parentElement.getAttribute('data-lang'));
    if (dataLang) return dataLang.toLowerCase().trim();
    return '';
  }

  // 辅助：将 HTML <table> 转换为 Markdown 表格格式
  function tableToMarkdown(tableNode) {
    const rows = Array.from(tableNode.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const tableData = [];
    let maxCols = 0;

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td')).map(c => clean(c.innerText || c.textContent || '').replace(/\|/g, '\\|'));
      if (cells.length > 0) {
        tableData.push(cells);
        if (cells.length > maxCols) maxCols = cells.length;
      }
    }
    if (tableData.length === 0 || maxCols === 0) return '';

    const lines = [];
    // 表头行
    const header = tableData[0];
    while (header.length < maxCols) header.push('');
    lines.push('| ' + header.join(' | ') + ' |');
    // 分隔行
    lines.push('| ' + Array(maxCols).fill('---').join(' | ') + ' |');
    // 数据行
    for (let r = 1; r < tableData.length; r++) {
      const row = tableData[r];
      while (row.length < maxCols) row.push('');
      lines.push('| ' + row.join(' | ') + ' |');
    }
    return '\n\n' + lines.join('\n') + '\n\n';
  }

  // 4. 遍历提纯正文与关键代码块、表格
  const pieces = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = node.nodeValue.trim();
      if (t) pieces.push(t);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();
    if (tag === 'table') {
      const mdTable = tableToMarkdown(node);
      if (mdTable) {
        pieces.push(mdTable);
        return; // 不再递归深入 table 内部子节点
      }
    }
    if (tag === 'pre' || (tag === 'code' && (!node.parentElement || node.parentElement.tagName.toLowerCase() !== 'pre'))) {
      const lang = detectCodeLang(node);
      const codeText = node.innerText || node.textContent || '';
      pieces.push('\n\n```' + lang + '\n' + codeText.trim() + '\n```\n');
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      pieces.push('\n\n' + '#'.repeat(+tag[1]) + ' ' + (node.innerText || '').trim() + '\n');
      return;
    }
    if (tag === 'p' || tag === 'li' || tag === 'blockquote') {
      const txt = (node.innerText || '').trim();
      if (txt) {
        if (tag === 'li') pieces.push('\n- ' + txt);
        else if (tag === 'blockquote') pieces.push('\n> ' + txt + '\n');
        else pieces.push('\n\n' + txt + '\n');
      }
      return;
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };

  walk(clone);

  let fullText = clean(pieces.join(' '));
  const totalChars = fullText.length;
  const isTruncated = totalChars > maxChars;
  if (isTruncated) {
    fullText = fullText.slice(0, maxChars) + `\n\n[...正文已截断，总字数约 ${totalChars} 字...]`;
  }

  return JSON.stringify({
    ok: true,
    title: document.title,
    url: location.href,
    totalChars: totalChars,
    truncated: isTruncated,
    content: fullText
  });
} catch (e) {
  return JSON.stringify({ error: String(e) });
}
"""


def cmd_read_page(browser, args):
    """提取网页纯净正文（阅读器模式），自动剔除 HTML/CSS/JS、侧边栏和广告，保留标题段落和代码块。"""
    max_chars = 5000
    target_url = None

    for a in args:
        if a.startswith("http://") or a.startswith("https://"):
            target_url = a
        elif a.isdigit():
            max_chars = int(a)

    tab = None
    if target_url:
        tabs = browser.get_tabs()
        tab = browser.latest_tab if tabs else None
        if tab is None:
            tab = browser.new_tab()
        tab.get(target_url)
    else:
        tab = need_tab(browser)

    try:
        tab.wait.doc_loaded(timeout=4)
    except Exception:
        pass

    raw = tab.run_js(ARTICLE_EXTRACT_JS, max_chars)
    data = json.loads(raw) if isinstance(raw, str) else raw

    if not isinstance(data, dict) or data.get("error"):
        fail(f"网页正文提取失败: {data.get('error') if isinstance(data, dict) else raw}")

    out(
        {
            "ok": True,
            "cmd": CMD,
            "title": data.get("title") or tab.title,
            "url": data.get("url") or tab.url,
            "total_chars": data.get("totalChars", 0),
            "truncated": data.get("truncated", False),
            "content": data.get("content", ""),
        }
    )


def cmd_screenshot(browser, args):
    tab = need_tab(browser)
    path = None
    full = False
    for a in args:
        if a == "--full":
            full = True
        else:
            path = a
    if not path:
        path = str(Path.cwd() / f"browser_use_{int(time.time() * 1000)}.png")
    p = tab.get_screenshot(path=path, full_page=full)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "path": os.path.abspath(p) if p else os.path.abspath(path),
            "full_page": full,
        }
    )


def cmd_quit(browser, args):
    browser.quit(2, True)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "note": "常驻浏览器已关闭，下次调用 open/new 会自动启动新实例",
        }
    )


COMMANDS = {
    "open": cmd_open,
    "new": cmd_new,
    "search": cmd_search,
    "read_page": cmd_read_page,
    "article": cmd_read_page,
    "tabs": cmd_tabs,
    "switch": cmd_switch,
    "close": cmd_close,
    "url": cmd_url,
    "title": cmd_url,
    "back": cmd_back,
    "forward": cmd_forward,
    "refresh": cmd_refresh,
    "wait": cmd_wait,
    "snapshot": cmd_snapshot,
    "click": cmd_click,
    "input": cmd_input,
    "select": cmd_select,
    "check": cmd_check,
    "uncheck": cmd_check,
    "type": cmd_type,
    "press": cmd_press,
    "hover": cmd_hover,
    "scroll": cmd_scroll,
    "wait_ele": cmd_wait_ele,
    "js": cmd_js,
    "jsx": cmd_js,
    "console": cmd_console,
    "screenshot": cmd_screenshot,
    "quit": cmd_quit,
}

HELP = """browser-use — 常驻 Chrome 浏览器控制后端
用法: python dp_browser.py <命令> [参数]   (输出 JSON; 失败 exit code 1)

搜索 / 检索 / 正文阅读
  search <query> [--engine <bing|google|baidu|duckduckgo>] [--limit <N>] [--no-fallback]
                        通过真实浏览器进行网页搜索，直接提取干净结构化自然结果并过滤广告
  read_page [url] [max_chars]
                        阅读器模式提取网页纯正文与核心代码块，过滤所有噪音与广告(极省 Token)

导航 / 标签页
  open <url>            当前标签页打开网址(无标签页则新建; 自动补 https://)
  new <url>             新标签页打开
  tabs                  列出所有标签页(序号/标题/网址)
  switch <序号|id|片段>  切换标签页
  close [序号]          关闭标签页(默认当前)
  url | title           当前标签页网址和标题
  back | forward | refresh   后退 / 前进 / 刷新
  wait <秒>             等待

快照(只含人类可见元素, 不含 CSS/JS 内部实现)
  snapshot              页面可见内容: 交互元素 + 标题/正文/列表/图片/iframe
  snapshot -i           仅交互元素: 链接/按钮/输入框/下拉/复选框等(带数字序号)

交互
  click <定位|序号>     点击; 数字为 snapshot -i 的序号; --js 强制 JS 点击
  input <定位> <文本>   输入(先清空)
  select <定位> <选项>  下拉选择(按文本/值, 数字按序号)
  check <定位> | uncheck <定位>    勾选 / 取消勾选
  type <文本>           向当前焦点元素输入文本
  press <键|组合>       按键, 如 Enter / Escape / ctrl+a / shift+Tab
  hover <定位>          悬停
  scroll top|bottom|up|down [px]|to <y>|<px>    滚动页面
  wait_ele <定位> [秒]  等待元素出现(默认 10 秒)

JS / 其它
  js <代码>             执行 JS(函数体形式, 可用 return)
  jsx <表达式>          执行 JS 表达式
  console [--level <all|error|warn|info|log>] [--clear] [--limit <N>] [--filter <关键词>]
                        查看浏览器控制台日志(自动捕获 log/warn/error 与未捕获异常)
  screenshot [路径] [--full]    截图(PNG)
  quit                  关闭常驻浏览器(结束会话)
  help                  本帮助
"""


def parse_args(argv):
    port = int(os.environ.get("DP_BROWSER_PORT", "9333"))
    rest = list(argv)
    if rest and rest[0] == "--port" and len(rest) > 1:
        port = int(rest[1])
        rest = rest[2:]
    if not rest:
        out({"ok": False, "error": "未提供命令，运行: python dp_browser.py help"})
    return rest[0], rest[1:], port


def main():
    global CMD
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in (
        "utf-8",
        "utf8",
    ):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass

    if not os.environ.get("DP_BROWSER_REEXEC"):
        py = _ensure_python()
        if py:
            os.environ["DP_BROWSER_REEXEC"] = "1"
            sys.exit(
                subprocess.call(
                    [py, str(Path(__file__).resolve()), *sys.argv[1:]]
                )
            )

    cmd, args, port = parse_args(sys.argv[1:])
    CMD = cmd
    if cmd == "help":
        print(HELP)
        sys.exit(0)
    if cmd not in COMMANDS:
        out(
            {
                "ok": False,
                "cmd": cmd,
                "error": f"未知命令: {cmd}",
                "hint": "运行 python dp_browser.py help 查看全部可用命令",
            }
        )

    try:
        browser = get_browser(port)
        COMMANDS[cmd](browser, args)
    except SystemExit:
        raise
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
