// MVP UI：书架 / 搜索 / 书源 / 阅读。四块，对应 Android 四个核心链路。
import type { BookSource, Chapter, SearchBook } from './types'
import { discoverBooks, getBookInfo, getChapterList, getContent, searchBooks } from './core/webBook'
import { fetchText } from './core/request'
import { ruleErrors } from './core/analyzeRule'
import { checkSource, type CheckMode, type CheckResult } from './core/check'
import { clearExploreKindsCache, getInfoMap, loadExploreBooks, parseExploreKinds, type ExploreKind } from './core/explore'
import { chapterNavState } from './core/chapnav'
import { evalJsRule, getScope } from './core/js'
import { hydrateFromBackend, prefsStore, remoteStoreChanged, shelfStore, sourceStore, checkStore, storageEvents, storageMode, type CheckRecord } from './store'
import {
  aiFixButton,
  checkFixContext,
  installAiFixHandler,
  newSourceFixContext,
  requestAiFix,
  setAiFixStatusReporter,
  sourceFixContext,
} from './core/aiFix'

;(window as unknown as { __ruleErrors: typeof ruleErrors }).__ruleErrors = ruleErrors

/** 规则不兼容提示（数量 + 去控制台看 [规则失败] 行） */
function ruleHint(): string {
  if (!ruleErrors.length) return ''
  const last = ruleErrors[ruleErrors.length - 1]!
  return `<div class="meta" style="margin-top:8px">另有 ${ruleErrors.length} 条规则不兼容被跳过（最新：${esc(last.rule.slice(0, 60))}）。按 F12 开控制台搜 [规则失败] 看详情，或把书源 JSON 发给开发者补兼容。</div>`
}

const $ = (s: string) => document.querySelector(s) as HTMLElement
const statusEl = $('#status') as HTMLElement

function setStatus(t: string) {
  statusEl.textContent = t
}

function showTab(name: string) {
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('on', (b as HTMLElement).dataset.tab === name)
  })
  ;['shelf', 'search', 'explore', 'sources', 'check', 'read'].forEach((t) => {
    const el = document.getElementById(`tab-${t}`)
    if (el) el.hidden = t !== name
  })
  // 切页时顺手看一眼数据目录有没有被外部改过（AI 修完源、切回来就该看到新结果）
  void autoReloadIfStoreChanged()
}

document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => showTab((b as HTMLElement).dataset.tab!))
})

// ---------- 书源 ----------
/** 书源列表的搜索词 / 「只看置顶」——模块级，重渲染不丢 */
let srcSearch = ''
let srcOnlyPinned = false
let srcSearchTimer: number | null = null

function renderSources() {
  const el = $('#tab-sources')
  const all = sourceStore.all()
  const hitAll = all.length
  const hideDead = (document.getElementById('src-hide-dead') as HTMLInputElement | null)?.checked ?? true
  const hideSuspect = (document.getElementById('src-hide-suspect') as HTMLInputElement | null)?.checked ?? false
  const pinnedSet = prefsStore.pinnedSet()
  const q = srcSearch.trim().toLowerCase()
  const list = all.filter((s) => {
    const rec = checkStore.get(s.bookSourceUrl)
    if (hideDead && rec?.kind === 'dead') return false
    if (hideSuspect && rec?.kind === 'suspect') return false
    if (srcOnlyPinned && !pinnedSet.has(s.bookSourceUrl)) return false
    if (!q) return true
    return `${s.bookSourceName ?? ''} ${s.bookSourceUrl ?? ''} ${s.bookSourceGroup ?? ''}`.toLowerCase().includes(q)
  })
  // 置顶的源排最前（其余保持文件里的顺序：稳定排序）
  if (pinnedSet.size) {
    const rank = (s: BookSource) => (pinnedSet.has(s.bookSourceUrl) ? 0 : 1)
    list.sort((a, b) => rank(a) - rank(b))
  }
  // 统计只算“还在的源”（删过的源即便有残留记录也不算，否则顶栏数字不动）
  let dead = 0
  let ok = 0
  let suspect = 0
  for (const s of all) {
    const k = checkStore.get(s.bookSourceUrl)?.kind
    if (k === 'dead') dead++
    else if (k === 'ok') ok++
    else if (k === 'suspect') suspect++
  }
  const pinnedCount = pinnedSet.size
  const hidden = all.length - list.length
  el.innerHTML = `
    <div class="card">
      <h3>导入书源（仅文本源 bookSourceType=0，非 0 自动过滤）</h3>
      <div class="row">
        <input id="src-url" placeholder="书源 JSON 直链（走代理拉取）" style="flex:1;min-width:240px" />
        <button class="go" id="src-fetch">拉取</button>
      </div>
      <textarea id="src-json" rows="4" style="width:100%;margin-top:8px" placeholder='粘贴单个书源 JSON 或数组 […]'></textarea>
      <div class="row" style="margin-top:8px">
        <button class="go" id="src-add">导入粘贴板内容</button>
        <label class="meta"><input type="checkbox" id="src-autocheck" checked /> 导入后自动检测新源</label>
        <span style="font-size:12px;opacity:.7">兼容 Android 版书源格式，原样粘贴即可</span>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="src-ai-url" placeholder="网站地址（如 https://www.example.com）—— 让 AI 现场抓页写书源，只给链接就行" style="flex:1;min-width:280px" />
        <button class="ghost aifix" id="src-ai-new">🤖 AI 新建书源</button>
      </div>
      <div id="src-msg"></div>
    </div>
    <div class="card">
      <h3>书源（共 ${hitAll} · 可用 ${ok} · 废源 ${dead} · 可疑 ${suspect}${Math.max(0, hitAll - ok - dead - suspect) ? ` · 未检 ${Math.max(0, hitAll - ok - dead - suspect)}` : ''}${pinnedCount ? ` · ⭐ 置顶 ${pinnedCount}` : ''}${q ? ` · 匹配「${esc(srcSearch.trim())}」${list.length} 个` : ''}）</h3>
      <div class="row" style="margin-bottom:8px">
        <input id="src-search" value="${esc(srcSearch)}" placeholder="搜索书源：名称 / 地址 / 分组" style="flex:1;min-width:220px" />
        <button class="ghost" id="src-search-clear" title="清空搜索">清空</button>
        <label class="meta" title="只看已置顶（⭐）的源"><input type="checkbox" id="src-only-pinned" ${srcOnlyPinned ? 'checked' : ''} /> 只看置顶</label>
        ${pinnedCount ? `<button class="ghost" id="src-unpin-all" title="取消全部置顶">取消全部置顶（${pinnedCount}）</button>` : ''}
      </div>
      <div class="row" style="margin-bottom:8px">
        <label class="meta"><input type="checkbox" id="src-hide-dead" ${hideDead ? 'checked' : ''} /> 隐藏废源</label>
        <label class="meta"><input type="checkbox" id="src-hide-suspect" ${hideSuspect ? 'checked' : ''} /> 隐藏可疑</label>
        <button class="go" id="src-scan">快速检测废源</button>
        <button class="go" id="src-scan-full">完整检测废源</button>
        <button class="ghost" id="src-scan-un">只检未检测过的</button>
        <button class="ghost" id="src-del-dead">删除废源</button>
        <button class="ghost" id="src-refresh" title="从数据目录文件重读书源/书架/检测记录，再重渲染（AI 改过源、别处改过文件时点它）">刷新</button>
      </div>
      <div class="meta" id="src-scanmsg" style="margin-bottom:6px">快速=只测站点连通+搜索；完整=再跟到详情/目录/正文（慢）。“书读不了”也算废源。当前显示 ${list.length} 个。</div>
      ${hidden ? `<div class="meta" style="margin-bottom:6px">已隐藏 ${hidden} 个${dead && hideDead ? `（其中废源 ${dead}）` : ''}——取消上面的勾选可查看；单个源也可以直接点它那行的「标回可用」把它救回来。</div>` : ''}
      ${list.map((s) => {
        const rec = checkStore.get(s.bookSourceUrl)
        return `<div class="book${pinnedSet.has(s.bookSourceUrl) ? ' pinned' : ''}"><div style="flex:1"><b>${esc(s.bookSourceName)}</b> ${checkBadge(rec)}
        <div class="meta">${esc(s.bookSourceUrl)} · 分组 ${esc(s.bookSourceGroup ?? '-')}</div>
        ${rec && !rec.ok ? `<div class="meta err">${esc(rec.reason)}</div>` : ''}</div>
        <button class="ghost star" data-pin="${esc(s.bookSourceUrl)}" title="${pinnedSet.has(s.bookSourceUrl) ? '取消置顶' : '置顶（排到列表最前）'}">${pinnedSet.has(s.bookSourceUrl) ? '⭐' : '☆'}</button>
        ${!rec?.ok ? aiFixButton(sourceFixContext(s)) : ''}
        ${rec && !rec.ok ? `<button class="ghost" data-unmark="${esc(s.bookSourceUrl)}" title="清掉它的废源/可疑标记（回到未检），不再被隐藏和跳过">标回可用</button>` : ''}
        <button class="ghost" data-check="${esc(s.bookSourceUrl)}">检测</button>
        <button class="ghost" data-del="${esc(s.bookSourceUrl)}">删除</button></div>`
      }).join('') || '<p>暂无（可能被搜索词/置顶筛选挡掉了，或全部被隐藏：清空搜索、取消「只看置顶」与「隐藏废源」试试）。</p>'}
    </div>`
  const msg = $('#src-msg') as HTMLElement
  // 「AI 新建书源」：只给一个网站链接，搜索/详情/目录/正文规则都交给 AI 自己抓页分析
  const aiUrl = $('#src-ai-url') as HTMLInputElement | null
  const askAiNewSource = () => {
    const raw = (aiUrl?.value ?? '').trim()
    if (!raw) {
      setStatus('先填一个网站地址，例如 https://www.example.com')
      aiUrl?.focus()
      return
    }
    const url = /^https?:/i.test(raw) ? raw : `https://${raw}`
    if (aiUrl) aiUrl.value = url
    requestAiFix(newSourceFixContext(url))
  }
  $('#src-ai-new')?.addEventListener('click', askAiNewSource)
  aiUrl?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') askAiNewSource()
  })
  // 搜索：输入防抖重渲染（重建 innerHTML 会丢焦点，重渲染后把光标放回去）
  const searchEl = $('#src-search') as HTMLInputElement | null
  searchEl?.addEventListener('input', () => {
    const value = searchEl.value
    const caret = searchEl.selectionStart ?? value.length
    if (srcSearchTimer !== null) window.clearTimeout(srcSearchTimer)
    srcSearchTimer = window.setTimeout(() => {
      srcSearchTimer = null
      srcSearch = value
      renderSources()
      const again = document.getElementById('src-search') as HTMLInputElement | null
      again?.focus()
      try {
        again?.setSelectionRange(caret, caret)
      } catch {
        /* 类型不是 text 时忽略 */
      }
    }, 120)
  })
  searchEl?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      srcSearch = ''
      renderSources()
    }
  })
  $('#src-search-clear')?.addEventListener('click', () => {
    srcSearch = ''
    renderSources()
  })
  $('#src-only-pinned')?.addEventListener('change', (e) => {
    srcOnlyPinned = (e.target as HTMLInputElement).checked
    renderSources()
  })
  $('#src-unpin-all')?.addEventListener('click', () => {
    if (!confirm(`取消全部置顶（${prefsStore.count()} 个）？`)) return
    prefsStore.clearPins()
    setStatus('已取消全部置顶')
    renderSources()
  })
  el.querySelectorAll('[data-pin]').forEach((b) => {
    b.addEventListener('click', () => {
      const url = (b as HTMLElement).dataset.pin!
      const now = prefsStore.togglePin(url)
      const name = sourceStore.all().find((s) => s.bookSourceUrl === url)?.bookSourceName ?? url
      setStatus(now ? `已置顶「${name}」` : `已取消置顶「${name}」`)
      renderSources()
    })
  })
  $('#src-hide-dead')?.addEventListener('change', () => renderSources())
  $('#src-hide-suspect')?.addEventListener('change', () => renderSources())
  $('#src-refresh')?.addEventListener('click', () => void refreshFromStore('刷新书源'))
  el.querySelectorAll('[data-unmark]').forEach((b) => {
    b.addEventListener('click', () => {
      const url = (b as HTMLElement).dataset.unmark!
      const n = checkStore.removeBySource(url)
      const nm = sourceStore.all().find((s) => s.bookSourceUrl === url)?.bookSourceName ?? url
      setStatus(`已把「${nm}」标回未检（清了 ${n} 条记录），搜索/发现不再跳过它`)
      renderAllViews()
      renderExplore()
    })
  })
  $('#src-scan')?.addEventListener('click', () => void scanSources(false, 'search'))
  $('#src-scan-full')?.addEventListener('click', () => void scanSources(false, 'full'))
  $('#src-scan-un')?.addEventListener('click', () => void scanSources(true, 'search'))
  $('#src-del-dead')?.addEventListener('click', () => {
    const deadUrls = [...checkStore.deadUrls()]
    if (!deadUrls.length) {
      ;($('#src-scanmsg') as HTMLElement).textContent = '当前没有已判定的废源'
      return
    }
    if (
      !confirm(
        `确定删除 ${deadUrls.length} 个废源？（书架上这些源的书会一并移出；源需重新导入才能恢复）`,
      )
    )
      return
    let books = 0
    let removed = 0
    for (const u of deadUrls) {
      if (!sourceStore.all().some((s) => s.bookSourceUrl === u)) continue // 已经删过的跳过
      books += purgeSource(u)
      removed++
    }
    renderAllViews() // 自动刷新：书源/搜索/检测/书架全刷（否则顶栏计数与检测页看着像没刷新）
    renderExplore()
    setStatus(`已删除 ${removed} 个废源${books ? `，同时从书架移出 ${books} 本` : ''}`)
  })
  $('#src-add')?.addEventListener('click', () => {
    try {
      const raw = (document.getElementById('src-json') as HTMLTextAreaElement).value.trim()
      if (!raw) return
      const arr: BookSource[] = raw.trim().startsWith('[') ? JSON.parse(raw) : [JSON.parse(raw)]
      const before = sourceStore.all().length
      sourceStore.addMany(arr)
      msg.innerHTML = `<p class="ok">导入完成：${sourceStore.all().length - before} 个文本源</p>`
      const auto = (document.getElementById('src-autocheck') as HTMLInputElement | null)?.checked ?? true
      renderSources()
      renderSearch()
      if (auto) void scanSources(true, 'search')
    } catch (e) {
      msg.innerHTML = `<p class="err">解析失败：${esc(String(e))}</p>`
    }
  })
  $('#src-fetch')?.addEventListener('click', async () => {
    const u = (document.getElementById('src-url') as HTMLInputElement).value.trim()
    if (!u) return
    msg.innerHTML = '拉取中…'
    try {
      const r = await fetchText(u)
      const arr: BookSource[] = r.body.trim().startsWith('[') ? JSON.parse(r.body) : [JSON.parse(r.body)]
      sourceStore.addMany(arr)
      msg.innerHTML = `<p class="ok">拉取导入 ${arr.length} 个</p>`
      renderSources()
    } catch (e) {
      msg.innerHTML = `<p class="err">拉取失败：${esc(String(e))}</p>`
    }
  })
  el.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', () => {
      sourceStore.remove((b as HTMLElement).dataset.del!)
      renderSources()
    })
  })
  el.querySelectorAll('[data-check]').forEach((b) => {
    b.addEventListener('click', async () => {
      const url = (b as HTMLElement).dataset.check!
      const s = sourceStore.all().find((x) => x.bookSourceUrl === url)
      if (!s) return
      const btn = b as HTMLElement
      btn.textContent = '检测中…'
      const keyEl = document.getElementById('c-key') as HTMLInputElement | null
      const modeEl = document.getElementById('c-mode') as HTMLSelectElement | null
      const r = await checkSource(s, { key: keyEl?.value.trim() || '剑', mode: (modeEl?.value as CheckMode) || 'search' })
      checkStore.setMany({
        [r.bookSourceUrl]: { ok: r.ok, ts: r.time, ms: r.ms, count: r.count, tocCount: r.tocCount, reason: r.reason },
      })
      const i = checkResults.findIndex((x) => x.bookSourceUrl === r.bookSourceUrl)
      if (i >= 0) checkResults[i] = r
      else checkResults.push(r)
      paintCheck()
      renderSources()
    })
  })
}

// ---------- 搜索 ----------
let lastResults: SearchBook[] = []
/** 正在搜索（搜索中不自动重载页面数据：重渲染会把在飞的搜索结果列表打断） */
let searching = false

function renderSearch() {
  const el = $('#tab-search')
  const all = sourceStore.all().length
  const { dead, ok, suspect } = checkStore.counts()
  el.innerHTML = `
    <div class="card"><div class="row">
      <input id="q" placeholder="关键词" style="flex:1;min-width:200px" />
      <button class="go" id="do-search">全源搜索</button>
      <button class="ghost" id="do-discover">看发现（第一个源）</button>
      <button class="ghost" id="s-reload" title="AI/工具改过数据目录里的书源后重读文件（不然页面里跑的还是旧规则）">刷新数据</button>
      <label class="meta">搜索范围 <select id="s-scope">
        <option value="skip-dead" selected>跳过废源</option>
        <option value="only-ok">仅可用源</option>
        <option value="all">全部源</option>
      </select></label>
    </div>
    <div class="meta" style="margin-top:6px">共 ${all} 个源；已检测：可用 ${ok}、废源 ${dead}、可疑 ${suspect}。搜索默认跳过废源，可在「检测/书源」页调整。</div>
    <div id="s-msg"></div></div>
    <div class="card" id="s-list"><p style="opacity:.6">输入关键词后搜索。搜索会并发请求多个书源，慢源可能超时。</p></div>`
  $('#do-search')?.addEventListener('click', async () => {
    const key = (document.getElementById('q') as HTMLInputElement).value.trim()
    if (!key) return
    await runSearch(key)
  })
  $('#s-reload')?.addEventListener('click', () => void refreshFromStore('刷新数据'))
  $('#do-discover')?.addEventListener('click', async () => {
    const src = sourceStore.all()[0]
    if (!src) return
    const box = $('#s-msg')
    box.textContent = `正在加载发现：${src.bookSourceName}…`
    try {
      lastResults = await discoverBooks(src)
      box.innerHTML = `<span class="ok">发现 ${lastResults.length} 本</span>`
      paintResults()
    } catch (e) {
      box.innerHTML = `<span class="err">${esc(String(e))}</span>`
    }
  })
}

async function runSearch(key: string) {
  const all = sourceStore.all()
  const box = $('#s-msg')
  const list = $('#s-list')
  if (!all.length) {
    box.innerHTML = `<span class="err">先去「书源」导入至少一个文本源</span>`
    return
  }
  // 搜索范围：默认跳过废源；可选仅可用源 / 全部源
  const scopeMode = (document.getElementById('s-scope') as HTMLSelectElement | null)?.value ?? 'skip-dead'
  const recs = checkStore.all()
  const sources = all.filter((s) => {
    const kind = recs[s.bookSourceUrl]?.kind
    if (scopeMode === 'all') return true
    if (scopeMode === 'only-ok') return kind === 'ok'
    return kind !== 'dead'
  })
  const skipped = all.length - sources.length
  if (!sources.length) {
    box.innerHTML = `<span class="err">没有符合范围的可用源（共 ${all.length} 个）。改选“全部源”，或去「检测」重新检测</span>`
    return
  }
  box.textContent = `正在搜 ${sources.length} 个源…${skipped ? `（已跳过 ${skipped} 个废源）` : ''}`
  list.innerHTML = ''
  lastResults = []
  setStatus(`搜索中：${key}`)
  const queue = [...sources]
  searching = true
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const s = queue.shift()!
      try {
        const r = await searchBooks(s, key, 1)
        lastResults.push(...r.slice(0, 20))
        paintResults()
        box.textContent = `已回 ${lastResults.length} 本，还剩 ${queue.length} 个源…`
      } catch {
        /* 单源失败忽略 */
      }
    }
  })
  await Promise.all(workers)
  searching = false
  box.innerHTML = `<span class="ok">搜完，共 ${lastResults.length} 本</span>${skipped ? `<span class="meta"> · 已跳过 ${skipped} 个废源</span>` : ''}`
  setStatus('搜索完成')
}

function paintResults() {
  const list = $('#s-list')
  if (!list) return
  list.innerHTML =
    lastResults
      .map(
        (b, i) => `<div class="book">${b.coverUrl ? `<img src="${esc(b.coverUrl)}" loading="lazy" />` : ''}
      <div style="flex:1"><b>${esc(b.name || '(无名)')}</b> <span class="meta">${esc(b.author || '')} · ${esc(b.bookSourceName)}</span>
      <div class="meta">${esc(b.intro?.slice(0, 80) ?? '')}</div></div>
      <button class="ghost" data-open="${i}">详情</button></div>`,
      )
      .join('') || '<p>暂无结果</p>'
  list.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => openDetail(lastResults[Number((b as HTMLElement).dataset.open)]))
  })
}

// ---------- 详情/目录 ----------
let cur: SearchBook | null = null
let chapters: Chapter[] = []

async function openDetail(b: SearchBook) {
  cur = b
  showTab('read')
  const el = $('#tab-read')
  el.innerHTML = `<div class="card">加载详情…</div>`
  try {
    const sources = sourceStore.all()
    const src = sources.find((s) => s.bookSourceUrl === b.bookSourceUrl)!
    const info = await getBookInfo(src, b.bookUrl)
    chapters = await getChapterList(src, info.tocUrl)
    shelfStore.upsert({
      bookUrl: b.bookUrl,
      bookSourceUrl: b.bookSourceUrl,
      name: info.name || b.name,
      author: info.author || b.author,
      coverUrl: info.coverUrl || b.coverUrl,
      tocUrl: info.tocUrl,
      chapters,
    })
    renderReader(0)
    renderShelf()
  } catch (e) {
    if (b.bookSourceUrl) markUnreadable(b.bookSourceUrl, String(e))
    el.innerHTML = `<div class="card"><p class="err">加载失败：${esc(String(e))}</p>${ruleHint()}
      ${b.bookSourceUrl ? `<div class="row" style="margin-top:8px">
        <button class="ghost" id="rd-del-src">删掉这个源（这本书打不开）</button>
        <button class="ghost" id="rd-kill-src">标为废源</button>
        ${aiFixButton({ scene: 'detail', sourceUrl: b.bookSourceUrl, sourceName: sourceStore.all().find((s) => s.bookSourceUrl === b.bookSourceUrl)?.bookSourceName, bookName: b.name, bookUrl: b.bookUrl, url: b.bookUrl, error: String(e) })}
      </div>` : ''}
    </div>`
    $('#rd-del-src')?.addEventListener('click', () => {
      const src = sourceStore.all().find((s) => s.bookSourceUrl === b.bookSourceUrl)
      removeSource(b.bookSourceUrl, {
        confirmText: `「${src?.bookSourceName ?? b.bookSourceUrl}」打不开这本书，确定删除？（书架上该源的书一并移出，含本书）`,
      })
    })
    $('#rd-kill-src')?.addEventListener('click', () => {
      checkStore.setMany({
        [b.bookSourceUrl]: { ok: false, kind: 'dead', ts: Date.now(), ms: 0, reason: `手动标记（${String(e).slice(0, 30)}）` },
      })
      setStatus('已标记为废源，搜索将跳过')
      renderSources()
    })
  }
}

// ---------- 阅读 ----------
let curIdx = 0

async function renderReader(idx: number) {
  const el = $('#tab-read')
  if (!cur) {
    el.innerHTML = `<div class="card">先去搜索打开一本书。</div>`
    return
  }
  curIdx = idx
  const total = chapters.length
  // 章末导航（正文读到底直接翻章，不用滚回顶部）与顶栏同名按钮同规则：
  // 走不通的方向直接置灰 + 末章写「已是最后一章」，不再点了没反应。
  const nav = chapterNavState(idx, total, cur.name)
  const hasPrev = nav.canPrev
  const hasNext = nav.canNext
  el.innerHTML = `<div class="card"><div class="row">
      <b style="flex:1">${esc(cur.name)} ${total ? `（${idx + 1}/${total}）` : ''}</b>
      <button class="ghost" id="r-toc">目录</button>
      <button class="ghost" id="r-prev" ${hasPrev ? '' : 'disabled'}>上一章</button>
      <button class="ghost" id="r-next" ${hasNext ? '' : 'disabled'}>下一章</button>
      <button class="ghost" id="r-reload" title="重读数据目录里的书源/书架，再按新规则重拉本章（AI 改过书源后点它；目录规则变了会一并重拉目录）">刷新</button>
      <button class="ghost" id="r-del-src" title="这本书读不了时可删掉这个书源">删源</button>
      ${aiFixButton({ scene: 'content', sourceUrl: cur.bookSourceUrl, sourceName: sourceStore.all().find((s) => s.bookSourceUrl === cur!.bookSourceUrl)?.bookSourceName, bookName: cur.name, bookUrl: cur.bookUrl })}
      <button class="ghost" id="r-unshelf" title="从书架移除这本书">移出书架</button>
    </div>
    <div class="meta" id="r-srcinfo" style="margin-top:4px">源：${esc(sourceStore.all().find((s) => s.bookSourceUrl === cur!.bookSourceUrl)?.bookSourceName ?? '(已删除)')}</div>
    <div class="toc" id="r-toclist" hidden style="margin-top:8px;max-height:300px;overflow:auto"></div>
    <h3 id="r-title">${esc(chapters[idx]?.name ?? '')}</h3>
    <div class="content" id="r-body">正文加载中…</div>
    <div class="chapnav" id="r-nav">
      <button class="ghost" id="r-prev2" ${hasPrev ? '' : 'disabled'}>← 上一章</button>
      <button class="ghost" id="r-toc2" title="展开目录并回到顶部">目录</button>
      <button class="ghost" id="r-next2" ${hasNext ? '' : 'disabled'}>下一章 →</button>
      <div class="meta" id="r-nav-meta">${esc(nav.note)}</div>
    </div></div>`
  const toc = $('#r-toclist') as HTMLElement
  toc.innerHTML = chapters.map((c, i) => `<div data-i="${i}" class="${i === idx ? 'cur' : ''}">${esc(c.name)}</div>`).join('')
  toc.querySelectorAll('[data-i]').forEach((d) => {
    d.addEventListener('click', () => renderReader(Number((d as HTMLElement).dataset.i)))
  })
  $('#r-toc')?.addEventListener('click', () => {
    toc.hidden = !toc.hidden
  })
  const goPrev = () => {
    if (idx > 0) renderReader(idx - 1)
  }
  const goNext = () => {
    if (idx < total - 1) renderReader(idx + 1)
  }
  $('#r-prev')?.addEventListener('click', goPrev)
  $('#r-next')?.addEventListener('click', goNext)
  // 章末那一条：同一个动作（换章后 renderReader 会把页面滚回顶部）
  $('#r-prev2')?.addEventListener('click', goPrev)
  $('#r-next2')?.addEventListener('click', goNext)
  $('#r-toc2')?.addEventListener('click', () => {
    toc.hidden = false // 目录在顶栏下方，展开后滚上去就能选章
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
  // 重读数据目录 + 按新规则重拉本章（AI 修完源不用去别的页面找刷新按钮）
  $('#r-reload')?.addEventListener('click', () => void refreshFromStore('刷新'))
  // 阅读时随时删源 / 移出书架（“这本书打不开时就删掉这个源”）
  // 删源就删书（书架上该源的书一并移出），并跳到「发现」换别的源重开
  $('#r-del-src')?.addEventListener('click', () => {
    const url = cur!.bookSourceUrl
    const src = sourceStore.all().find((s) => s.bookSourceUrl === url)
    if (!removeSource(url, { confirmText: `确定删除书源「${src?.bookSourceName ?? url}」？（书架上该源的书会一并移出，含本书）` })) return
    gotoExploreAfterRemove(url)
    setStatus(`已删除书源「${src?.bookSourceName ?? url}」并把书架上该源的书一并移出；去「发现」换别的源`)
  })
  $('#r-unshelf')?.addEventListener('click', () => {
    if (!cur) return
    if (!confirm(`从书架移除《${cur.name}》？（不影响书源）`)) return
    shelfStore.remove(cur.bookUrl)
    renderShelf()
    setStatus('已从书架移除')
  })
  try {
    const src = sourceStore.all().find((s) => s.bookSourceUrl === cur!.bookSourceUrl)!
    const text = await getContent(src, chapters[idx]?.url ?? cur.bookUrl)
    const body = $('#r-body')
    body.innerHTML = text.split('\n').map((p) => `<p>${esc(p)}</p>`).join('')
    shelfStore.saveProgress(cur.bookUrl, idx)
    window.scrollTo({ top: 0 })
  } catch (e) {
    const m = String(e)
    if (cur) markUnreadable(cur.bookSourceUrl, m)
    const srcUrl = cur?.bookSourceUrl
    ;($('#r-body') as HTMLElement).innerHTML = `<p class="err">正文失败：${esc(m)}</p>${ruleHint()}
      <div class="row" style="margin-top:8px">
        ${srcUrl && !markDeadOnRead(m) ? '<button class="ghost" id="rd-del-src2">删掉这个源</button>' : ''}
        ${srcUrl ? aiFixButton({ scene: 'content', sourceUrl: srcUrl, sourceName: sourceStore.all().find((s) => s.bookSourceUrl === srcUrl)?.bookSourceName, bookName: cur?.name, bookUrl: cur?.bookUrl, url: chapters[idx]?.url, error: m }) : ''}
        <button class="ghost" id="rd-reload" title="AI 修过书源后：重读数据目录，再用新规则重拉这一章">刷新数据重试</button>
        <button class="ghost" id="rd-goto-explore">去发现找别的源</button>
      </div>`
    $('#rd-del-src2')?.addEventListener('click', () => {
      const src = sourceStore.all().find((s) => s.bookSourceUrl === srcUrl)
      if (!removeSource(srcUrl!, { confirmText: `「${src?.bookSourceName ?? ''}」读不了这章，确定删除？（书架上该源的书一并移出）` }))
        return
      gotoExploreAfterRemove(srcUrl!)
      setStatus(`已删除书源「${src?.bookSourceName ?? ''}」并把书架上该源的书一并移出；去「发现」换别的源`)
    })
    $('#rd-reload')?.addEventListener('click', () => void refreshFromStore('刷新数据重试'))
    $('#rd-goto-explore')?.addEventListener('click', () => {
      showTab('explore')
      renderExplore()
    })
  }
}

// ---------- 书架 ----------
function renderShelf() {
  const el = $('#tab-shelf')
  const list = shelfStore.all()
  el.innerHTML = `<div class="card"><h3>我的书架（${list.length}）</h3>
    <div class="meta" style="margin-bottom:6px">数据存本地文件 legado-web/shelf.json（数据目录；浏览器不留副本）</div>
    ${list.map((b) => {
      const src = sourceStore.all().find((s) => s.bookSourceUrl === b.bookSourceUrl)
      return `<div class="book">${b.coverUrl ? `<img src="${esc(b.coverUrl)}" loading="lazy" referrerpolicy="no-referrer" />` : ''}
      <div style="flex:1"><b>${esc(b.name)}</b><div class="meta">${esc(b.author)} · ${b.chapters?.length ?? 0} 章 · 读到 ${shelfStore.progress(b.bookUrl) + 1}</div>
      <div class="meta">源：${esc(src?.bookSourceName ?? '(已删除)')}</div></div>
      <button class="ghost" data-read="${esc(b.bookUrl)}">继续读</button>
      ${src ? `<button class="ghost" data-delsrc="${esc(b.bookSourceUrl)}" title="删源就删书：书架上该源的书会一并移出">删源</button>` : ''}
      <button class="ghost" data-rm="${esc(b.bookUrl)}">移除</button></div>`
    }).join('') || '<p>空。去搜索/发现找书，打开详情会自动加入书架。</p>'}</div>`
  el.querySelectorAll('[data-delsrc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = (btn as HTMLElement).dataset.delsrc!
      const src = sourceStore.all().find((s) => s.bookSourceUrl === url)
      removeSource(url, {
        confirmText: `确定删除书源「${src?.bookSourceName ?? url}」？（书架上该源的书会一并移出，含本书）`,
      })
    })
  })
  el.querySelectorAll('[data-read]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const b = shelfStore.all().find((x) => x.bookUrl === (btn as HTMLElement).dataset.read)!
      const src = sourceStore.all().find((s) => s.bookSourceUrl === b.bookSourceUrl)
      if (!src) {
        setStatus('该书的书源已删除，请重新导入')
        return
      }
      cur = {
        bookSourceUrl: b.bookSourceUrl,
        bookSourceName: src.bookSourceName,
        name: b.name,
        author: b.author,
        bookUrl: b.bookUrl,
        coverUrl: b.coverUrl,
      }
      chapters = b.chapters ?? (await getChapterList(src, b.tocUrl ?? b.bookUrl))
      showTab('read')
      await renderReader(shelfStore.progress(b.bookUrl))
    })
  })
  el.querySelectorAll('[data-rm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      shelfStore.remove((btn as HTMLElement).dataset.rm!)
      renderShelf()
    })
  })
}

// ---------- 检测 ----------

let checkResults: CheckResult[] = []
let checking = false
let checkStop = false

function checkBadge(r?: CheckRecord | CheckResult): string {
  if (!r) return '<span class="meta">未检</span>'
  const kind = 'kind' in r ? r.kind : undefined
  if (r.ok) return '<span class="ok">✔ 可用</span>'
  const reason = r.reason ?? ''
  const short = reason.length > 26 ? reason.slice(0, 26) + '…' : reason
  if (kind === 'dead') return `<span class="err">✘ 废源：${esc(short)}</span>`
  return `<span class="err">✘ ${esc(short)}</span>`
}

function renderCheck() {
  const el = $('#tab-check')
  const sources = sourceStore.all()
  const cached = checkStore.all()
  el.innerHTML = `
    <div class="card">
      <h3>书源检测（${sources.length} 个源）</h3>
      <div class="row">
        <input id="c-key" value="剑" placeholder="检测用关键词" style="width:120px" />
        <select id="c-mode">
          <option value="reach">仅连通（最快）</option>
          <option value="search" selected>连通+搜索</option>
          <option value="full">完整链路（慢）</option>
        </select>
        <label class="meta">并发 <input id="c-conc" type="number" value="4" min="1" max="12" style="width:56px" /></label>
        <button class="go" id="c-run">开始检测</button>
        <button class="ghost" id="c-stop">停止</button>
        <button class="ghost" id="c-clear">清空结果</button>
        <button class="ghost" id="c-refresh" title="从数据目录文件重读数据，再重渲染所有页">刷新</button>
        <select id="c-filter">
          <option value="all">全部</option>
          <option value="fail">仅失败</option>
          <option value="ok">仅可用</option>
        </select>
      </div>
      <div id="c-msg" class="meta" style="margin-top:8px">
        检测会真实请求各书源：能过则说明该源在本机可用；失败会给出人话原因（被墙/盾页/规则不兼容）。
      </div>
      <div class="meta" style="margin-top:6px">检测结果会记住，书源列表会直接标注可用/不可用。</div>
    </div>
    <div class="card" id="c-sum"></div>
    <div class="card" id="c-list"></div>`
  $('#c-run')?.addEventListener('click', runCheck)
  $('#c-stop')?.addEventListener('click', () => {
    checkStop = true
    setStatus('正在停止…')
  })
  $('#c-clear')?.addEventListener('click', () => {
    checkStore.clear()
    checkResults = []
    renderCheck()
    renderSources()
  })
  $('#c-refresh')?.addEventListener('click', () => void refreshFromStore('刷新数据'))
  $('#c-filter')?.addEventListener('change', paintCheck)
  // 已有历史结果时直接展示
  if (!checkResults.length && Object.keys(cached).length) {
    const hist: CheckResult[] = []
    for (const s of sources) {
      const r = cached[s.bookSourceUrl]
      if (!r) continue
      hist.push({
        bookSourceUrl: s.bookSourceUrl,
        bookSourceName: s.bookSourceName,
        ok: r.ok,
        kind: r.kind ?? (r.ok ? 'ok' : 'suspect'),
        reason: r.reason,
        steps: [],
        count: r.count,
        tocCount: r.tocCount,
        ruleErrors: 0,
        ms: r.ms,
        time: r.ts,
      })
    }
    checkResults = hist
  }
  paintCheck()
}

async function runCheck() {
  if (checking) return
  const sources = sourceStore.all()
  if (!sources.length) {
    ;($('#c-msg') as HTMLElement).innerHTML = '<span class="err">先到「书源」导入书源</span>'
    return
  }
  const key = (document.getElementById('c-key') as HTMLInputElement).value.trim() || '剑'
  const mode = (document.getElementById('c-mode') as HTMLSelectElement).value as CheckMode
  const conc = Math.max(1, Math.min(12, Number((document.getElementById('c-conc') as HTMLInputElement).value) || 4))
  checking = true
  checkStop = false
  checkResults = []
  const msg = $('#c-msg')
  const queue = [...sources]
  const total = queue.length
  let done = 0
  paintCheck()
  const worker = async () => {
    while (queue.length && !checkStop) {
      const s = queue.shift()!
      msg.innerHTML = `检测中… ${done}/${total}（当前：${esc(s.bookSourceName)}）`
      setStatus(`检测中 ${done}/${total}`)
      let r: CheckResult
      try {
        r = await checkSource(s, { key, mode })
      } catch (e) {
        r = {
          bookSourceUrl: s.bookSourceUrl,
          bookSourceName: s.bookSourceName,
          ok: false,
          kind: 'suspect',
          reason: `未预期错误：${String(e)}`,
          steps: [],
          ruleErrors: 0,
          ms: 0,
          time: Date.now(),
        }
      }
      checkResults.push(r)
      done++
      checkStore.setMany({
        [r.bookSourceUrl]: { ok: r.ok, ts: r.time, ms: r.ms, count: r.count, tocCount: r.tocCount, reason: r.reason },
      })
      paintCheck()
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, total) }, worker))
  checking = false
  const okCount = checkResults.filter((r) => r.ok).length
  msg.innerHTML = checkStop
    ? `已停止：完成 ${checkResults.length}/${total}`
    : `<span class="ok">检测完成：${okCount} 可用 / ${checkResults.length - okCount} 不可用（共 ${total}）</span>`
  setStatus(checkStop ? '检测已停止' : '检测完成')
  renderSources()
  paintCheck()
}

function paintCheck() {
  const list = $('#c-list')
  const sum = $('#c-sum')
  if (!list || !sum) return
  const filter = (document.getElementById('c-filter') as HTMLSelectElement | null)?.value ?? 'all'
  const okCount = checkResults.filter((r) => r.ok).length
  sum.innerHTML = checkResults.length
    ? `<b>结果概览</b>：共检 ${checkResults.length} · <span class="ok">可用 ${okCount}</span> · <span class="err">不可用 ${checkResults.length - okCount}</span>${checking ? ' · <b>检测中…</b>' : ''}`
    : '<span class="meta">尚无检测结果，点上方「开始检测」。</span>'
  const rows = checkResults.filter((r) => (filter === 'all' ? true : filter === 'ok' ? r.ok : !r.ok))
  list.innerHTML =
    rows
      .map((r, i) => {
        const steps = r.steps.length
          ? `<div class="meta" style="margin-top:4px">${r.steps
              .map((s) => `${s.ok ? '✔' : '✘'} ${esc(s.name)} ${s.ms}ms${s.info ? ` (${esc(s.info)})` : ''}${s.error ? ` — ${esc(s.error)}` : ''}`)
              .join(' · ')}</div>`
          : ''
        return `<div class="book"><div style="flex:1">
          <b>${esc(r.bookSourceName)}</b> ${checkBadge(r)}
          <div class="meta">${esc(r.bookSourceUrl)} · ${r.ms}ms${r.count != null ? ` · 搜索 ${r.count} 本` : ''}${r.tocCount ? ` · 目录 ${r.tocCount} 章` : ''}${r.ruleErrors ? ` · 规则不兼容 ${r.ruleErrors}` : ''}</div>
          <div class="meta">${esc(r.reason)}</div>${steps}</div>
          ${!r.ok ? aiFixButton(checkFixContext(r.bookSourceUrl, r.bookSourceName, r.reason, r.steps)) : ''}
          <button class="ghost" data-again="${i}">单检</button></div>`
      })
      .join('') || '<p class="meta">没有符合筛选条件的结果。</p>'
  list.querySelectorAll('[data-again]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = rows[Number((b as HTMLElement).dataset.again)]!
      const s = sourceStore.all().find((x) => x.bookSourceUrl === r.bookSourceUrl)
      if (!s) return
      const key = (document.getElementById('c-key') as HTMLInputElement).value.trim() || '剑'
      const mode = (document.getElementById('c-mode') as HTMLSelectElement).value as CheckMode
      setStatus(`单检 ${s.bookSourceName}…`)
      const nr = await checkSource(s, { key, mode })
      const i = checkResults.findIndex((x) => x.bookSourceUrl === nr.bookSourceUrl)
      if (i >= 0) checkResults[i] = nr
      else checkResults.push(nr)
      checkStore.setMany({
        [nr.bookSourceUrl]: { ok: nr.ok, ts: nr.time, ms: nr.ms, count: nr.count, tocCount: nr.tocCount, reason: nr.reason },
      })
      paintCheck()
      renderSources()
    })
  })
}

// ---------- 自动检测废源 ----------

let scanning = false
let scanStop = false

/** 批量检测并标记废源；onlyUnchecked=true 时只测没检测过的源；mode: search=快、full=含可读性 */
async function scanSources(onlyUnchecked = false, mode: CheckMode = 'search'): Promise<void> {
  if (scanning) return
  const all = sourceStore.all()
  const records = checkStore.all()
  const targets = onlyUnchecked ? all.filter((s) => !records[s.bookSourceUrl]) : all
  const scanMsg = (): HTMLElement | null => document.getElementById('src-scanmsg')
  if (!targets.length) {
    const m = scanMsg()
    if (m) m.textContent = onlyUnchecked ? '所有书源都已检测过' : '没有书源'
    return
  }
  scanning = true
  scanStop = false
  const queue = [...targets]
  const total = queue.length
  let done = 0
  let deadCount = 0
  const upd = () => {
    const m = scanMsg()
    if (m)
      m.textContent = `正在${mode === 'full' ? '完整' : '快速'}检测废源… ${done}/${total}（已判定废源 ${deadCount}）${mode === 'full' ? '，完整模式较慢' : ''}`
    setStatus(`检测废源 ${done}/${total}`)
  }
  upd()
  const worker = async () => {
    while (queue.length && !scanStop) {
      const s = queue.shift()!
      let r: CheckResult
      try {
        // 快速=连通+搜索（看站点死活）；完整=再跟详情/目录/正文（看能不能真读书）
        r = await checkSource(s, { key: '剑', mode })
      } catch {
        r = {
          bookSourceUrl: s.bookSourceUrl,
          bookSourceName: s.bookSourceName,
          ok: false,
          kind: 'dead',
          reason: '检测异常',
          steps: [],
          ruleErrors: 0,
          ms: 0,
          time: Date.now(),
        }
      }
      if (r.kind === 'dead') deadCount++
      checkStore.setMany({
        [r.bookSourceUrl]: {
          ok: r.ok,
          kind: r.kind,
          ts: r.time,
          ms: r.ms,
          count: r.count,
          tocCount: r.tocCount,
          reason: r.reason,
        },
      })
      const i = checkResults.findIndex((x) => x.bookSourceUrl === r.bookSourceUrl)
      if (i >= 0) checkResults[i] = r
      else checkResults.push(r)
      done++
      if (done % 5 === 0 || done === total) upd()
    }
  }
  await Promise.all(Array.from({ length: mode === 'full' ? 3 : 4 }, worker))
  scanning = false
  const m = scanMsg()
  if (m) m.textContent = scanStop ? `已停止：${done}/${total}` : `检测完成：${done} 个，其中废源 ${deadCount} 个（已自动隐藏/搜索跳过）`
  setStatus('废源检测完成')
  renderSources()
  renderSearch()
  paintCheck()
}

// ---------- 阅读失败自动记废源 ----------

/** 这些原因属于源/站点层面失效（与具体书无关），直接判废源 */
const DEAD_READ_REASON = /没有正文规则|不是正文而是站点提示|正文需要 WebJS|正文页异常|正文规则未解析|没有搜索规则|人机验证|网络不可达/

function markDeadOnRead(reason: string): boolean {
  return DEAD_READ_REASON.test(reason)
}

/** 读不到的源：直接记为废源（隐藏+搜索跳过），并提示 */
function markUnreadable(sourceUrl: string, reason: string) {
  const src = sourceStore.all().find((s) => s.bookSourceUrl === sourceUrl)
  if (!src) return
  if (!DEAD_READ_REASON.test(reason)) return
  const prev = checkStore.get(sourceUrl)
  if (prev?.kind === 'dead' && prev.reason === reason) return
  checkStore.setMany({
    [sourceUrl]: {
      ok: false,
      kind: 'dead',
      ts: Date.now(),
      ms: 0,
      reason: `阅读失败：${reason.slice(0, 80)}`,
    },
  })
  setStatus(
    `已把「${src.bookSourceName}」标为废源（搜索/发现跳过、书源页默认隐藏）——想继续用它：书源页取消“隐藏废源”，或点它那行的「标回可用」；想彻底清掉：点「删除废源」`,
  )
}

// ---------- 发现 ----------

let exSourceUrl = ''
let exKinds: ExploreKind[] = []
let exKind: ExploreKind | null = null
let exResults: SearchBook[] = []
let exPage = 1
let exLoading = false
/** #ex-list 里现在显示的是「分类浏览」还是「关键词搜索」 */
let exListMode: 'kind' | 'search' = 'kind'
let exSearchKey = ''
let exSearchInput = ''

/** 有发现规则的书源（默认为可用源） */
function exploreSources(): BookSource[] {
  const recs = checkStore.all()
  const withExplore = sourceStore.all().filter((s) => (s.exploreUrl ?? '').trim() !== '')
  const usable = withExplore.filter((s) => recs[s.bookSourceUrl]?.kind !== 'dead')
  return usable.length ? usable : withExplore
}

function renderExplore() {
  const el = $('#tab-explore')
  const srcs = exploreSources()
  if (!srcs.length) {
    el.innerHTML = `<div class="card"><p class="err">没有带“发现”规则的书源（exploreUrl 为空）。先去「书源」导入。</p></div>`
    return
  }
  if (!exSourceUrl || !srcs.some((s) => s.bookSourceUrl === exSourceUrl)) {
    exSourceUrl = srcs[0]!.bookSourceUrl
  }
  const cur = srcs.find((s) => s.bookSourceUrl === exSourceUrl)!
  // 收藏（置顶）的源：下拉里单独一组放最前，「⭐ 常用」一行做成一键切换（不用每次下拉找）
  const pinnedSet = prefsStore.pinnedSet()
  const pinned = srcs.filter((s) => pinnedSet.has(s.bookSourceUrl))
  const others = srcs.filter((s) => !pinnedSet.has(s.bookSourceUrl))
  const opt = (s: BookSource, star: boolean) =>
    `<option value="${esc(s.bookSourceUrl)}" ${s.bookSourceUrl === exSourceUrl ? 'selected' : ''}>${star ? '⭐ ' : ''}${esc(s.bookSourceName)}</option>`
  const options = [
    pinned.length ? `<optgroup label="⭐ 常用（收藏）">${pinned.map((s) => opt(s, true)).join('')}</optgroup>` : '',
    others.length ? `<optgroup label="${pinned.length ? '其他' : '全部书源'}">${others.map((s) => opt(s, false)).join('')}</optgroup>` : '',
  ].join('')
  const isPinned = pinnedSet.has(exSourceUrl)
  el.innerHTML = `
    <div class="card">
      <div class="row">
        <label class="meta">书源 <select id="ex-source">${options}</select></label>
        <button class="ghost${isPinned ? ' star-on' : ''}" id="ex-pin" title="${isPinned ? '取消收藏这个源' : '收藏这个源（放到「⭐ 常用」最前，下拉里也排最前）'}">${isPinned ? '⭐ 已收藏' : '☆ 收藏'}</button>
        <button class="ghost" id="ex-reload">重新加载分类</button>
        ${aiFixButton({ scene: 'explore', sourceUrl: exSourceUrl, sourceName: cur.bookSourceName, url: cur.exploreUrl })}
        <button class="ghost" id="ex-del">删除此源</button>
        <button class="ghost" id="ex-kill">标废源</button>
        <span class="meta" id="ex-msg"></span>
      </div>
      ${
        pinned.length
          ? `<div class="row" style="margin-top:6px;flex-wrap:wrap"><span class="meta">⭐ 常用</span>${pinned
              .map(
                (s) =>
                  `<button class="ghost${s.bookSourceUrl === exSourceUrl ? ' on' : ''}" data-ex-pick="${esc(s.bookSourceUrl)}">${esc(s.bookSourceName)}</button>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="row" style="margin-top:8px">
        <input id="ex-search" value="${esc(exSearchInput)}" placeholder="搜这个源的关键词（直接调它的搜索接口）" style="flex:1;min-width:220px" />
        <button class="go" id="ex-search-go">搜索</button>
      </div>
      <div class="row" id="ex-kinds" style="margin-top:8px;flex-wrap:wrap"></div>
    </div>
    <div class="card" id="ex-list"></div>`

  // ⭐ 收藏当前源
  $('#ex-pin')?.addEventListener('click', () => {
    const now = prefsStore.togglePin(exSourceUrl)
    setStatus(now ? `已收藏「${cur.bookSourceName}」（下拉与「⭐ 常用」里排最前）` : `已取消收藏「${cur.bookSourceName}」`)
    renderExplore()
  })
  // ⭐ 常用：一键切源
  el.querySelectorAll('[data-ex-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      const url = (b as HTMLElement).dataset.exPick!
      if (url === exSourceUrl) return
      exSourceUrl = url
      exKinds = []
      exKind = null
      exResults = []
      exListMode = 'kind'
      renderExplore()
      void loadKinds()
    })
  })
  // 发现页直接搜这个源
  const exSearchEl = $('#ex-search') as HTMLInputElement | null
  const runExploreSearch = () => {
    const key = (exSearchEl?.value ?? '').trim()
    exSearchInput = key
    void searchInExploreSource(key)
  }
  $('#ex-search-go')?.addEventListener('click', runExploreSearch)
  exSearchEl?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') runExploreSearch()
  })
  $('#ex-source')?.addEventListener('change', (e) => {
    exSourceUrl = (e.target as HTMLSelectElement).value
    exKinds = []
    exKind = null
    exResults = []
    exListMode = 'kind'
    renderExplore()
    void loadKinds()
  })
  $('#ex-reload')?.addEventListener('click', () => {
    clearExploreKindsCache(exSourceUrl)
    void loadKinds()
  })
  $('#ex-del')?.addEventListener('click', () => {
    const cur = sourceStore.all().find((s) => s.bookSourceUrl === exSourceUrl)
    if (!cur) return
    if (removeSource(exSourceUrl, { confirmText: `确定删除书源「${cur.bookSourceName}」？（书架上该源的书会一并移出）`, refreshExplore: true })) {
      exSourceUrl = ''
      exKinds = []
      exKind = null
      exResults = []
      renderExplore()
    }
  })
  $('#ex-kill')?.addEventListener('click', () => {
    checkStore.setMany({
      [exSourceUrl]: { ok: false, kind: 'dead', ts: Date.now(), ms: 0, reason: '手动标记为废源' },
    })
    setStatus('已标记为废源（搜索/发现将跳过）')
    renderExplore()
  })
  void cur
  if (!exKinds.length) void loadKinds()
  else paintKinds()
  paintExploreList()
}

async function loadKinds() {
  const msg = document.getElementById('ex-msg')
  const src = sourceStore.all().find((s) => s.bookSourceUrl === exSourceUrl)
  if (!src) return
  if (msg) msg.textContent = '加载分类中…'
  try {
    exKinds = await parseExploreKinds(src)
    if (msg) msg.textContent = exKinds.length ? `共 ${exKinds.length} 个分类` : '该源没有解析出分类'
  } catch (e) {
    exKinds = []
    if (msg) {
      const srcName = sourceStore.all().find((s) => s.bookSourceUrl === exSourceUrl)?.bookSourceName ?? ''
      msg.innerHTML = `<span class="err">分类解析失败：${esc(String(e).slice(0, 80))}</span>
        <button class="ghost" id="ex-kinds-reload" title="AI 修过书源后：重读数据目录，再用新规则重新解析分类">刷新数据重试</button>
        ${aiFixButton({
          scene: 'explore',
          sourceUrl: exSourceUrl,
          sourceName: srcName,
          url: src?.exploreUrl,
          error: `分类解析失败：${String(e)}`,
        })}`
      $('#ex-kinds-reload')?.addEventListener('click', () => void refreshFromStore('刷新数据'))
    }
  }
  paintKinds()
}

function paintKinds() {
  const box = document.getElementById('ex-kinds')
  if (!box) return
  const info = getInfoMap(exSourceUrl)
  box.innerHTML = exKinds
    .map((k, i) => {
      const t = (k.type ?? 'url').toLowerCase()
      const isUrl = t === 'url'
      if (isUrl) return `<button class="ghost" data-kind="${i}">${esc(k.title || '未命名')}</button>`
      // 筛选控件：text/select/toggle/button
      if (t === 'text') {
        const v = String(info[k.title] ?? k.default ?? '')
        return `<label class="meta">${esc(k.title)} <input data-input="${i}" value="${esc(v)}" style="width:90px" /></label>`
      }
      // select / toggle：点一下在 chars 里轮换
      const chars = (k.chars ?? []).filter((x): x is string => !!x)
      const cur = String(info[k.title] ?? k.default ?? chars[0] ?? '')
      return `<button class="ghost" data-cycle="${i}">${esc(k.title)}：${esc(cur)}</button>`
    })
    .join('')
  box.querySelectorAll('[data-kind]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = exKinds[Number((b as HTMLElement).dataset.kind)]!
      void openKind(k)
    })
  })
  box.querySelectorAll('[data-cycle]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = exKinds[Number((b as HTMLElement).dataset.cycle)]!
      const chars = (k.chars ?? []).filter((x): x is string => !!x)
      const info = getInfoMap(exSourceUrl)
      const cur = String(info[k.title] ?? k.default ?? chars[0] ?? '')
      const idx = chars.indexOf(cur)
      const next = chars.length ? chars[(idx + 1) % chars.length]! : cur
      void info.put(k.title, next)
      // 有 action 的按原版语义执行 JS（出错不影响使用）
      if (k.action) {
        const src = sourceStore.all().find((s) => s.bookSourceUrl === exSourceUrl)
        if (src) {
          try {
            evalJsRule(String(k.action), { baseUrl: exSourceUrl, source: src, infoMap: info }, getScope(exSourceUrl))
          } catch {
            /* ignore */
          }
        }
      }
      paintKinds()
    })
  })
  box.querySelectorAll('[data-input]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const k = exKinds[Number((inp as HTMLElement).dataset.input)]!
      void getInfoMap(exSourceUrl).put(k.title, (inp as HTMLInputElement).value)
    })
  })
}

async function openKind(kind: ExploreKind) {
  if (exLoading) return
  exLoading = true
  exKind = kind
  exPage = 1
  exResults = []
  exListMode = 'kind'
  paintExploreList()
  setStatus(`发现：${kind.title}…`)
  const src = sourceStore.all().find((s) => s.bookSourceUrl === exSourceUrl)!
  try {
    const list = await loadExploreBooks(src, kind, 1)
    exResults = list
    paintExploreList()
    setStatus(list.length ? `发现：${kind.title}（${list.length} 本）` : `发现：${kind.title}（无结果）`)
    markIfUnusable(src.bookSourceUrl, kind, list.length)
  } catch (e) {
    ;($('#ex-list') as HTMLElement).innerHTML = `<p class="err">加载失败：${esc(String(e))}</p>${ruleHint()}
      <div class="row" style="margin-top:8px">
        <button class="ghost" id="ex-err-del">删掉这个源</button>
        <button class="ghost" id="ex-err-kill">标为废源</button>
        <button class="ghost" id="ex-err-reload" title="AI 修过书源后：重读数据目录，再用新规则重试这个分类">刷新数据重试</button>
        <button class="ghost" id="ex-err-next">换个源</button>
        ${aiFixButton({ scene: 'explore', sourceUrl: src.bookSourceUrl, sourceName: src.bookSourceName, url: kind.url ?? src.exploreUrl, error: `${kind.title}：${String(e)}` })}
      </div>`
    $('#ex-err-del')?.addEventListener('click', () => {
      if (removeSource(exSourceUrl, { confirmText: '这个源打不开书，确定删除？（书架上该源的书一并移出）' })) {
        exSourceUrl = ''
        exKinds = []
        exKind = null
        exResults = []
        renderExplore()
      }
    })
    $('#ex-err-kill')?.addEventListener('click', () => {
      checkStore.setMany({
        [exSourceUrl]: { ok: false, kind: 'dead', ts: Date.now(), ms: 0, reason: '发现加载失败，手动标记' },
      })
      exSourceUrl = ''
      exKinds = []
      exKind = null
      renderExplore()
    })
    $('#ex-err-reload')?.addEventListener('click', async () => {
      const kind = exKind
      await refreshFromStore('刷新数据')
      if (kind) void openKind(kind)
    })
    $('#ex-err-next')?.addEventListener('click', () => {
      const srcs = exploreSources()
      const i = srcs.findIndex((s) => s.bookSourceUrl === exSourceUrl)
      exSourceUrl = srcs[(i + 1) % srcs.length]?.bookSourceUrl ?? ''
      exKinds = []
      exKind = null
      exResults = []
      renderExplore()
    })
    setStatus('发现失败')
  } finally {
    exLoading = false
  }
}

/** 发现分类无结果且有规则失败 → 记可疑（便于发现某源的发现规则坏了） */
function markIfUnusable(sourceUrl: string, kind: ExploreKind, count: number) {
  if (count > 0) return
  const used = ruleErrors.length
  if (!used) return
  const prev = checkStore.get(sourceUrl)
  if (prev?.kind === 'dead') return
  checkStore.setMany({
    [sourceUrl]: {
      ok: false,
      kind: 'suspect',
      ts: Date.now(),
      ms: 0,
      reason: `发现分类“${kind.title}”无结果，且有 ${used} 条规则不兼容`,
    },
  })
}

/** 发现页直接搜当前源（不用切到「搜索」页）：结果就列在下面同一个列表里 */
async function searchInExploreSource(key: string) {
  const list = $('#ex-list') as HTMLElement | null
  if (!key) {
    setStatus('先填关键词')
    return
  }
  if (exLoading) return
  const src = sourceStore.all().find((s) => s.bookSourceUrl === exSourceUrl)
  if (!src) return
  exLoading = true
  exListMode = 'search'
  exSearchKey = key
  exKind = null
  exPage = 1
  exResults = []
  paintExploreList()
  setStatus(`搜索「${key}」于 ${src.bookSourceName}…`)
  try {
    const found = await searchBooks(src, key, 1)
    exResults = found
    paintExploreList()
    setStatus(
      found.length ? `搜索「${key}」：${found.length} 本（${src.bookSourceName}）` : `搜索「${key}」无结果（${src.bookSourceName}）`,
    )
    if (!found.length && list) {
      // 搜索无结果往往是规则问题：给一条直达 AI 的路
      list.insertAdjacentHTML(
        'beforeend',
        `<div class="row" style="margin-top:8px">${aiFixButton({ scene: 'search', sourceUrl: src.bookSourceUrl, sourceName: src.bookSourceName, url: src.searchUrl, error: `搜索「${key}」无结果（未报错但没解析出书）` })}</div>`,
      )
    }
  } catch (e) {
    exResults = []
    paintExploreList()
    if (list) {
      list.insertAdjacentHTML(
        'beforeend',
        `<div class="row" style="margin-top:8px">${aiFixButton({ scene: 'search', sourceUrl: src.bookSourceUrl, sourceName: src.bookSourceName, url: src.searchUrl, error: String(e) })}</div>`,
      )
    }
    setStatus(`搜索失败：${String(e).slice(0, 60)}`)
  } finally {
    exLoading = false
  }
}

async function nextExplorePage() {
  if ((!exKind && exListMode !== 'search') || exLoading) return
  exPage++
  const src = sourceStore.all().find((s) => s.bookSourceUrl === exSourceUrl)!
  exLoading = true
  try {
    const list =
      exListMode === 'search' ? await searchBooks(src, exSearchKey, exPage) : await loadExploreBooks(src, exKind!, exPage)
    if (!list.length) exPage--
    else exResults = [...exResults, ...list]
    paintExploreList()
  } catch {
    exPage--
  } finally {
    exLoading = false
  }
}

function paintExploreList() {
  const list = $('#ex-list')
  if (!list) return
  const title =
    exListMode === 'search'
      ? `<h3>🔍 搜索「${esc(exSearchKey)}」· 第 ${exPage} 页（${exResults.length} 本）</h3>`
      : exKind
        ? `<h3>${esc(exKind.title)} · 第 ${exPage} 页（${exResults.length} 本）</h3>`
        : ''
  if (!title) {
    list.innerHTML = `<p class="meta">选一个书源后：点上方分类浏览，或直接用上面的搜索框搜这个源。</p>`
    return
  }
  list.innerHTML = `
    ${title}
    ${exResults
      .map(
        (b, i) => `<div class="book">${b.coverUrl ? `<img src="${esc(b.coverUrl)}" loading="lazy" referrerpolicy="no-referrer" />` : ''}
      <div style="flex:1"><b>${esc(b.name || '(无名)')}</b> <span class="meta">${esc(b.author || '')} · ${esc(b.bookSourceName)}</span>
      <div class="meta">${esc((b.intro ?? '').slice(0, 80))}</div></div>
      <button class="ghost" data-ex-open="${i}">详情</button></div>`,
      )
      .join('') || '<p class="meta">无结果</p>'}
    <div class="row" style="margin-top:8px"><button class="ghost" id="ex-next">下一页</button></div>`
  list.querySelectorAll('[data-ex-open]').forEach((b) => {
    b.addEventListener('click', () => void openDetail(exResults[Number((b as HTMLElement).dataset.exOpen)]!))
  })
  $('#ex-next')?.addEventListener('click', () => void nextExplorePage())
}

// ---------- 删除书源（发现/阅读出错时随手删） ----------

/**
 * 摘掉一个书源的全部痕迹：书源本体 + 该源的发现缓存 + 该源在书架上的书（“删源就删书”）。
 * 不负责渲染/提示，调用方自行 render；返回移出的书本数。
 */
function purgeSource(url: string): number {
  sourceStore.remove(url)
  checkStore.removeBySource(url) // 检测记录一并清：否则顶栏「废源 N」/检测页还挂着已删源
  clearExploreKindsCache(url)
  return shelfStore.removeBySource(url)
}

/** 删除一个书源（连同其检测记录/发现缓存/书架上的书），并刷新各页面 */
function removeSource(url: string, opts: { confirmText?: string; refreshExplore?: boolean } = {}): boolean {
  const src = sourceStore.all().find((s) => s.bookSourceUrl === url)
  if (!src) return false
  if (opts.confirmText && !confirm(opts.confirmText)) return false
  const books = purgeSource(url)
  setStatus(
    books
      ? `已删除书源：${src.bookSourceName}（同时从书架移出 ${books} 本）`
      : `已删除书源：${src.bookSourceName}`,
  )
  renderAllViews()
  if (opts.refreshExplore) renderExplore()
  return true
}

/** 删源/导入/检测这类改动后，把受影响的页一次全渲染（自动刷新，不靠用户手动 F5） */
function renderAllViews() {
  renderSources()
  renderSearch()
  renderCheck()
  renderShelf()
}

/**
 * 手动刷新（兜底）：**从数据目录文件重读全部数据**再重渲染。
 * 用途：AI/工具直接改了 `sources.json`（或别处改了文件）后，页面内存镜像是旧的，
 * 自动刷新只能刷界面、刷不回文件内容；这时点一下「刷新」即可同步。
 *
 * 阅读页额外处理两件事：
 *   1) `ruleToc` 被改过 → 旧章节表作废，重拉目录（不然新目录规则永远用不上）；
 *   2) 书源已被删 → 清掉阅读页，不停在旧正文上。
 * 最后重调 renderReader → 会用新规则重拉当前章正文。
 */
async function refreshFromStore(reason = '刷新', opts: { quiet?: boolean } = {}): Promise<string> {
  const srcBefore = cur ? sourceStore.all().find((s) => s.bookSourceUrl === cur!.bookSourceUrl) : undefined
  const tocBefore = JSON.stringify(srcBefore?.ruleToc ?? null)
  const idxBefore = curIdx
  const mode = await hydrateFromBackend()
  renderAllViews()
  renderExplore()
  let note = ''
  if (cur) {
    const src = sourceStore.all().find((s) => s.bookSourceUrl === cur!.bookSourceUrl)
    if (!src) {
      clearReaderState()
      setStatus(`${reason}：这本书的书源已不在数据目录里（可能被删），已清空阅读页`)
      return ''
    }
    if (JSON.stringify(src.ruleToc ?? null) !== tocBefore) {
      const b = shelfStore.all().find((x) => x.bookUrl === cur!.bookUrl)
      try {
        chapters = await getChapterList(src, b?.tocUrl ?? cur!.bookUrl)
        if (b) shelfStore.upsert({ ...b, chapters, chapterCount: chapters.length })
        note = ` · 目录规则已更新，已重拉目录 ${chapters.length} 章`
      } catch (e) {
        note = ` · 重拉目录失败（${String(e).slice(0, 60)}）`
      }
    }
  }
  renderReader(cur ? Math.min(idxBefore, Math.max(0, chapters.length - 1)) : -1)
  // quiet：不改状态栏（调用方自己写更贴切的提示，比如“检测到外部改动”），只把附注交回去
  if (opts.quiet) return note
  setStatus(
    `${reason}完成：书源 ${sourceStore.all().length} · 书架 ${shelfStore.all().length}${note} · 存${mode === 'browser' ? '仅内存（后端不可用！刷新会丢）' : '数据目录文件'}`,
  )
  return note
}

/**
 * 数据目录被“外部”改过（AI 工具 / 另一个页面 / 手工编辑）→ 自动重读 + 重渲染。
 * 触发点：切页（showTab）、标签页/窗口重新可见。
 * 这时阅读页会顺带用新规则重拉当前章正文——“AI 修好了但页面还是旧的”就是这么解掉的。
 */
let lastMetaCheck = 0
let autoReloading = false
async function autoReloadIfStoreChanged(): Promise<void> {
  if (autoReloading || searching || checking || scanning) return
  const now = Date.now()
  if (now - lastMetaCheck < 1500) return
  lastMetaCheck = now
  let changed: string[]
  try {
    changed = await remoteStoreChanged()
  } catch {
    return
  }
  if (!changed.length) return
  autoReloading = true
  try {
    const note = await refreshFromStore('检测到数据目录被外部修改', { quiet: true })
    setStatus(`数据目录已更新（${changed.join('/')}）——已自动重读并重渲染${note}`)
  } finally {
    autoReloading = false
  }
}

/** 删源就删书：阅读页正在看的这本也没了，清掉阅读态，避免停在已删源的旧正文上 */
function clearReaderState() {
  cur = null
  chapters = []
  renderReader(-1)
}

/** 删源后跳回「发现」：被删的源正被查看时清掉其分类/结果缓存，避免残留；然后切页渲染 */
function gotoExploreAfterRemove(url: string) {
  if (exSourceUrl === url) {
    exSourceUrl = ''
    exKinds = []
    exKind = null
    exResults = []
    exPage = 1
  }
  clearReaderState()
  showTab('explore')
  renderExplore()
}

function esc(s: string): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

// 启动：先同步本地文件存储（后端可用时），再渲染
async function boot() {
  const mode = await hydrateFromBackend()
  renderSources()
  renderSearch()
  renderExplore()
  renderCheck()
  renderShelf()
  renderReader(-1)
  showTab('shelf')
  const where =
    mode === 'browser'
      ? '仅内存（后端不可用，刷新会丢）—— 请确认 pi-web-ui 服务在运行'
      : mode === 'file-seeded'
        ? '数据目录 legado-web（已把浏览器里的旧数据迁移过来）'
        : '数据目录 legado-web'
  setStatus(`存储：${where}`)
  void storageMode
}

// 存储写入降级时在状态栏说明（数据目录是唯一事实源，写入失败=只活在内存里）
storageEvents.onDegraded = () => setStatus('存储：写入数据目录失败，数据只在内存里（刷新会丢）—— 请确认 pi-web-ui 服务在运行')

// 「AI 修复源」按钮的点击代理（卡片重渲染也不用重绑）
setAiFixStatusReporter(setStatus)
installAiFixHandler()

// 外部改了数据目录就自动重载：切回标签页 / 窗口重新获得焦点时各查一次（切页在 showTab 里查）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void autoReloadIfStoreChanged()
})
window.addEventListener('focus', () => void autoReloadIfStoreChanged())
// 兜底轮询：不用点任何东西也能发现外部改动（隐藏时浏览器会自动降频；函数自带节流）
setInterval(() => void autoReloadIfStoreChanged(), 15_000)

void boot()
