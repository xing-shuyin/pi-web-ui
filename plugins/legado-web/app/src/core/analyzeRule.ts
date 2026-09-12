// AnalyzeRule 完整移植（对应 Android AnalyzeRule/AnalyzeByJSoup/XPath/JSonPath/Regex + RuleAnalyzer）。
//
// 覆盖的书源语法：
//   选择器：CSS（默认）/ XPath（/ 或 ( 开头）/ JSONPath（$ 开头）/ 纯正则（无选择器只有 ##…）
//   后缀：CSS 用 selector@attr（text/html/href/src/任意属性）；XPath 整条进引擎
//         （//a/@href、/text() 原生支持，//@text//@html 为兼容写法）；
//         JSON 不拆后缀（过滤器里有 @）
//   组合：||（首个非空胜出）/ &&（拼接）/ %%（拉链），分隔符感知 []/()/{} /引号嵌套
//   模板：@put:{json} 提变量并移除，@get:{k} / {{expr}} 代换后整体返回（详情 URL 类规则）
//   前缀：@@/@CSS: 强制 CSS，@XPath: 强制 XPath，@Json: 强制 JSON
//   JS：@js: / <js>...</js> 原生执行，作用域对标原版 bindings
//   兼容：裸 :N 位置伪类按 jQuery 语义试译为 :eq(N)（命中才采用并记日志）
//
// 铁律：任何规则求值都不抛错——坏规则记入 ruleErrors（console 搜 [规则失败]），
// 返回空后由 || 备选 / 默认值兜底，不拖死整本详情或整源搜索。

import * as cheerio from 'cheerio'
import { JSONPath } from 'jsonpath-plus'
import xpath from 'xpath'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { applyTemplate, evalJsRule, isJsRule, setJavaRuleHooks, type JsContext, type Scope } from './js'

export interface RuleCtx extends JsContext {
  baseUrl: string
  scope: Scope
}

export interface RuleError {
  source: string
  rule: string
  error: string
  time: number
}

/** 最近 100 条规则失败记录（UI 可展示数量，console 有全文） */
export const ruleErrors: RuleError[] = []

/** 规则失败总计数（不受 ruleErrors 上限影响，供“检测”页统计不兼容规则数） */
export const ruleErrorStats = { total: 0 }

function warnRule(ctx: RuleCtx | undefined, kind: string, rule: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  const source = (ctx?.source as { bookSourceName?: string } | undefined)?.bookSourceName ?? ''
  ruleErrorStats.total++
  if (ruleErrors.length < 100) {
    ruleErrors.push({ source, rule: rule.slice(0, 200), error: msg.slice(0, 200), time: Date.now() })
  }
  console.warn(`[规则失败][${kind}]${source ? `[${source}]` : ''} ${rule.slice(0, 160)} || ${msg.slice(0, 160)}`)
}

// ---------- 顶层分隔符（感知 []/()/{} 与引号，原版 RuleAnalyzer 的简化版） ----------

function findTopLevelSep(s: string, seps: string[]): { sep: string; index: number } | null {
  let bDepth = 0
  let pDepth = 0
  let cDepth = 0
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') bDepth++
    else if (c === ']') bDepth = Math.max(0, bDepth - 1)
    else if (c === '(') pDepth++
    else if (c === ')') pDepth = Math.max(0, pDepth - 1)
    else if (c === '{') cDepth++
    else if (c === '}') cDepth = Math.max(0, cDepth - 1)
    if (bDepth === 0 && pDepth === 0 && cDepth === 0) {
      for (const sep of seps) {
        if (s.startsWith(sep, i)) return { sep, index: i }
      }
    }
  }
  return null
}

/** 按最早出现的顶层分隔符切分；无分隔符返回 sep=null */
function splitTopAware(s: string, seps: string[]): { parts: string[]; sep: string | null } {
  const found = findTopLevelSep(s, seps)
  if (!found) return { parts: [s], sep: null }
  const { sep } = found
  const parts: string[] = []
  let bDepth = 0
  let pDepth = 0
  let cDepth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') bDepth++
    else if (c === ']') bDepth = Math.max(0, bDepth - 1)
    else if (c === '(') pDepth++
    else if (c === ')') pDepth = Math.max(0, pDepth - 1)
    else if (c === '{') cDepth++
    else if (c === '}') cDepth = Math.max(0, cDepth - 1)
    if (bDepth === 0 && pDepth === 0 && cDepth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(start, i))
      start = i + sep.length
      i += sep.length - 1
    }
  }
  parts.push(s.slice(start))
  return { parts: parts.map((x) => x.trim()).filter((x) => x !== ''), sep }
}

// ---------- 规则片段解析 ----------

function splitRegexSuffix(rule: string): { main: string; pattern?: string; replacement?: string; replaceFirst?: boolean } {
  const parts = rule.split('##')
  if (parts.length === 1) return { main: rule }
  return { main: parts[0] ?? '', pattern: parts[1], replacement: parts[2], replaceFirst: parts.length > 3 }
}

export type ForcedMode = 'css' | 'xpath' | 'json' | null

/** 宽松 JSON 对象解析（对标原版 GSON 宽松模式）：
 *  源里 @put 常写成非规范 JSON，如 {xid:x_id}（键/值都没引号），严格 JSON.parse 会失败。
 *  这里先把裸键、裸值、单引号补成合法 JSON 再解析。 */
function parseLooseJsonObject(text: string): Record<string, unknown> | null {
  const s = text.trim()
  try {
    const v = JSON.parse(s) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* 走宽松路径 */
  }
  try {
    let t = s
    // 1) 单引号字符串 → 双引号
    t = t.replace(/'([^']*)'/g, (_m, inner: string) => `"${String(inner).replace(/"/g, '\\"')}"`)
    // 2) 裸键 → "key"
    t = t.replace(/([{,[]\s*)([A-Za-z_$][\w$.-]*)(\s*:)/g, '$1"$2"$3')
    // 3) 裸值 → "value"（排除数字/true/false/null/已引号/嵌套对象数组）
    t = t.replace(/(:\s*)([^"'\s{}\][,][^,}]*?)(\s*[,}])/g, (m, pre: string, val: string, post: string) => {
      const v = val.trim()
      if (v === '' || /^-?\d+(\.\d+)?$/.test(v) || /^(true|false|null)$/.test(v) || v.startsWith('"') || v.startsWith('{') || v.startsWith('[')) {
        return m
      }
      return `${pre}"${v.replace(/"/g, '\\"')}"${post}`
    })
    const v = JSON.parse(t) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* 实在解析不了就放弃 */
  }
  return null
}

/** @put:{json}：值逐条求值后存入 scope，并从规则中移除（对标原版 splitPutRule+putRule） */
function extractPutRules(body: string, rule: string, ctx: RuleCtx): string {
  return rule.replace(/@put:(\{[^}]*?\})/gi, (_m, json: string) => {
    try {
      const obj = parseLooseJsonObject(json)
      if (!obj) return ''
      for (const [k, v] of Object.entries(obj)) {
        ctx.scope.put(k, evalFirst(body, String(v), ctx))
      }
    } catch {
      /* 忽略该段 */
    }
    return ''
  })
}

/** @get:{key} + {{expr}} 代换（对标原版 makeUpRule）。
 *  {{}} 内以 $./$[/@///(/<js>/@js: 开头的视为嵌套规则，用当前 content 求值
 *  （如 {{$.book_id}}），其余按 JS 表达式求值。
 *  注意：嵌套求值的 result 必须是正在解析的 content（item/页体），而非 ctx.result。 */
function substituteGets(rule: string, ctx: RuleCtx, content?: unknown): string {
  const r = rule.replace(/@get:\{([^}]*)\}/gi, (_m, key: string) => ctx.scope.get(key.trim()))
  const c = content ?? ctx.result
  return applyTemplate(r, { ...ctx, result: c }, ctx.scope, (expr, result) => {
    const e = expr.trim()
    if (/^(\$\.|@|<js>|@js:|\/\/|@@|@css:|@xpath:|@json:|\()/i.test(e)) {
      const b = typeof result === 'string' ? result : JSON.stringify(result ?? '')
      return evalFirst(b, e, ctx)
    }
    return undefined
  })
}

/** 切分 <js>...</js> / @js:...（@js: 贪婪到规则末尾，对标原版 JS_PATTERN）。
 *  js 段是原子的：里面的 ||/&& 不再切分（如 @js:result||"default"）。 */
function splitJsSegments(rule: string): Array<{ type: 'text' | 'js'; code: string }> {
  const segs: Array<{ type: 'text' | 'js'; code: string }> = []
  const re = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)$/gi
  let last = 0
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(rule)) !== null) {
    if (m.index > last) segs.push({ type: 'text', code: rule.slice(last, m.index) })
    segs.push({ type: 'js', code: m[1] ?? m[2] ?? '' })
    last = m.index + m[0].length
    if (m[0].length === 0) break
  }
  if (last < rule.length) segs.push({ type: 'text', code: rule.slice(last) })
  return segs.filter((s) => s.type === 'js' || s.code.trim() !== '')
}
function isTemplateRule(rule: string): boolean {
  const idx = rule.search(/@get:\{|{{/i)
  if (idx < 0) return false
  return !rule.slice(0, idx).includes('##')
}

/** 显式模式前缀 @@/@CSS:/@XPath:/@Json:（对标原版） */
function stripModePrefix(rule: string): { sel: string; forced: ForcedMode } {
  const r = rule.trim()
  if (r.startsWith('@@')) return { sel: r.slice(2), forced: 'css' }
  if (/^@css:/i.test(r)) return { sel: r.slice(5), forced: 'css' }
  if (/^@xpath:/i.test(r)) return { sel: r.slice(7), forced: 'xpath' }
  if (/^@json:/i.test(r)) return { sel: r.slice(6), forced: 'json' }
  return { sel: r, forced: null }
}

/** <webjs> 不支持：记日志后返回空（避免按 CSS 解析抛错） */
function isWebJs(rule: string): boolean {
  const r = rule.trim().toLowerCase()
  return r.startsWith('<webjs>') || r.startsWith('@webjs:')
}

// ---------- :N 裸位置伪类兼容（jQuery 语义试译） ----------

/** 仅在 []/()/引号深度为 0 处把 :N 翻成 :eq(N)，返回是否改动 */
function translateNumericPseudo(sel: string): { sel: string; changed: boolean } {
  let out = ''
  let changed = false
  let bDepth = 0
  let pDepth = 0
  let quote: string | null = null
  let i = 0
  while (i < sel.length) {
    const c = sel[i]!
    if (quote) {
      out += c
      if (c === '\\') {
        out += sel[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '\\') {
      out += sel.slice(i, i + 2)
      i += 2
      continue
    }
    if (c === '[') bDepth++
    else if (c === ']') bDepth = Math.max(0, bDepth - 1)
    else if (c === '(') pDepth++
    else if (c === ')') pDepth = Math.max(0, pDepth - 1)
    if (c === ':' && bDepth === 0 && pDepth === 0 && sel[i - 1] !== ':' && sel[i - 1] !== '\\') {
      const m = /^:(\d+)(?![\w\-(])/.exec(sel.slice(i))
      if (m) {
        out += `:eq(${m[1]})`
        i += m[0].length
        changed = true
        continue
      }
    }
    out += c
    i++
  }
  return { sel: out, changed }
}

// ---------- 各模式求值 ----------

function applyRegex(values: string[], pattern?: string, replacement?: string, replaceFirst = false): string[] {
  if (!pattern) return values
  let re: RegExp | null = null
  try {
    re = new RegExp(pattern, replaceFirst ? '' : 'gs')
  } catch {
    re = null
  }
  const out: string[] = []
  for (const v of values) {
    if (!re) {
      // 非法正则按字面字符串替换（对标原版）
      out.push(v.split(pattern).join(replacement ?? ''))
      continue
    }
    if (replacement === undefined) {
      // ##pattern（无替换）：删除所有匹配（对标原版 result.replace(regex, "")）
      out.push(v.replace(re, ''))
      continue
    }
    if (replaceFirst) {
      // ##match##replace###：取首个匹配并替换一次
      re.lastIndex = 0
      const m = re.exec(v)
      if (!m) {
        out.push(replacement)
        continue
      }
      try {
        out.push(m[0].replace(new RegExp(pattern, ''), replacement))
      } catch {
        out.push(replacement)
      }
      continue
    }
    out.push(v.replace(re, replacement))
  }
  return out
}

function isJsonText(t: string): boolean {
  const s = t.trim()
  return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))
}

/** JSONPath 归一：无 $ 前缀的补成 $.xxx（JSON 模式下裸名就是 jsonpath，对标原版） */
function normalizeJsonPath(rule: string): string {
  const r = rule.trim()
  return r.startsWith('$') ? r : `$.${r}`
}

/**
 * 规则模式判定（对标 AnalyzeRule.SourceRule.init）：
 *   显式前缀 > $ 开头=JSON > 内容本身是 JSON=全按 JSONPath > / 或 ( 开头=XPath > 默认 CSS。
 * 关键：内容是 JSON 时一切规则按 JSONPath，所以 API 源能写 x_id 而不是 $.x_id。
 */
function decideMode(body: string, rule: string, forced: ForcedMode): 'json' | 'xpath' | 'css' {
  if (forced) return forced
  const r = rule.trim()
  if (r.startsWith('$')) return 'json'
  if (isJsonText(body)) return 'json'
  if (r.startsWith('/') || r.startsWith('(')) return 'xpath'
  return 'css'
}

/** cheerio 选择器（含 :N 兼容试译），失败抛给上层记日志 */
/** 顶层切分（保留空段，如 @onclick → ['', 'onclick']），感知 []/()/{} /引号 */
function splitKeepEmpty(s: string, seps: string[]): string[] {
  const parts: string[] = []
  let bDepth = 0
  let pDepth = 0
  let cDepth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') bDepth++
    else if (c === ']') bDepth = Math.max(0, bDepth - 1)
    else if (c === '(') pDepth++
    else if (c === ')') pDepth = Math.max(0, pDepth - 1)
    else if (c === '{') cDepth++
    else if (c === '}') cDepth = Math.max(0, cDepth - 1)
    if (bDepth === 0 && pDepth === 0 && cDepth === 0) {
      for (const sep of seps) {
        if (s.startsWith(sep, i)) {
          parts.push(s.slice(start, i).trim())
          start = i + sep.length
          i += sep.length - 1
          break
        }
      }
    }
  }
  parts.push(s.slice(start).trim())
  return parts
}

/** 选择器预检（含 :N 试译），返回可用选择器；非法则抛错由上层记日志 */
function effectiveSel($scope: cheerio.CheerioAPI, sel: string): string {
  try {
    $scope(sel)
    return sel
  } catch (e) {
    const t = translateNumericPseudo(sel)
    if (t.changed) {
      try {
        const r = $scope(t.sel)
        if (r.length > 0) {
          console.info(`[规则兼容] ${sel} → ${t.sel}`)
          return t.sel
        }
      } catch {
        /* 试译仍失败，走原错 */
      }
    }
    throw e
  }
}

/**
 * CSS 按 @ 逐段收窄（对标 AnalyzeByJSoup.getResultList：前段全是元素选择器并逐级
 * 向内查找，末段是输出 text/textNodes/ownText/html/all/属性名；空段 = 不收窄，
 * 所以 @onclick 表示取当前元素的 onclick 属性）。返回 {els, output}。
 */
// ---------- Legado CSS 单段语义（对标 ElementsSingle）：基选择 + 索引筛选 ----------
// 基写法：tag.X / class.X / id.X / text.X / children / 原生 CSS
// 索引写法：尾缀 :i:j（0 基，负数倒数，多索引，多取）/ !i（排除）/ [i, a:b:c]（区间，可反向）

type IdxPart = { t: 'n'; v: number } | { t: 'r'; s: number | null; e: number | null; step: number }

interface SegParsed {
  base: string
  filter: { exclude: boolean; parts: IdxPart[] } | null
}

/** [..] 括号式索引（不是索引括号则返回 null，走普通选择器） */
function parseBracketIndex(seg: string): SegParsed | null {
  const s = seg.trimEnd()
  if (!s.endsWith(']')) return null
  const items: IdxPart[] = []
  let exclude = false
  let curList: Array<number | null> = []
  let l = ''
  let minus = false
  const pushNum = (): number | null => (l === '' ? null : minus ? -parseInt(l, 10) : parseInt(l, 10))
  const pushItem = (): boolean => {
    const n = pushNum()
    l = ''
    minus = false
    if (curList.length === 0) {
      if (n === null) return false
      items.push({ t: 'n', v: n })
    } else {
      items.push({ t: 'r', s: n, e: curList[curList.length - 1] ?? null, step: curList.length === 2 ? (curList[0] ?? 1) : 1 })
      curList = []
    }
    return true
  }
  for (let i = s.length - 2; i >= 0; i--) {
    const c = s[i]!
    if (c === ' ') continue
    if (c >= '0' && c <= '9') {
      l = c + l
      continue
    }
    if (c === '-') {
      minus = true
      continue
    }
    if (c === ':') {
      curList.push(pushNum())
      l = ''
      minus = false
      continue
    }
    if (c === ',') {
      if (!pushItem()) return null
      continue
    }
    if (c === '[') {
      if (!pushItem()) return null
      return { base: s.slice(0, i), filter: { exclude, parts: items } }
    }
    if (c === '!') {
      exclude = true
      continue
    }
    return null
  }
  return null
}

/** legacy :i:j / !i 尾缀式（无 ./! 终结、串内出现其他字符、空数字都返回 null 走普通选择器） */
function parseLegacyIndex(seg: string): SegParsed | null {
  const ids: number[] = []
  let l = ''
  let minus = false
  for (let i = seg.length - 1; i >= 0; i--) {
    const c = seg[i]!
    if (c === ' ') continue
    if (c >= '0' && c <= '9') {
      l = c + l
      continue
    }
    if (c === '-') {
      minus = true
      continue
    }
    if (c === ':') {
      if (l === '') return null
      ids.push(minus ? -parseInt(l, 10) : parseInt(l, 10))
      l = ''
      minus = false
      continue
    }
    if (c === '.' || c === '!') {
      if (l === '') return null
      ids.push(minus ? -parseInt(l, 10) : parseInt(l, 10))
      return { base: seg.slice(0, i), filter: { exclude: c === '!', parts: ids.map((v) => ({ t: 'n' as const, v })) } }
    }
    return null
  }
  return null // 耗尽仍未终结 → 不是索引式（对标原版落到 whole）
}

function parseCssSegment(seg: string): SegParsed {
  return parseBracketIndex(seg) ?? parseLegacyIndex(seg) ?? { base: seg, filter: null }
}

/** 索引过滤（顺序/负数/区间/排除，对标原版 indexSet 逻辑） */
function applyIndexFilter(els: unknown[], filter: NonNullable<SegParsed['filter']>): unknown[] {
  const len = els.length
  if (!len) return []
  const ordered: number[] = []
  const seen = new Set<number>()
  const push = (i: number) => {
    if (!seen.has(i)) {
      seen.add(i)
      ordered.push(i)
    }
  }
  const norm = (v: number): number | null => {
    if (v >= 0) return v < len ? v : null
    return len >= -v ? v + len : null
  }
  for (let k = filter.parts.length - 1; k >= 0; k--) {
    const p = filter.parts[k]!
    if (p.t === 'n') {
      const i = norm(p.v)
      if (i !== null) push(i)
    } else {
      let s = p.s ?? 0
      if (s < 0) s += len
      let e = p.e ?? len - 1
      if (e < 0) e += len
      if ((s < 0 && e < 0) || (s >= len && e >= len)) continue
      s = Math.min(Math.max(s, 0), len - 1)
      e = Math.min(Math.max(e, 0), len - 1)
      if (s === e || p.step >= len) {
        push(s)
        continue
      }
      const st = p.step > 0 ? p.step : -p.step < len ? p.step + len : 1
      if (e > s) {
        for (let i = s; i <= e; i += st) push(i)
      } else {
        for (let i = s; i >= e; i -= st) push(i)
      }
    }
  }
  if (filter.exclude) {
    const drop = new Set(ordered)
    return els.filter((_, i) => !drop.has(i))
  }
  return ordered.map((i) => els[i])
}

function ownTextOf($scope: cheerio.CheerioAPI, el: unknown): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const $el = $scope(el as any) as any
    return String($el.clone().children().remove().end().text() ?? '').trim()
  } catch {
    return ''
  }
}

/** 基选择（self-or-descendants，对标 getElementsBy* 含自身语义） */
function baseSelect($scope: cheerio.CheerioAPI, els: unknown[], base: string): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyScope = $scope as any
  const kids = (el: unknown): unknown[] => {
    try {
      return anyScope(el).children().toArray()
    } catch {
      return []
    }
  }
  const b = base.trim()
  if (!b) return els.flatMap((el) => kids(el)) // 空基 = children
  const dots = b.split('.')
  const h = dots[0]!
  if (h === 'children') return els.flatMap((el) => kids(el))
  if (dots.length > 1 && dots[1] && (h === 'class' || h === 'tag' || h === 'id' || h === 'text')) {
    const arg = dots[1]!
    if (h === 'text') {
      // ownText 包含（逐层 self-or-descendants）
      const out: unknown[] = []
      const walk = (el: unknown) => {
        if (ownTextOf($scope, el).includes(arg)) out.push(el)
        for (const k of kids(el)) walk(k)
      }
      els.forEach(walk)
      return out
    }
    const out: unknown[] = []
    for (const el of els) {
      const $el = anyScope(el)
      try {
        const selfHit =
          h === 'class'
            ? Boolean($el.hasClass(arg))
            : h === 'tag'
              ? String(($el.get(0) as { tagName?: string } | undefined)?.tagName ?? '').toLowerCase() === arg.toLowerCase()
              : String($el.attr('id') ?? '') === arg
        if (selfHit) out.push(el)
      } catch {
        /* ignore */
      }
      try {
        const sel = h === 'class' ? '.' + arg : h === 'tag' ? arg : '#' + arg
        out.push(...$el.find(effectiveSel($scope, sel)).toArray())
      } catch {
        /* ignore */
      }
    }
    return out
  }
  // 普通 CSS（含 tag./class. 前缀但形式不符时也落到这里）
  const sel = effectiveSel($scope, b)
  const out: unknown[] = []
  for (const el of els) {
    const $el = anyScope(el)
    try {
      if ($el.is(sel)) out.push(el)
    } catch {
      /* ignore */
    }
    try {
      out.push(...$el.find(sel).toArray())
    } catch {
      /* ignore */
    }
  }
  return out
}

/** 单 @ 段求值：基选择 + 索引筛选（空段 = 不收窄） */
function cssNarrow($scope: cheerio.CheerioAPI, els: unknown[], seg: string): unknown[] {
  const t = seg.trim()
  if (!t) return els
  const { base, filter } = parseCssSegment(t)
  const found = baseSelect($scope, els, base)
  if (!filter) return found
  return applyIndexFilter(found, filter)
}

/**
 * CSS 求值根节点：整页（有 <html>）取根；iitem/片段取 body 下内容节点。
 * 关键：@onclick 这类前导 @ 规则取的是条目元素自身的属性，不能套 html 壳。
 */
function cssRoots($scope: cheerio.CheerioAPI, html: string): unknown[] {
  if (/<html[\s>]/i.test(html)) return $scope.root().children().toArray()
  const kids = $scope('body').children().toArray()
  return kids.length ? kids : $scope.root().children().toArray()
}

/** 输出渲染（对标 getResultLast）：text/textNodes/ownText/html/all/属性名 */
function cssOutput($scope: cheerio.CheerioAPI, els: unknown[], output: string): string[] {
  const out: string[] = []
  const seenAttr = new Set<string>()
  for (const el of els) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const $el = $scope(el as any) as any
    const o = output || 'text'
    if (o === 'text') {
      const t = String($el.text() ?? '').trim()
      if (t) out.push(t)
    } else if (o === 'textNodes') {
      const tn: string[] = []
      for (const node of $el.contents().toArray() as Array<{ type?: string; data?: string }>) {
        if (node.type === 'text') {
          const t = String(node.data ?? '').trim()
          if (t) tn.push(t)
        }
      }
      if (tn.length) out.push(tn.join('\n'))
    } else if (o === 'ownText') {
      const t = String($el.clone().children().remove().end().text() ?? '').trim()
      if (t) out.push(t)
    } else if (o === 'html') {
      const $c = $el.clone()
      $c.find('script').remove()
      $c.find('style').remove()
      const h = String($c.html() ?? '').trim()
      if (h) out.push(h)
    } else if (o === 'all') {
      out.push(String($el.toString() ?? ''))
    } else {
      const v = String($el.attr(o) ?? '').trim()
      if (v && !seenAttr.has(v)) {
        seenAttr.add(v)
        out.push(v)
      }
    }
  }
  return out
}

/** 单段规则的「输出说明」关键字：作用在当前范围上，不当选择器（item 范围里常见 text/href）。 */
const CSS_OUTPUT_KEYWORDS = new Set(['text', 'textnodes', 'owntext', 'html', 'all'])

/** 在当前范围内的 roots（元素列表）里按选择器找元素（失败返回空，不抛错）。 */
function cssSelectWithin($scope: cheerio.CheerioAPI, roots: unknown[], sel: string): unknown[] {
  const { sel: translated } = translateNumericPseudo(sel)
  const out: unknown[] = []
  for (const root of roots) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const $root = $scope(root as any) as any
    try {
      if ($root.is(translated)) out.push(root)
    } catch {
      /* 选择器非法：当成属性名/输出说明走回退 */
    }
    try {
      out.push(...$root.find(translated).toArray())
    } catch {
      /* 同上 */
    }
  }
  return out
}

function cssPick(html: string, rule: string, ctx?: RuleCtx): string[] {
  try {
    const $scope = cheerio.load(html)
    const roots = cssRoots($scope, html)
    // 去前导 @（对标 RuleAnalyzer.trim）
    let r = rule.trim()
    while (r.startsWith('@')) r = r.slice(1).trimStart()
    const parts = splitKeepEmpty(r, ['@'])
    if (parts.length <= 1) {
      // 单段规则（无 @ 输出段）：对标原版语义 = 选择器 + 取文本（
      // 如 ruleContent.content="#content"、ruleSearch.name=".title##正则"）。
      // 但 item 范围里也大量用「输出说明」写法（ruleToc.chapterName="text"、
      // chapterUrl="href"），所以：关键字直接当输出；其余先试选择器，
      // 选不到再退回输出说明（属性名）。两边都不丢。
      const w = (parts[0] ?? '').trim()
      if (!w) return []
      if (CSS_OUTPUT_KEYWORDS.has(w.toLowerCase())) return cssOutput($scope, roots, w)
      const found = cssSelectWithin($scope, roots, w)
      if (found.length) return cssOutput($scope, found, 'text')
      return cssOutput($scope, roots, w)
    }
    let els = roots
    for (const s of parts.slice(0, -1)) els = cssNarrow($scope, els, s)
    return cssOutput($scope, els, parts[parts.length - 1] ?? '')
  } catch (e) {
    warnRule(ctx, 'CSS', rule, e)
    return []
  }
}

function jsonPick(data: unknown, sel: string, ctx?: RuleCtx): string[] {
  try {
    const r = JSONPath({ path: sel, json: data as object }) as unknown as unknown[]
    return r.map((v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)))
  } catch (e) {
    warnRule(ctx, 'JSON', sel, e)
    return []
  }
}

/**
 * HTML 清洗为可 XML 解析的片段：去 script/style/注释/doctype、自闭合 void 元素、
 * 非 XML 实体转空格、裸 &/< 转义（对标 Jsoup 的容错解析，便于 XPath 引擎工作）。
 */
function sanitizeForXml(html: string): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<!doctype[^>]*>/gi, '')
  // void 元素自闭合（已有 / 结尾的不动）
  s = s.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)((?:\s[^<>]*?)?)>/gi,
    (_m, tag: string, attrs: string) => (attrs.trimEnd().endsWith('/') ? _m : `<${tag}${attrs}/>`),
  )
  // 非 XML 实体（保留 amp/lt/gt/quot/apos/数字实体）转空格
  s = s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[a-zA-Z][a-zA-Z0-9]*;/g, ' ')
  // 裸 & 转义（合法实体不受影响）
  s = s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
  // 文本中的裸 < 转义（标签开头才保留）
  s = s.replace(/<(?![a-zA-Z!/ ?])/g, '&lt;')
  return s
}

// 解析后 Document 缓存（同页多规则复用，避免反复清洗+解析），最多留 5 页
const xmlDocCache = new Map<string, unknown>()
function getXmlDoc(html: string): unknown {
  const hit = xmlDocCache.get(html)
  if (hit !== undefined) return hit ?? null
  let doc: unknown = null
  try {
    const d = new DOMParser().parseFromString(`<root>${sanitizeForXml(html)}</root>`, 'text/xml') as unknown as {
      documentElement?: unknown
    }
    if (d?.documentElement) doc = d
  } catch {
    doc = null
  }
  if (xmlDocCache.size >= 5) {
    const first = xmlDocCache.keys().next()
    if (!first.done) xmlDocCache.delete(first.value)
  }
  xmlDocCache.set(html, doc)
  return doc
}

/** XPath 节点转字符串（对标 JXNode.asString）：属性取 value，文本取 data，元素取文本/innerHTML */
function xpathNodeToString(n: unknown, outMode: 'text' | 'html'): string {
  if (n == null) return ''
  if (typeof n !== 'object') return String(n)
  const node = n as {
    nodeType?: number
    value?: unknown
    data?: unknown
    textContent?: unknown
    childNodes?: ArrayLike<unknown>
  }
  if (node.nodeType === 2) return String(node.value ?? '') // Attr（//a/@href 直接定位到属性）
  if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) {
    return String(node.data ?? '') // Text / CDATA / Comment
  }
  if (node.nodeType === 1) {
    if (outMode === 'html') {
      try {
        const ser = new XMLSerializer()
        const kids = node.childNodes ?? []
        let s = ''
        for (let i = 0; i < kids.length; i++) s += ser.serializeToString(kids[i] as never)
        return s.trim()
      } catch {
        /* fallthrough */
      }
    }
    return String(node.textContent ?? '').trim()
  }
  return String(node.textContent ?? node.value ?? '').trim()
}

/**
 * 完整 XPath 求值（对标 AnalyzeByXPath：整条规则含 /@href、/text() 等轴步骤直接进引擎）。
 * 解析失败返回空数组而不抛错，避免一条坏规则拖死整本详情。
 */
function xpathPickFull(docHtml: string, expr: string, outMode: 'text' | 'html', ctx?: RuleCtx): string[] {
  const e = expr.trim()
  if (!e) return [docHtml.trim()]
  try {
    const doc = getXmlDoc(docHtml)
    if (!doc) return []
    const nodes = xpath.select(e, doc as unknown as Node) as unknown[]
    return (nodes ?? []).map((n) => xpathNodeToString(n, outMode))
  } catch (err) {
    warnRule(ctx, 'XPath', e, err)
    return []
  }
}

function xpathPick(docHtml: string, sel: string, attr: string, ctx?: RuleCtx): string[] {
  // 兼容 Legado 写法尾缀：//@text 取文本、//@html 取 inner，其余（/@href 等）属于表达式本身
  const m = /\/@(text|html|all)$/i.exec(sel)
  if (m) {
    const expr = sel.slice(0, m.index)
    return xpathPickFull(docHtml, expr, m[1]!.toLowerCase() === 'text' ? 'text' : 'html', ctx)
  }
  void attr
  return xpathPickFull(docHtml, sel, 'text', ctx)
}

// ---------- 对外求值入口（永不抛错） ----------

/** $N 分组引用代换（对标原版 $n 规则段）：仅当页体是 JSON 数组（正则列表条目）时生效。
 *  发生代换则整体直接返回（$N 只出现在取最终字符串的位置）。
 *  $.x / $[ 不受影响（$ 后须跟数字）。 */
function substituteGroupRefs(rule: string, body: string): { rule: string; done: boolean } {
  if (!/\$\d/.test(rule)) return { rule, done: false }
  let arr: unknown[] | null = null
  try {
    const v = JSON.parse(body) as unknown
    if (Array.isArray(v)) arr = v
  } catch {
    /* ignore */
  }
  if (!arr) return { rule, done: false }
  const out = rule.replace(/\$(\d{1,2})/g, (_m, d: string) => {
    const v = arr![parseInt(d, 10)]
    return v == null ? '' : String(v)
  })
  return { rule: out, done: out !== rule }
}

/** 纯文本段求值（不含 js 段；可含 ||/&&/%% 由上层拆分） */
function evalTextSegment(body: string, text: string, ctx: RuleCtx): string[] {
  try {
  // 1. 先提 @put:{...}（值规则可含选择器/{{}}，递归求值后存入 scope）
  const r0 = extractPutRules(body, text, ctx).trim()
  if (!r0) return []
  // 1b. $N 分组引用（正则列表条目是分组数组时）：发生代换则整体直接返回
  const g = substituteGroupRefs(r0, body)
  if (g.done) return g.rule ? [g.rule] : []
  const r = g.rule
  // 2. WebJS 不支持（记日志，不按 CSS 瞎解析）
  if (isWebJs(r)) {
    warnRule(ctx, 'WebJS', r, new Error('WebJS 渲染暂不支持'))
    return []
  }
  // 3. 兜底：整段就是 JS（正常流程 js 段已被上层摘出，到这里的极少）
  if (isJsRule(r)) {
    const v = evalJsRule(r, { ...ctx, result: body }, ctx.scope)
    if (v == null) return []
    if (Array.isArray(v)) return v.map((x) => String(x))
    return [String(v)]
  }
    // 4. 模板模式（含 @get:/{{}}）：代换后整体即结果，不做选择器解析
    if (isTemplateRule(r)) {
      const sub = substituteGets(r, ctx, body)
      const { main, pattern, replacement, replaceFirst } = splitRegexSuffix(sub)
      const out = main.trim()
      return applyRegex(out ? [out] : [], pattern, replacement, replaceFirst)
    }
    // 5. 普通规则：{{}}/@get 预代换后按模式求值
    //    注意 XPath/JSON 不拆 @ 后缀（@ 属于表达式本身），只有 CSS 拆 selector@attr
    const sub = substituteGets(r, ctx, body)
    const { main, pattern, replacement, replaceFirst } = splitRegexSuffix(sub)
    const { sel: noPrefix, forced } = stripModePrefix(main.trim())
    const mode = decideMode(body, noPrefix, forced)
    if (mode === 'xpath') {
      return applyRegex(xpathPick(body, noPrefix, 'text', ctx), pattern, replacement, replaceFirst)
    }
    if (mode === 'json') {
      // JSONPath：过滤器里有 @（[?(@.x)]），不拆后缀；裸名（如 x_id）补 $. 前缀
      try {
        return applyRegex(jsonPick(JSON.parse(body), normalizeJsonPath(noPrefix), ctx), pattern, replacement, replaceFirst)
      } catch {
        return []
      }
    }
    // CSS：整条规则（含多段 @）进 cssPick，内部逐段收窄
    return applyRegex(cssPick(body, noPrefix, ctx), pattern, replacement, replaceFirst)
  } catch (e) {
    warnRule(ctx, '规则', text, e)
    return []
  }
}

/** 无 js 段的文本规则：按顶层 ||/&&/%% 求值 */
function evalCombined(body: string, text: string, ctx: RuleCtx): string[] {
  const { parts, sep } = splitTopAware(text, ['%%', '||', '&&'])
  if (!sep) return evalTextSegment(body, text, ctx)
  if (sep === '||') {
    for (const b of parts) {
      const v = evalCombined(body, b, ctx).filter((x) => x !== '')
      if (v.length) return v
    }
    return []
  }
  if (sep === '&&') {
    return parts.flatMap((b) => evalCombined(body, b, ctx))
  }
  // %% 拉链合并
  const lists = parts.map((b) => evalCombined(body, b, ctx))
  return zipLists(lists)
}

function zipLists(lists: string[][]): string[] {
  const max = Math.max(0, ...lists.map((l) => l.length))
  const out: string[] = []
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      if (i < l.length) out.push(l[i]!)
    }
  }
  return out
}

export function evalList(body: string, rule: string | undefined, ctx: RuleCtx): string[] {
  if (!rule?.trim()) return []
  try {
    // js 段先摘出（原子的，里面的 ||/&& 不再切分，如 @js:result||"default"）
    const segs = splitJsSegments(rule)
    if (segs.length === 1 && segs[0]!.type === 'text') {
      return evalCombined(body, segs[0]!.code, ctx)
    }
    // 链式求值：text 段输出成为下一段的 content，js 段以上一段输出为 result
    let cur: unknown = body
    let curList: string[] | null = null
    for (const seg of segs) {
      if (seg.type === 'js') {
        const input = curList ? curList.join('\n') : typeof cur === 'string' ? cur : JSON.stringify(cur ?? '')
        cur = evalJsRule(seg.code, { ...ctx, result: input }, ctx.scope)
        // java.setContent 会替换后续规则的内容（对标原版 setContent）
        if (ctx.scope.contentOverride !== undefined) {
          cur = ctx.scope.contentOverride
          ctx.scope.contentOverride = undefined
        }
        curList = null
        if (cur == null) return []
      } else {
        const s = seg.code.trim()
        if (!s) continue
        const input = curList ? curList.join('\n') : typeof cur === 'string' ? cur : JSON.stringify(cur ?? '')
        curList = evalCombined(input, s, ctx)
        cur = null
      }
    }
    if (curList) return curList
    if (cur == null) return []
    if (Array.isArray(cur)) return cur.map((x) => String(x))
    const out = String(cur)
    return out ? [out] : []
  } catch (e) {
    warnRule(ctx, '规则', rule, e)
    return []
  }
}

export function evalFirst(body: string, rule: string | undefined, ctx: RuleCtx): string {
  const v = evalList(body, rule, ctx).filter((x) => x !== '')
  return v[0] ?? ''
}

/** 列表单分支求值（返回 item 的 HTML/JSON，供子规则二次解析） */
function evalItemBranch(body: string, branch: string, ctx: RuleCtx): string[] {
  try {
    const { main } = splitRegexSuffix(branch)
    const { sel: noPrefix, forced } = stripModePrefix(main.trim())
    const s = noPrefix
    if (!s) return []
    if (decideMode(body, s, forced) === 'json' && isJsonText(body)) {
      const arr = JSONPath({ path: normalizeJsonPath(s), json: JSON.parse(body) as object }) as unknown as unknown[]
      // 匹配到数组时展开为条目（对标原版 getElements 对数组的迭代），而非整个数组当一条
      const flat: unknown[] = []
      for (const m of arr ?? []) {
        if (Array.isArray(m)) flat.push(...m)
        else flat.push(m)
      }
      return flat.map((x) => (typeof x === 'string' ? x : JSON.stringify(x ?? '')))
    }
    if (decideMode(body, s, forced) === 'xpath' && !isJsonText(body)) {
      // 列表项需要 outerHTML 供子规则二次解析
      const doc = getXmlDoc(body)
      if (!doc) return []
      const nodes = xpath.select(s, doc as unknown as Node) as unknown[]
      const ser = new XMLSerializer()
      return (nodes ?? [])
        .map((n) => {
          if ((n as { nodeType?: number })?.nodeType === 1) {
            try {
              return ser.serializeToString(n as never)
            } catch {
              return ''
            }
          }
          return xpathNodeToString(n, 'html')
        })
        .filter((x) => x !== '')
    }
    // CSS：整段按 ElementsSingle 求元素（基选择+索引筛选，不拆 @ 输出），返回 outerHTML
    const $ = cheerio.load(body)
    const out: string[] = []
    try {
      const { base, filter } = parseCssSegment(s)
      let els = baseSelect($, cssRoots($, body), base)
      if (filter) els = applyIndexFilter(els, filter)
      for (const el of els) {
        const h = $.html(el as never) ?? ''
        if (h) out.push(h)
      }
    } catch (e) {
      warnRule(ctx, 'CSS-列表', s, e)
    }
    return out
  } catch (e) {
    warnRule(ctx, '列表', branch, e)
    return []
  }
}

/** 列表规则：返回每条 item 的原始 HTML/JSON 字符串，供子规则二次解析。
 *  以 : 开头为正则列表（对标原版 allInOne）：去首个 : 后按 && 串正则，末个正则的
 *  每处匹配为一条（分组数组 JSON，供子规则 $N 取用）；<js> 段链式参与。 */
export function evalItemList(body: string, listRule: string | undefined, ctx: RuleCtx): string[] {
  if (!listRule?.trim()) return []
  // @put 先提（列表规则里的 @put 供同页子规则 @get 使用），再做 @get/{{}} 代换
  // （: 正则模式跳过代换，对标原版 Regex 模式不处理模板，且避免吃掉正则量词 {{n,m}}）
  const rawMode = listRule.trimStart().startsWith(':')
  const pre = (rawMode ? listRule.trim() : substituteGets(extractPutRules(body, listRule, ctx), ctx, body).trim())
  if (!pre) return []
  if (isWebJs(pre)) {
    warnRule(ctx, 'WebJS', pre, new Error('WebJS 渲染暂不支持'))
    return []
  }
  try {
    const segs = splitJsSegments(pre)
    if (segs.length === 1 && segs[0]!.type === 'text') {
      return rawMode ? evalRegexList(body, segs[0]!.code, ctx) : evalItemCombined(body, segs[0]!.code, ctx)
    }
    // 链式：text 段产出 item 列表，js 段以上一步输出为 result（列表上下文传数组）
    let cur: unknown = body
    let curList: string[] | null = null
    // 首段 text 若以 : 开头则整体为正则模式（对标 allInOne 首字符判定）
    const firstText = segs.find((s) => s.type === 'text')
    const chainRegex = rawMode && firstText ? true : false
    for (const seg of segs) {
      if (seg.type === 'js') {
        const input = curList ?? (typeof cur === 'string' ? cur : JSON.stringify(cur ?? ''))
        cur = evalJsRule(seg.code, { ...ctx, result: input }, ctx.scope)
        curList = null
        if (cur == null) return []
      } else {
        const s = seg.code.trim()
        if (!s) continue
        if (chainRegex) {
          // 正则链段：上一步输出（列表则拼合）为页体
          const input = curList ? curList.join('\n') : typeof cur === 'string' ? cur : JSON.stringify(cur ?? '')
          curList = evalRegexList(input, s, ctx)
          cur = null
        } else {
          const input = curList ? curList.join('\n') : typeof cur === 'string' ? cur : JSON.stringify(cur ?? '')
          curList = evalItemCombined(input, s, ctx)
          cur = null
        }
      }
    }
    if (curList) return curList
    if (cur == null) return []
    if (Array.isArray(cur)) return cur.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    const out = String(cur)
    return out ? [out] : []
  } catch (e) {
    warnRule(ctx, '列表', pre, e)
    return []
  }
}

/** 正则列表：patterns 按 && 串接收窄（各匹配全文拼接），末个每处匹配为一条分组数组 */
function evalRegexList(body: string, pattern: string, ctx: RuleCtx): string[] {
  // 去首个 :（对标 allInOne 起始偏移），链路里已去过的再次处理无影响
  const p0 = pattern.trimStart().replace(/^:/, '')
  const pats = p0
    .split('&&')
    .map((x) => x.trim())
    .filter((x) => x !== '')
  if (!pats.length) return []
  try {
    let text = body
    for (let i = 0; i < pats.length; i++) {
      const re = new RegExp(pats[i]!, 'gs')
      const ms = [...text.matchAll(re)]
      if (i === pats.length - 1) {
        // 末段：每处匹配的分组数组为一条（$0 全匹配，$1… 分组，对标原版）
        return ms.map((m) => JSON.stringify([m[0] ?? '', ...m.slice(1).map((g) => g ?? '')]))
      }
      if (!ms.length) return []
      text = ms.map((m) => m[0] ?? '').join('')
    }
    return []
  } catch (e) {
    warnRule(ctx, '正则列表', pattern, e)
    return []
  }
}

/** 无 js 段的列表规则：按顶层 ||/&&/%% 求值 */
function evalItemCombined(body: string, text: string, ctx: RuleCtx): string[] {
  const { parts, sep } = splitTopAware(text, ['%%', '||', '&&'])
  if (!sep) return evalItemBranch(body, text, ctx)
  if (sep === '||') {
    for (const b of parts) {
      const v = evalItemCombined(body, b, ctx).filter((x) => x !== '')
      if (v.length) return v
    }
    return []
  }
  if (sep === '&&') {
    return parts.flatMap((b) => evalItemCombined(body, b, ctx))
  }
  return zipLists(parts.map((b) => evalItemCombined(body, b, ctx)))
}

/**
 * 取单个元素（对标 getElement，供详情页 init 重定根用）。
 * JSON 取首个匹配的原始 JSON；XPath 取首个元素 outerHTML（属性/文本取其值）；
 * CSS 取首个 outerHTML；JS 取值（对象转 JSON）。
 */
export function evalElement(body: string, rule: string | undefined, ctx: RuleCtx): string {
  if (!rule?.trim()) return ''
  try {
    const r = extractPutRules(body, rule, ctx).trim()
    if (!r || isWebJs(r)) return ''
    // : 开头为正则取元（对标 getElement allInOne）：&& 串接收窄，首个匹配的分组数组取 [0]
    if (r.startsWith(':')) {
      const pats = r
        .replace(/^:/, '')
        .split('&&')
        .map((x) => x.trim())
        .filter((x) => x !== '')
      try {
        let text = body
        for (let i = 0; i < pats.length; i++) {
          const re = new RegExp(pats[i]!, 'gs')
          const ms = [...text.matchAll(re)]
          if (!ms.length) return ''
          if (i === pats.length - 1) {
            const g = ms[0]!
            return g[0] ?? ''
          }
          text = ms.map((m) => m[0] ?? '').join('')
        }
        return ''
      } catch (e) {
        warnRule(ctx, '正则取元', rule, e)
        return ''
      }
    }
    if (isJsRule(r)) {
      const v = evalJsRule(r, { ...ctx, result: body }, ctx.scope)
      if (v == null) return ''
      return typeof v === 'string' ? v : JSON.stringify(v)
    }
    const sub = substituteGets(r, ctx, body)
    const { main } = splitRegexSuffix(sub)
    const { sel: noPrefix, forced } = stripModePrefix(main.trim())
    if (!noPrefix) return ''
    const mode = decideMode(body, noPrefix, forced)
    if (mode === 'json') {
      if (!isJsonText(body)) return ''
      const arr = JSONPath({ path: normalizeJsonPath(noPrefix), json: JSON.parse(body) as object }) as unknown as unknown[]
      const first = arr?.[0]
      if (first == null) return ''
      return typeof first === 'string' ? first : JSON.stringify(first)
    }
    if (mode === 'xpath') {
      const doc = getXmlDoc(body)
      if (!doc) return ''
      const nodes = xpath.select(noPrefix, doc as unknown as Node) as unknown[]
      const n = nodes?.[0]
      if (n == null) return ''
      if ((n as { nodeType?: number })?.nodeType === 1) {
        try {
          return new XMLSerializer().serializeToString(n as never)
        } catch {
          return ''
        }
      }
      return xpathNodeToString(n, 'html')
    }
    // CSS：整段按 ElementsSingle 求元素，取首个 outerHTML
    const $ = cheerio.load(body)
    const { base, filter } = parseCssSegment(noPrefix)
    let els = baseSelect($, cssRoots($, body), base)
    if (filter) els = applyIndexFilter(els, filter)
    const first = els[0]
    return first !== undefined ? $.html(first as never) ?? '' : ''
  } catch (e) {
    warnRule(ctx, '取元', rule, e)
    return ''
  }
}

/** 绝对 URL 合并（含 //host/path 协议相对 URL） */
export function absUrl(base: string, href: string): string {
  const h = (href ?? '').trim()
  if (!h) return ''
  if (/^https?:\/\//i.test(h)) return h
  try {
    return new URL(h, base).toString()
  } catch {
    return h
  }
}

// ---------- 注册 java 规则求值钩子（对标 JsExtensions 暴露的 getElement/getString 等）----------

function jsBody(ctx: JsContext): string {
  return typeof ctx.result === 'string' ? ctx.result : JSON.stringify(ctx.result ?? '')
}

setJavaRuleHooks({
  elements: (ctx, rule) => {
    const rc = ctx as RuleCtx
    if (!rc?.scope) return []
    return evalItemList(jsBody(ctx), rule, rc)
  },
  string: (ctx, rule) => {
    const rc = ctx as RuleCtx
    if (!rc?.scope) return ''
    return evalFirst(jsBody(ctx), rule, rc)
  },
  list: (ctx, rule) => {
    const rc = ctx as RuleCtx
    if (!rc?.scope) return []
    return evalList(jsBody(ctx), rule, rc)
  },
})
