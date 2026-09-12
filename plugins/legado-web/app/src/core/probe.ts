// 书源链路诊断（给 AI 修规则用）：按步跑「连通 → 搜索 → 详情 → 目录 → 正文」，
// 每步回报：请求过的地址/状态/页体大小（可选片段）、解析出的值、以及该步新增的规则失败明细。
//
// 与 check.ts 的区别：check 只给人话结论（可用/废源），probe 把“现场”摊开——
// AI 需要看到「某条规则 + 那一步的原始页体片段」才能改对规则。
//
// 用法：probeSource(source, { key, mode, bookUrl, step, dump, dumpMax })
//   mode: reach(只连通) | search(连通+搜索) | full(全链路，默认)
//   step: 只跑到某一步（search|info|toc|content），info/toc/content 需配合 bookUrl
//   dump: none | snippet(默认，截断片段) | full（页体全文，封顶 dumpMax）

import type { BookSource, Chapter, SearchBook } from '../types'
import { ruleErrors, ruleErrorStats, type RuleError } from './analyzeRule'
import { detectPageProblem } from './pageProblem'
import { fetchText, getProxyTransport, setProxyTransport, type ProxyResponse } from './request'
import { getBookInfo, getChapterList, getContent, isTextSource, searchBooks } from './webBook'

export type ProbeMode = 'reach' | 'search' | 'full'
export type ProbeStepName = 'reach' | 'search' | 'info' | 'toc' | 'content'
export type ProbeDump = 'none' | 'snippet' | 'full'

export interface ProbeRequest {
  /** 实际请求的地址（跟随重定向后） */
  url: string
  status?: number
  /** 页体字符数 */
  bytes?: number
  ms: number
  error?: string
  /** 页体片段/全文（dump≠none） */
  snippet?: string
}

export interface ProbeStep {
  name: ProbeStepName
  ok: boolean
  ms: number
  info?: string
  error?: string
  /** 这步发出的请求（含重定向后的真实地址、状态、页体大小） */
  requests: ProbeRequest[]
  /** 这步用到的书源规则原文（AI 改的就是这些字段） */
  rules?: Record<string, unknown>
  /** 这步新增的规则失败（规则原文 + 报错） */
  ruleErrors: RuleError[]
  /** 解析出的值（搜索：书目样本；详情：字段；目录：章节样本；正文：长度与前若干字） */
  value?: unknown
}

export interface ProbeResult {
  ok: boolean
  source: { url: string; name: string }
  mode: ProbeMode
  key: string
  conclusion: string
  ms: number
  /** 全链路累计新增的规则失败条数（含被静默跳过的规则） */
  ruleErrors: number
  steps: ProbeStep[]
}

export interface ProbeOptions {
  key?: string
  mode?: ProbeMode
  /** 直接给书籍地址（跳过搜索）/ 或配合 step 用 */
  bookUrl?: string
  /** 只跑到这一步（默认按 mode 跑全程） */
  step?: ProbeStepName
  dump?: ProbeDump
  /** dump 片段上限，默认 4000 字符 */
  dumpMax?: number
}

const STEP_ORDER: ProbeStepName[] = ['reach', 'search', 'info', 'toc', 'content']

function stepBudget(mode: ProbeMode, step?: ProbeStepName): number {
  if (step) return STEP_ORDER.indexOf(step) + 1
  if (mode === 'reach') return 1
  if (mode === 'search') return 2
  return STEP_ORDER.length
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（共 ${s.length} 字，已截断）` : s)

/** 可空字符串归一（工具/宿主传来的可能是 undefined）。 */
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 把 transport 包一层，记录这一步发过的请求（页体片段按 dump 决定）。
 *  records 由调用方传入：失败时也能拿到“到底请求了什么、返回了什么”。 */
async function recordRequests<T>(
  dump: ProbeDump,
  dumpMax: number,
  records: ProbeRequest[],
  fn: () => Promise<T>,
): Promise<T> {
  const prev = getProxyTransport()
  const base = prev ?? (async (target: string, opts) => (await fetchText(target, opts)) as ProxyResponse)
  setProxyTransport(async (target, opts) => {
    const t0 = Date.now()
    try {
      const res = await base(target, opts)
      const rec: ProbeRequest = { url: res.url || target, status: res.status, bytes: res.body.length, ms: Date.now() - t0 }
      if (dump !== 'none') rec.snippet = dump === 'full' ? truncate(res.body, dumpMax) : truncate(res.body, Math.min(dumpMax, 2000))
      records.push(rec)
      return res
    } catch (e) {
      records.push({ url: target, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  })
  try {
    return await fn()
  } finally {
    setProxyTransport(prev)
  }
}

/** 单个书源的链路诊断。 */
export async function probeSource(source: BookSource, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const key = (opts.key ?? '剑').trim() || '剑'
  const mode: ProbeMode = opts.mode ?? 'full'
  const dump: ProbeDump = opts.dump ?? 'snippet'
  const dumpMax = Math.max(200, Math.min(Number(opts.dumpMax ?? 4000) || 4000, 200_000))
  const budget = stepBudget(mode, opts.step)
  const t0 = Date.now()
  const steps: ProbeStep[] = []
  const errsBefore = ruleErrorStats.total

  const runStep = async <T>(
    name: ProbeStepName,
    rules: Record<string, unknown> | undefined,
    fn: () => Promise<T>,
    describe: (v: T) => { info?: string; value?: unknown } = () => ({}),
  ): Promise<T | undefined> => {
    const before = ruleErrors.length
    const stepT0 = Date.now()
    const records: ProbeRequest[] = []
    try {
      const value = await recordRequests(dump, dumpMax, records, fn)
      const { info, value: shown } = describe(value)
      steps.push({
        name,
        ok: true,
        ms: Date.now() - stepT0,
        info,
        requests: records,
        rules,
        ruleErrors: ruleErrors.slice(before),
        value: shown,
      })
      return value
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      steps.push({
        name,
        ok: false,
        ms: Date.now() - stepT0,
        error: raw,
        requests: records,
        rules,
        ruleErrors: ruleErrors.slice(before),
      })
      return undefined
    }
  }

  const finish = (conclusion: string, ok: boolean): ProbeResult => ({
    ok,
    source: { url: source.bookSourceUrl, name: source.bookSourceName },
    mode,
    key,
    conclusion,
    ms: Date.now() - t0,
    ruleErrors: ruleErrorStats.total - errsBefore,
    steps,
  })

  if (!isTextSource(source)) return finish('非文本源（bookSourceType≠0），本项目只支持文本源', false)
  if (source.enabled === false) return finish('书源已禁用（enabled=false）', false)

  // ---- 单步步实现（每步自己发请求，失败即返回 undefined） ------------------
  const stepReach = () =>
    runStep(
      'reach',
      { bookSourceUrl: source.bookSourceUrl, header: source.header ?? null, enabledCookieJar: source.enabledCookieJar ?? null },
      async () => {
        const res = await fetchText(source.bookSourceUrl, { charset: undefined })
        const problem = res.body.trim() ? detectPageProblem(res.body) : null
        if (res.status >= 400) throw new Error(`站点返回 HTTP ${res.status}`)
        if (problem) throw new Error(problem)
        return res
      },
      (res) => ({ info: `HTTP ${res.status}${res.body.trim() ? '' : '（空响应体，API 型源常见）'}` }),
    )

  const stepSearch = async (): Promise<SearchBook[] | undefined> => {
    if (!source.searchUrl?.trim()) {
      steps.push({
        name: 'search',
        ok: false,
        ms: 0,
        error: '书源没有搜索规则（searchUrl 为空）',
        requests: [],
        rules: { ruleSearch: source.ruleSearch ?? null },
        ruleErrors: [],
      })
      return undefined
    }
    return runStep(
      'search',
      { searchUrl: source.searchUrl, ruleSearch: source.ruleSearch ?? null },
      () => searchBooks(source, key, 1),
      (list) => ({ info: `${list.length} 本`, value: list.slice(0, 3) }),
    )
  }

  const stepInfo = (bookUrl: string) =>
    runStep(
      'info',
      { ruleBookInfo: source.ruleBookInfo ?? null, bookUrl },
      () => getBookInfo(source, bookUrl),
      (i) => ({ info: `${i.name ?? '(未解析出书名)'}${i.tocUrl ? ` → 目录 ${i.tocUrl}` : ''}`, value: i }),
    )

  const stepToc = (tocUrl: string) =>
    runStep(
      'toc',
      { ruleToc: source.ruleToc ?? null, tocUrl },
      () => getChapterList(source, tocUrl),
      (list: Chapter[]) => ({ info: `${list.length} 章`, value: list.slice(0, 5).map((c) => ({ name: c.name, url: c.url })) }),
    )

  const stepContent = (chapterUrl: string, chapterName = '') =>
    runStep(
      'content',
      { ruleContent: source.ruleContent ?? null, chapterUrl, chapterName },
      () => getContent(source, chapterUrl),
      (t) => ({ info: `${t.length} 字`, value: t.slice(0, 300) }),
    )

  const input = str(opts.bookUrl)

  // ---- 指定步骤：只跑这一步（用 bookUrl 当输入，不跑前置） -------------------
  if (opts.step) {
    if (opts.step === 'reach') {
      if (!(await stepReach())) return finish(`连通性失败：${steps.at(-1)?.error ?? ''}`, false)
      return finish('连通正常', true)
    }
    if (opts.step === 'search') {
      const list = await stepSearch()
      if (!list) return finish(`搜索失败：${steps.at(-1)?.error ?? ''}`, false)
      return finish(list.length ? `搜索正常（${list.length} 本）` : `搜索无结果（关键词“${key}”）`, list.length > 0)
    }
    if (!input) return finish(`step=${opts.step} 需要 bookUrl（${opts.step === 'info' ? '书页' : opts.step === 'toc' ? '目录页' : '章节页'}地址）`, false)
    if (opts.step === 'info') {
      const info = await stepInfo(input)
      if (!info) return finish(`详情失败：${steps.at(-1)?.error ?? ''}`, false)
      return finish(`详情正常（${info.name ?? '未解析出书名'} → ${info.tocUrl}）`, true)
    }
    if (opts.step === 'toc') {
      const chapters = await stepToc(input)
      if (!chapters) return finish(`目录失败：${steps.at(-1)?.error ?? ''}`, false)
      return finish(chapters.length ? `目录正常（${chapters.length} 章）` : '目录为空（chapterList/chapterName/chapterUrl 未解析出章节）', chapters.length > 0)
    }
    const text = await stepContent(input)
    if (!text) return finish(`正文失败：${steps.at(-1)?.error ?? ''}`, false)
    return finish(`正文正常（${text.length} 字）`, true)
  }

  // ---- 全链路（按 mode 决定跑多深） ----------------------------------------
  if (!(await stepReach())) return finish(`连通性失败：${steps.at(-1)?.error ?? ''}`, false)
  if (budget <= 1) return finish('连通正常（只跑了连通性）', true)

  const books = await stepSearch()
  if (!books) return finish(`搜索失败：${steps.at(-1)?.error ?? ''}`, false)
  if (!books.length) {
    const used = ruleErrorStats.total - errsBefore
    return finish(`搜索无结果（关键词“${key}”）${used ? `，另有 ${used} 条规则失败被跳过` : ''}`, false)
  }
  if (budget <= 2) return finish(`搜索正常（${books.length} 本）`, true)

  const bookUrl = (input || books[0]?.bookUrl || '').trim()
  if (!bookUrl) return finish('搜索结果没有书籍链接（ruleSearch.bookUrl 未解析出地址）', false)
  const info = await stepInfo(bookUrl)
  if (!info) return finish(`详情失败：${steps.at(-1)?.error ?? ''}`, false)
  if (!info.tocUrl?.trim()) return finish('详情没有解析出目录地址（ruleBookInfo.tocUrl 为空）', false)
  if (budget <= 3) return finish(`详情正常（${info.name ?? '未解析出书名'}）`, true)

  const chapters = await stepToc(info.tocUrl)
  if (!chapters) return finish(`目录失败：${steps.at(-1)?.error ?? ''}`, false)
  if (!chapters.length) return finish('目录为空（ruleToc.chapterList/chapterName/chapterUrl 未解析出章节）', false)
  if (budget <= 4) return finish(`目录正常（${chapters.length} 章）`, true)

  const target = chapters.find((c) => c.url && !/卷/.test(c.name || '')) ?? chapters[0]!
  const text = await stepContent(target.url, target.name)
  if (!text) return finish(`正文失败：${steps.at(-1)?.error ?? ''}`, false)

  return finish(`完整链路正常（搜索 ${books.length} 本 / 目录 ${chapters.length} 章 / 正文 ${text.length} 字）`, true)
}
