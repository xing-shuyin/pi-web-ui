// AnalyzeUrl 精简移植：解析 searchUrl/exploreUrl/tocUrl 的 ,{json} 后缀 + {{模板}}。
// 例：https://xxx/s?q={{key}}&p={{page}},{"method":"POST","body":"...","headers":{...}}
//
// 选项块按**宽松 JSON**解析（对标安卓版的 Gson lenient）：允许单引号字符串、裸键名、尾逗号。
// 社区源里 `,{'method':'POST','body':'...'}` 这种写法很多；严格 JSON.parse 会解析失败并把整串
// 当 URL（实测「必读文学」：search/toc/正文都是 POST，解析失败后一律 GET → 搜索 0 本、正文空）。
//
// POST 未声明 Content-Type 时按表单处理（同 java.post）：否则 undici 会发 text/plain，
// 服务端读不到参数（quickapi 会返回默认列表而不是搜索结果）。

import { applyTemplate, type Scope } from './js'
import type { FetchOptions } from '../types'

export interface ParsedUrl {
  url: string
  options: FetchOptions
}

/** 宽松 JSON（Gson lenient 子集）：单引号字符串、裸键名、尾逗号；解析不出返回 null。 */
export function parseLooseJson(text: string): Record<string, unknown> | null {
  const t = text.trim()
  try {
    const strict = JSON.parse(t) as unknown
    return strict && typeof strict === 'object' ? (strict as Record<string, unknown>) : null
  } catch {
    /* 落回宽松解析 */
  }
  const out: string[] = []
  let i = 0
  /** 当前所在字符串的引号字符（'' = 不在字符串里） */
  let quote = ''
  const lastSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k]!
      if (!/\s/.test(c)) return c
    }
    return ''
  }
  while (i < t.length) {
    const c = t[i]!
    if (quote) {
      if (c === '\\') {
        const nx = t[i + 1] ?? ''
        if (quote === "'" && nx === "'") {
          out.push("'")
          i += 2
          continue
        }
        out.push(c, nx)
        i += 2
        continue
      }
      if (c === quote) {
        out.push('"')
        quote = ''
        i++
        continue
      }
      // 单引号串里的 " 在 JSON 里要转义
      if (quote === "'" && c === '"') out.push('\\"')
      else out.push(c)
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out.push('"')
      i++
      continue
    }
    if (c === ',') {
      // 尾逗号：,} / ,]
      let j = i + 1
      while (j < t.length && /\s/.test(t[j]!)) j++
      const nx = t[j]
      if (nx === '}' || nx === ']') {
        i = j
        continue
      }
      out.push(c)
      i++
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      // 裸键名：{ key: / , key:
      const prev = lastSignificant()
      if (prev === '{' || prev === ',') {
        let j = i
        while (j < t.length && /[\w$.-]/.test(t[j]!)) j++
        const name = t.slice(i, j)
        let k = j
        while (k < t.length && /\s/.test(t[k]!)) k++
        if (t[k] === ':') {
          out.push(`"${name}"`)
          i = j
          continue
        }
      }
    }
    out.push(c)
    i++
  }
  try {
    const v = JSON.parse(out.join('')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parseCustomUrl(
  raw: string,
  base: string,
  key = '',
  page = 1,
  scope?: Scope,
  source?: unknown,
): ParsedUrl {
  let urlPart = raw.trim()
  let extra: Record<string, unknown> = {}

  // 切出末尾 ,{...} JSON（注意 URL 自身可能含逗号，从后往前找第一个 ,{ 起的合法 JSON）
  const m = urlPart.match(/,\s*(\{[\s\S]*\})\s*$/)
  if (m?.[1]) {
    const parsed = parseLooseJson(m[1])
    if (parsed) {
      extra = parsed
      urlPart = urlPart.slice(0, m.index).trim()
    }
  }

  const ctx = { key, page, baseUrl: base, result: '', source }
  const url = applyTemplate(urlPart, ctx, scope)

  const headers: Record<string, string> = { ...(((extra['headers'] ?? extra['header'] ?? {}) as Record<string, string>) ?? {}) }
  const method = String(extra['method'] ?? 'GET').toUpperCase()
  const charset = String(extra['charset'] ?? extra['encoding'] ?? '') || undefined
  let body = extra['body'] != null ? String(extra['body']) : undefined
  if (body) body = applyTemplate(body, ctx, scope)

  // POST 带体但没声明 Content-Type → 按表单提交（对标安卓版/java.post）
  if (method !== 'GET' && body != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  // 相对路径相对书源根合并
  let abs = url
  if (abs && !/^https?:\/\//i.test(abs)) {
    try {
      abs = new URL(abs, base).toString()
    } catch {
      /* 保持原样 */
    }
  }
  return { url: abs, options: { method, headers, body, charset } }
}
