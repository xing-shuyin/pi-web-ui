// 「AI 修复源」按钮：把现场（书源、书籍、出错地址、报错、当前相关规则）交给 pi-web-ui 的 AI。
//
// 内嵌在插件 iframe 里 → postMessage 给插件视图（../client/entry.mjs）→ 主应用
// 切到对话视图 + 新建对话（工作目录切到插件目录）+ 自动发送这段请求。
// 独立打开页面（不是 iframe）时按钮给出提示，不做哑操作。

import type { BookSource } from '../types'
import { sourceStore } from '../store'

export type AiFixScene = 'content' | 'toc' | 'detail' | 'search' | 'explore' | 'source' | 'check' | 'new'

/** 状态栏输出（main.ts 注入；本模块不反向 import 主入口，避免循环依赖）。 */
let statusReporter: (msg: string) => void = () => {}
export function setAiFixStatusReporter(fn: (msg: string) => void): void {
  statusReporter = fn
}

export interface AiFixContext {
  scene: AiFixScene
  sourceUrl: string
  sourceName?: string
  bookName?: string
  bookUrl?: string
  /** 出错的地址（章节页/详情页/搜索接口…） */
  url?: string
  /** 报错原文 */
  error?: string
  /** 检测结论（check 场景） */
  reason?: string
  /** 检测各步摘要（check 场景） */
  steps?: string
}

const pending: AiFixContext[] = []

/** 是否嵌在 pi-web-ui 插件视图里（独立打开时无法开对话）。 */
export function isEmbedded(): boolean {
  try {
    return window.parent !== window
  } catch {
    return false
  }
}

/** 取该书源当前的相关规则（给 AI 看“现在写的是什么”）。 */
function rulesOf(sourceUrl: string): Record<string, unknown> | undefined {
  try {
    const s = sourceStore.all().find((x) => x.bookSourceUrl === sourceUrl)
    if (!s) return undefined
    const pick = (v: unknown) => (v && typeof v === 'object' && Object.keys(v as object).length ? v : undefined)
    return {
      searchUrl: s.searchUrl ?? undefined,
      ruleSearch: pick(s.ruleSearch),
      ruleBookInfo: pick(s.ruleBookInfo),
      ruleToc: pick(s.ruleToc),
      ruleContent: pick(s.ruleContent),
    }
  } catch {
    return undefined
  }
}

/** 注册一个待发送的上下文，返回它在内部数组里的下标（放进 data-aifix）。 */
export function registerAiFix(ctx: AiFixContext): number {
  pending.push(ctx)
  return pending.length - 1
}

/** 按钮 HTML：`data-aifix="<下标>"`，由 installAiFixHandler 统一代理点击。 */
export function aiFixButton(ctx: AiFixContext, label = '🤖 AI 修复源'): string {
  const idx = registerAiFix(ctx)
  return `<button class="ghost aifix" data-aifix="${idx}" title="让 AI 诊断并修好这个书源（在 pi-web-ui 的对话里自动开新对话）">${label}</button>`
}

/** 把请求发给插件视图（同源 iframe 的父窗口）。 */
export function requestAiFix(ctx: AiFixContext): boolean {
  if (!isEmbedded()) {
    statusReporter('这个功能（AI 修复/新建书源）要在 pi-web-ui 的插件视图里用（当前是单独打开的页面）')
    return false
  }
  const source = sourceStore.all().find((s) => s.bookSourceUrl === ctx.sourceUrl)
  const payload = {
    type: 'legado:ai-fix',
    context: {
      ...ctx,
      sourceName: ctx.sourceName ?? source?.bookSourceName,
      rules: rulesOf(ctx.sourceUrl),
    },
  }
  try {
    window.parent.postMessage(payload, window.location.origin)
    statusReporter('已把这本书的现场发给 AI，正在打开对话…')
    return true
  } catch (e) {
    statusReporter(`发送失败：${String(e)}`)
    return false
  }
}

/** 点击代理：任何带 data-aifix 的按钮都走这里（卡片重渲染也不用重新绑定）。 */
export function installAiFixHandler(): void {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-aifix]') as HTMLElement | null
    if (!el) return
    const idx = Number(el.dataset.aifix)
    const ctx = pending[idx]
    e.preventDefault()
    if (ctx) requestAiFix(ctx)
  })
}

/** 便捷：某书源「检测不通过」的上下文（检测页/书源页用）。 */
export function checkFixContext(
  bookSourceUrl: string,
  bookSourceName: string,
  reason: string,
  steps: { name: string; ok: boolean; ms: number; info?: string; error?: string }[] = [],
): AiFixContext {
  return {
    scene: 'check',
    sourceUrl: bookSourceUrl,
    sourceName: bookSourceName,
    reason,
    steps: steps.map((s) => `${s.ok ? '✔' : '✘'} ${s.name} ${s.ms}ms${s.info ? ` (${s.info})` : ''}${s.error ? ` — ${s.error}` : ''}`).join(' · '),
  }
}

/** 便捷：从书源对象直接造一个上下文（书源页手动修用）。 */
export function sourceFixContext(s: BookSource): AiFixContext {
  return { scene: 'source', sourceUrl: s.bookSourceUrl, sourceName: s.bookSourceName }
}

/** 便捷：只给一个网站链接——让 AI 现场抓页新建书源。 */
export function newSourceFixContext(url: string, note?: string): AiFixContext {
  return { scene: 'new', sourceUrl: url, error: note }
}
