// 发现（explore）支持，对标原版 BookSourceExtensions.getExploreKinds + 探索页。
//
// exploreUrl 三种形态：
//   1) @js:... / <js>...</js>  → 执行 JS 得到 JSON 数组（[{title,url,style}]）或文本
//   2) JSON 数组字符串        → 直接用
//   3) 旧式文本：分类之间用 && 或换行分隔，每项 "分类名::url"
//
// 分类类型（ExploreKind.type）：
//   url    点击直接加载书籍列表（默认）
//   text / button / select / toggle  作为筛选控件，值写入 infoMap，供 url 类分类/规则里的 JS 读取

import type { BookSource, SearchBook } from '../types'
import { evalJsRule, getScope, type JsContext } from './js'
import { discoverBooks } from './webBook'

export interface ExploreKind {
  title: string
  url?: string | null
  type?: string
  action?: string | null
  chars?: (string | null)[] | null
  default?: string | null
  viewName?: string | null
  style?: Record<string, unknown> | null
}

function isJsonArrayText(t: string): boolean {
  const s = t.trim()
  return s.startsWith('[') && s.endsWith(']')
}

/** 解析某书源的发现分类列表（结果按源缓存到内存） */
const kindCache = new Map<string, ExploreKind[]>()

export async function parseExploreKinds(source: BookSource, force = false): Promise<ExploreKind[]> {
  const key = source.bookSourceUrl
  if (!force) {
    const hit = kindCache.get(key)
    if (hit) return hit
  }
  const raw = (source.exploreUrl ?? '').trim()
  if (!raw) return []
  let ruleStr = raw
  const scope = getScope(source.bookSourceUrl)
  const ctx: JsContext = {
    baseUrl: source.bookSourceUrl,
    source,
    scope,
    infoMap: getInfoMap(source.bookSourceUrl),
  }
  try {
    if (/^@js:/i.test(ruleStr)) {
      ruleStr = String(evalJsRule(ruleStr.replace(/^@js:/i, ''), ctx, scope) ?? '').trim()
    } else if (/^<js>/i.test(ruleStr)) {
      const body = ruleStr.replace(/^<js>/i, '').replace(/<\/js>\s*$/i, '')
      ruleStr = String(evalJsRule(body, ctx, scope) ?? '').trim()
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[发现分类失败] ${source.bookSourceName} || ${msg.slice(0, 140)}`)
    throw new Error(`分类规则执行失败：${msg.slice(0, 80)}`)
  }
  let kinds: ExploreKind[] = []
  if (isJsonArrayText(ruleStr)) {
    try {
      const arr = JSON.parse(ruleStr) as ExploreKind[]
      kinds = Array.isArray(arr) ? arr : []
    } catch {
      kinds = []
    }
  } else {
    kinds = ruleStr
      .split(/(?:&&|\n)+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((line) => {
        const [title, url] = line.split('::')
        return { title: (title ?? '').trim(), url: (url ?? '').trim() || null, type: 'url' } as ExploreKind
      })
  }
  kindCache.set(key, kinds)
  return kinds
}

export function clearExploreKindsCache(sourceUrl?: string) {
  if (sourceUrl) kindCache.delete(sourceUrl)
  else kindCache.clear()
}

/** 加载某个发现分类的书籍列表 */
export async function loadExploreBooks(source: BookSource, kind: ExploreKind, page = 1): Promise<SearchBook[]> {
  const url = (kind.url ?? '').trim()
  if (!url) return []
  return discoverBooks(source, url, page)
}

export { discoverBooks }

// ---------- infoMap（发现筛选控件的值，按源缓存，供 JS 读取） ----------

/** 发现页筛选控件值：会话内存（不写 localStorage，页面刷新即回到默认） */
const memInfoMap = new Map<string, Record<string, string>>()

export interface InfoMap {
  get(): Record<string, string>
  set(v: Record<string, string>): void
  put(k: string, v: string): string
  remove(k: string): void
  containsKey(k: string): boolean
}

/** 可当普通对象用（infoMap.xx）也可当 Map 用（infoMap.get('xx')）的 infoMap */
export function getInfoMap(sourceUrl: string): Record<string, string> & InfoMap {
  // 筛选控件的值只放**页面内存**（不写 localStorage）：刷新后回到默认值，重新选一下即可
  let data: Record<string, string> = memInfoMap.get(sourceUrl) ?? {}
  const save = () => {
    memInfoMap.set(sourceUrl, data)
  }
  const target: Record<string, unknown> = {
    get: () => data,
    set: (v: Record<string, string>) => {
      data = { ...v }
      save()
    },
    put: (k: string, v: string) => {
      data[k] = String(v)
      save()
      return String(v)
    },
    remove: (k: string) => {
      delete data[k]
      save()
    },
    containsKey: (k: string) => k in data,
  }
  return new Proxy(target, {
    get: (t, k) => (typeof k === 'string' && k in t ? t[k] : data[k as string]),
    set: (t, k, v) => {
      if (typeof k === 'string' && k in t) {
        ;(t as Record<string, unknown>)[k] = v
        return true
      }
      data[k as string] = String(v)
      save()
      return true
    },
    has: (t, k) => (typeof k === 'string' && k in t) || k in data,
    ownKeys: () => [...Object.keys(data), ...Object.keys(target)],
    getOwnPropertyDescriptor: (t, k) =>
      typeof k === 'string' && k in t
        ? { configurable: true, enumerable: true, value: (t as Record<string, unknown>)[k], writable: true }
        : { configurable: true, enumerable: true, value: data[String(k)], writable: true },
  }) as unknown as Record<string, string> & InfoMap
}
