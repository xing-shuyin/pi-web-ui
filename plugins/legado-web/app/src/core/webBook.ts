// WebBook 精简移植（对应 Android model/webBook/*）：搜索/发现/详情/目录/正文。
// 仅文本源（bookSourceType 0 / 未填）。

import type { BookInfo, BookSource, Chapter, SearchBook } from '../types'
import { absUrl, evalElement, evalFirst, evalItemList, type RuleCtx } from './analyzeRule'
import { parseCustomUrl } from './analyzeUrl'
import { applyTemplate, getScope } from './js'
import { detectContentNotice, detectPageProblem } from './pageProblem'
import { fetchText, parseHeader } from './request'

/** HTML 正文转纯文本（<p>/<br> 换行，去标签，解常见实体） */
export function htmlToText(html: string): string {
  let s = html.replace(/<(br|p|div|tr|li|h\d|ul|ol|table)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = s.replace(/&(lt|gt|quot|apos|nbsp);|&#(\d+);|&#x([0-9a-fA-F]+);/gi, (_m, name?: string, dec?: string, hex?: string) => {
    if (dec) {
      try {
        return String.fromCharCode(parseInt(dec, 10))
      } catch {
        return ''
      }
    }
    if (hex) {
      try {
        return String.fromCharCode(parseInt(hex, 16))
      } catch {
        return ''
      }
    }
    switch ((name ?? '').toLowerCase()) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return ' '
      default: return ''
    }
  })
  s = s.replace(/&amp;/gi, '&')
  return s.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}

export function isTextSource(s: BookSource): boolean {
  const t = (s.bookSourceType ?? 0) as number
  return t === 0
}

function ctxOf(source: BookSource, baseUrl: string, extra: Partial<RuleCtx> = {}): RuleCtx {
  return {
    baseUrl,
    key: '',
    page: 1,
    scope: getScope(source.bookSourceUrl),
    source,
    // book 基础绑定（origin 等，对标 SearchBook/Book 的来源字段）
    book: { origin: source.bookSourceUrl, originName: source.bookSourceName },
    ...extra,
  }
}

function mergeHeaders(source: BookSource, extra?: Record<string, string>) {
  return { ...parseHeader(source.header as string | undefined), ...(extra ?? {}) }
}

export async function searchBooks(source: BookSource, key: string, page = 1): Promise<SearchBook[]> {
  if (!isTextSource(source)) throw new Error('仅支持文本源（bookSourceType=0）')
  if (!source.searchUrl?.trim()) throw new Error('该书源没有搜索 URL')
  const scope = getScope(source.bookSourceUrl)
  const { url, options } = parseCustomUrl(source.searchUrl, source.bookSourceUrl, key, page, scope, source)
  const res = await fetchText(url, { ...options, headers: mergeHeaders(source, options.headers) })
  const ctx = ctxOf(source, res.url, { key, page })
  const rule = source.ruleSearch
  const items = evalItemList(res.body, rule?.bookList, ctx)
  return items.map((item) => {
    const name = evalFirst(item, rule?.name, ctx)
    const author = evalFirst(item, rule?.author, ctx)
    const bookUrl = absUrl(res.url, evalFirst(item, rule?.bookUrl, ctx))
    return {
      bookSourceUrl: source.bookSourceUrl,
      bookSourceName: source.bookSourceName,
      name,
      author,
      kind: evalFirst(item, rule?.kind, ctx) || undefined,
      intro: evalFirst(item, rule?.intro, ctx) || undefined,
      coverUrl: evalFirst(item, rule?.coverUrl, ctx) || undefined,
      wordCount: evalFirst(item, rule?.wordCount, ctx) || undefined,
      lastChapter: evalFirst(item, rule?.lastChapter, ctx) || undefined,
      bookUrl,
    } satisfies SearchBook
  }).filter((b) => b.bookUrl)
}

export async function discoverBooks(source: BookSource, exploreUrl?: string, page = 1): Promise<SearchBook[]> {
  const raw = exploreUrl ?? source.exploreUrl
  if (!raw?.trim()) throw new Error('该书源没有发现 URL')
  const { url, options } = parseCustomUrl(raw, source.bookSourceUrl, '', page, getScope(source.bookSourceUrl), source)
  const res = await fetchText(url, { ...options, headers: mergeHeaders(source, options.headers) })
  const ctx = ctxOf(source, res.url, { page })
  // 对标原版：发现规则为空时回退用搜索规则（很多源只写 exploreUrl 不写 ruleExplore）
  const ex = source.ruleExplore as (typeof source.ruleExplore & { bookList?: string }) | undefined
  const rule = ex?.bookList?.trim() ? ex : (source.ruleSearch as typeof source.ruleExplore)
  const items = evalItemList(res.body, rule?.bookList, ctx)
  return items.map((item) => ({
    bookSourceUrl: source.bookSourceUrl,
    bookSourceName: source.bookSourceName,
    name: evalFirst(item, rule?.name, ctx),
    author: evalFirst(item, rule?.author, ctx),
    kind: evalFirst(item, rule?.kind, ctx) || undefined,
    intro: evalFirst(item, rule?.intro, ctx) || undefined,
    coverUrl: evalFirst(item, rule?.coverUrl, ctx) || undefined,
    bookUrl: absUrl(res.url, evalFirst(item, rule?.bookUrl, ctx)),
  })).filter((b) => b.bookUrl)
}

export async function getBookInfo(source: BookSource, bookUrl: string): Promise<BookInfo> {
  if (!bookUrl?.trim()) throw new Error('书籍链接为空（书源 bookUrl 规则未解析出地址）')
  const scope = getScope(source.bookSourceUrl)
  const { url, options } = parseCustomUrl(applyTemplate(bookUrl, { baseUrl: source.bookSourceUrl }, scope), source.bookSourceUrl, '', 1, scope, source)
  const res = await fetchText(url, { ...options, headers: mergeHeaders(source, options.headers) })
  const ctx = ctxOf(source, res.url)
  const rule = source.ruleBookInfo
  if (!rule) return { tocUrl: res.url }
  // init 重定根（对标 BookInfo.kt：init 规则先执行，后续规则在其结果上求值）
  let infoBody = res.body
  if (rule.init?.trim()) {
    const rooted = evalElement(res.body, rule.init, ctx)
    if (rooted) infoBody = rooted
  }
  const tocRel = evalFirst(infoBody, rule.tocUrl, ctx)
  return {
    name: evalFirst(infoBody, rule.name, ctx) || undefined,
    author: evalFirst(infoBody, rule.author, ctx) || undefined,
    kind: evalFirst(infoBody, rule.kind, ctx) || undefined,
    intro: evalFirst(infoBody, rule.intro, ctx) || undefined,
    coverUrl: evalFirst(infoBody, rule.coverUrl, ctx) || undefined,
    lastChapter: evalFirst(infoBody, rule.lastChapter, ctx) || undefined,
    wordCount: evalFirst(infoBody, rule.wordCount, ctx) || undefined,
    tocUrl: tocRel ? absUrl(res.url, tocRel) : res.url,
  }
}

export async function getChapterList(source: BookSource, tocUrl: string): Promise<Chapter[]> {
  const rule = source.ruleToc
  const out: Chapter[] = []
  let next: string | undefined = tocUrl
  const seen = new Set<string>()
  const scope = getScope(source.bookSourceUrl)
  while (next && !seen.has(next)) {
    seen.add(next)
    const { url, options } = parseCustomUrl(next, source.bookSourceUrl, '', 1, scope, source)
    const res = await fetchText(url, { ...options, headers: mergeHeaders(source, options.headers) })
    const ctx = ctxOf(source, res.url)
    const items = evalItemList(res.body, rule?.chapterList, ctx)
    for (const item of items) {
      const name = evalFirst(item, rule?.chapterName, ctx)
      const href = absUrl(res.url, evalFirst(item, rule?.chapterUrl, ctx))
      if (!name && !href) continue
      out.push({ name, url: href || res.url })
    }
    const n = rule?.nextTocUrl ? evalFirst(res.body, rule.nextTocUrl, ctx) : ''
    next = n ? absUrl(res.url, n) : undefined
    if (out.length > 5000) break // 防止翻页死循环
  }
  return out
}

export async function getContent(source: BookSource, contentUrl: string): Promise<string> {
  const rule = source.ruleContent
  if (!rule?.content?.trim()) {
    throw new Error('书源没有正文规则（ruleContent.content 为空），只能换源')
  }
  if (rule.webJs?.trim()) {
    // 正文依赖 WebJS 渲染（本项目不支持），后面仍会试一次，失败时给明确提示
    console.info(`[正文] ${source.bookSourceName} 正文规则含 webJs（需浏览器渲染），本项目不支持，可能取不到正文`)
  }
  let next: string | undefined = contentUrl
  const parts: string[] = []
  const seen = new Set<string>()
  const scope = getScope(source.bookSourceUrl)
  let lastBody = ''
  let lastUrl = contentUrl
  while (next && !seen.has(next)) {
    seen.add(next)
    const { url, options } = parseCustomUrl(next, source.bookSourceUrl, '', 1, scope, source)
    const res = await fetchText(url, { ...options, headers: mergeHeaders(source, options.headers) })
    lastBody = res.body
    lastUrl = res.url
    const ctx = ctxOf(source, res.url)
    const text = evalFirst(res.body, rule.content, ctx)
    if (text) parts.push(text)
    const n = rule.nextContentUrl ? evalFirst(res.body, rule.nextContentUrl, ctx) : ''
    next = n ? absUrl(res.url, n) : undefined
    if (parts.join('\n').length > 200000) break
  }
  const out = htmlToText(parts.join('\n')).replace(/\n{3,}/g, '\n\n').trim()
  if (!out) {
    // 空正文必须说出为什么，不能白页（用户看到空页无从下手）
    console.info(`[正文为空] 源=${source.bookSourceName} url=${lastUrl} 页体长度=${lastBody.length} 规则=${rule.content}`)
    const problem = detectPageProblem(lastBody)
    if (problem) throw new Error(`正文页异常：${problem}（换源试试）`)
    if (rule.webJs?.trim()) throw new Error('正文需要 WebJS 渲染，本项目不支持（换源试试）')
    if (rule.sourceRegex?.trim() && !lastBody.includes(rule.sourceRegex.slice(0, 20))) {
      throw new Error('正文页不是预期格式（sourceRegex 未命中，可能需要登录/Cookie，换源试试）')
    }
    throw new Error(
      `正文规则未解析出内容（规则：${rule.content.slice(0, 60)}）——可能规则不兼容/需登录，按 F12 搜 [规则失败] 看详情，或换源`,
    )
  }
  // 内容“非正文”识别：站点提示/报错（如“当前版本过低，请升级”）——表面有内容，实际读不了
  const notice = detectContentNotice(out)
  if (notice) {
    console.info(`[正文非正文] 源=${source.bookSourceName} url=${lastUrl} 判定=${notice} 内容=${out.slice(0, 80)}`)
    throw new Error(`该源返回的不是正文而是站点提示：${notice}（源已失效，建议换源）`)
  }
  return out
}
