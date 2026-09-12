// 书源检测（对标原版“书源检测”）：分步体检并给出人话结论，让“哪些源能用/为什么不能用”一眼可见。
//
// 检测档位：
//   reach  仅连通性（快）：能否访问书源主站，是否人机验证/被墙/编码异常
//   search 连通 + 搜索：能否搜出结果、数量
//   full   连通 + 搜索 + 详情 + 目录 + 正文：完整链路
//
// 结果分类（给用户看的 reason）都是人话，例如：
//   网络不可达（本站/代理到目标站不通，DNS 黑洞或被墙）
//   站点人机验证（Cloudflare/盾）
//   站点返回 403
//   搜索规则不兼容（N 条规则失败）
//   搜索无结果

import type { BookSource } from '../types'
import { ruleErrorStats } from './analyzeRule'
import { classifyError, detectPageProblem, isNetworkError } from './pageProblem'
import { fetchText } from './request'
import { getBookInfo, getChapterList, getContent, isTextSource, searchBooks } from './webBook'

export type CheckMode = 'reach' | 'search' | 'full'

export { detectPageProblem }

export interface CheckStep {
  name: string
  ok: boolean
  ms: number
  info?: string
  error?: string
}

export interface CheckResult {
  bookSourceUrl: string
  bookSourceName: string
  ok: boolean
  /** ok=可用；dead=废源（站点挂了/被墙/盾页/无搜索规则），可自动隐藏；suspect=可疑（搜索无结果/规则不兼容） */
  kind: 'ok' | 'dead' | 'suspect'
  /** 主要结论（人话，失败时为用户最该看的那个原因） */
  reason: string
  steps: CheckStep[]
  count?: number
  tocCount?: number
  contentLen?: number
  ruleErrors: number
  ms: number
  time: number
}


/** 网络错误分类 */
async function step<T>(name: string, fn: () => Promise<T>): Promise<{ step: CheckStep; value?: T }> {
  const t0 = Date.now()
  try {
    const value = await fn()
    return { step: { name, ok: true, ms: Date.now() - t0 }, value }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const isNet = isNetworkError(raw)
    return { step: { name, ok: false, ms: Date.now() - t0, error: isNet ? classifyError(raw) : raw } }
  }
}

export interface CheckOptions {
  key?: string
  mode?: CheckMode
  /** 单源整体超时（毫秒），默认 20s */
  timeoutMs?: number
}

/** 检测单个书源 */
export async function checkSource(source: BookSource, opts: CheckOptions = {}): Promise<CheckResult> {
  const key = (opts.key ?? '剑').trim() || '剑'
  const mode: CheckMode = opts.mode ?? 'search'
  const t0 = Date.now()
  const errBase = ruleErrorStats.total
  const steps: CheckStep[] = []
  const result: CheckResult = {
    bookSourceUrl: source.bookSourceUrl,
    bookSourceName: source.bookSourceName,
    ok: false,
    kind: 'suspect',
    reason: '',
    steps,
    ruleErrors: 0,
    ms: 0,
    time: Date.now(),
  }

  /**
   * 废源判定（“书看不了也算”）：
   *  站点级：连不上/被墙/盾页/HTTP 错误/无搜索规则/非文本源。
   *  完整链路（mode=full）：搜索出现规则不兼容、或详情/目录/正文任一环节拿不到内容，
   *  意味着这个源实际上读不了书，也算废源。
   */
  const isDeadReason = (reason: string): boolean => {
    if (/网络不可达|证书错误|站点返回 HTTP|人机验证|没有搜索规则|非文本源|已禁用|返回内容为空/.test(reason)) return true
    if (mode === 'full') {
      if (/规则不兼容/.test(reason)) return true
      if (/详情规则未解析|目录为空|正文规则未解析|正文过短|正文需要 WebJS|正文页异常|不是正文而是站点提示|正文页不是预期格式/.test(reason)) return true
    }
    return false
  }

  const finish = (reason: string, ok: boolean): CheckResult => {
    result.ok = ok
    result.kind = ok ? 'ok' : isDeadReason(reason) ? 'dead' : 'suspect'
    result.reason = reason
    result.ruleErrors = ruleErrorStats.total - errBase
    result.ms = Date.now() - t0
    result.time = Date.now()
    return result
  }

  if (!isTextSource(source)) {
    return finish('非文本源（音频/图片/视频），本项目不支持', false)
  }
  if (source.enabled === false) {
    return finish('书源已禁用', false)
  }

  // 1. 连通性（只看能否请求到与是否盾页；空响应体不算失败，API 型源根路径常为空）
  const reachOnce = async () => {
    const res = await fetchText(source.bookSourceUrl, { charset: undefined })
    const problem = res.body.trim().length > 0 ? detectPageProblem(res.body) : null
    if (res.status >= 400) throw new Error(`站点返回 HTTP ${res.status}`)
    if (problem) throw new Error(problem)
    return res.body.trim().length > 0 ? `HTTP ${res.status}` : `HTTP ${res.status}（空响应体，API 型源常见）`
  }
  let reach = await step('连通性', reachOnce)
  // 超时在并发下常见：重试一次，两次都超时才算废源（避免误隐藏）
  if (!reach.step.ok && /连接超时/.test(reach.step.error ?? '')) {
    await new Promise((r) => setTimeout(r, 600))
    reach = await step('连通性(重试)', reachOnce)
    reach.step.name = '连通性'
  }
  steps.push(reach.step)
  if (!reach.step.ok) return finish(reach.step.error ?? '连通性失败', false)
  if (typeof reach.value === 'string') reach.step.info = reach.value

  if (mode === 'reach') return finish('连通正常', true)

  // 2. 搜索
  if (!source.searchUrl?.trim()) {
    steps.push({ name: '搜索', ok: false, ms: 0, error: '书源没有搜索规则（searchUrl 为空）' })
    return finish('书源没有搜索规则', false)
  }
  const search = await step('搜索', async () => {
    const list = await searchBooks(source, key, 1)
    return list
  })
  steps.push(search.step)
  if (!search.step.ok) return finish(search.step.error ?? '搜索失败', false)
  const list = search.value ?? []
  result.count = list.length
  search.step.info = `${list.length} 本`
  if (!list.length) {
    // 分不清“搜索规则不兼容”还是“就是没结果/盾页”，用规则失败数辅助判断
    const used = ruleErrorStats.total - errBase
    if (used > 0) {
      const dead = mode === 'full' ? '；完整检测判定为废源' : ''
      return finish(`搜索无结果，且有 ${used} 条规则不兼容被跳过（可能规则语法不支持）${dead}`, false)
    }
    return finish(`搜索无结果（关键词“${key}”可能确实没有；或站点盾页/需登录/JS 渲染，本项目不支持 WebJS）`, false)
  }

  if (mode === 'search') return finish(`搜索正常（${list.length} 本）`, true)

  // 3. 详情
  const book = list[0]!
  const info = await step('详情', async () => {
    if (!book.bookUrl) throw new Error('搜索结果没有书籍链接（bookUrl 规则未解析出）')
    const i = await getBookInfo(source, book.bookUrl)
    if (!i.name && !i.tocUrl) throw new Error('详情规则未解析出书名/目录地址')
    return i
  })
  steps.push(info.step)
  if (!info.step.ok) return finish(info.step.error ?? '详情失败', false)
  const bookInfo = info.value!
  info.step.info = bookInfo.name ?? ''

  // 4. 目录
  const toc = await step('目录', async () => {
    const chapters = await getChapterList(source, bookInfo.tocUrl)
    if (!chapters.length) throw new Error('目录为空（章节规则未解析出）')
    return chapters
  })
  steps.push(toc.step)
  if (!toc.step.ok) return finish(toc.step.error ?? '目录失败', false)
  const chapters = toc.value!
  result.tocCount = chapters.length
  toc.step.info = `${chapters.length} 章`

  // 5. 正文
  const target = chapters.find((c) => c.url && !/卷/.test(c.name || '')) ?? chapters[0]!
  const content = await step('正文', async () => {
    const text = await getContent(source, target.url)
    if (text.length < 30) throw new Error(`正文过短（${text.length} 字，正文规则可能不对）`)
    return text
  })
  steps.push(content.step)
  if (!content.step.ok) return finish(content.step.error ?? '正文失败', false)
  result.contentLen = content.value!.length
  content.step.info = `${content.value!.length} 字`

  const used = ruleErrorStats.total - errBase
  return finish(`完整链路正常（搜索 ${list.length} 本 / 目录 ${chapters.length} 章 / 正文 ${result.contentLen} 字）${used ? `；另有 ${used} 条规则不兼容` : ''}`, true)
}
