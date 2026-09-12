// JS 规则执行。原 Android 用 Rhino，本项目直接原生执行。
// 对应 Android：AnalyzeRule.evalJS 的 bindings（java=this/cookie/cache/source/book/result/
// baseUrl/chapter/title/...）+ JsExtensions / JsEncodeUtils 常用方法。
//
// 支持的写法：
//   @js:<code> / <js>...</js> —— result=上一步结果，可自由读写 result/java/source/book...
//   {{ key, page, result, baseUrl, java.get("k") }} —— URL/规则模板里的 JS 表达式
//   java.put(k,v) / java.get(k) —— 跨规则暂存变量（按书源隔离，行为对标原版 source 级变量）

import { buildProxyUrl, getSyncTransport } from './request'
import * as cheerio from 'cheerio'
import md5 from 'js-md5'

export interface JsContext {
  result?: unknown
  baseUrl?: string
  key?: string
  page?: number
  source?: unknown
  book?: unknown
  chapter?: unknown
  title?: string
  /** 发现页筛选值（infoMap.xx / infoMap.get('xx')） */
  infoMap?: unknown
  [k: string]: unknown
}

/** 跨规则变量作用域（一个书源一个，由 webBook 按源复用） */
export class Scope {
  vars = new Map<string, string>()
  /** 按源隔离的 JS 共享对象（承接规则里隐式全局变量，对标原版 SharedJsScope） */
  jsScope: Record<string, unknown> = {}
  /** java.setContent 设置的替换内容（对标 AnalyzeRule.setContent，供链上后续规则使用） */
  contentOverride: unknown = undefined
  /** 发现页筛选值（对标原版 InfoMap，按源持久化） */
  infoMap: unknown = undefined
  put(key: string, value: unknown): string {
    const v = value == null ? '' : String(value)
    this.vars.set(key, v)
    return v
  }
  get(key: string): string {
    if (key === 'bookName') return ''
    return this.vars.get(key) ?? ''
  }
}

const scopes = new Map<string, Scope>()
export function getScope(sourceUrl: string): Scope {
  let s = scopes.get(sourceUrl)
  if (!s) {
    s = new Scope()
    scopes.set(sourceUrl, s)
  }
  return s
}

/** 是否 JS 规则 */
export function isJsRule(rule?: string): boolean {
  if (!rule) return false
  const r = rule.trim()
  return r.startsWith('@js:') || (r.startsWith('<js>') && r.endsWith('</js>'))
}

function stripJsWrapper(code: string): string {
  let body = code.trim()
  if (body.startsWith('@js:')) body = body.slice(4)
  body = body
    .replace(/^<js>/, '')
    .replace(/<\/js>$/, '')
    .trim()
  // 兼容 Rhino 能跑但标准 JS 不行的写法：无括号的解构箭头参数 [a, b] =>  →  ([a, b]) =>
  body = body.replace(/\[([^[\]]*)\]\s*=>/g, '([$1]) =>')
  return body
}

/** 同步经代理请求（对标 java.ajax/connect 的同步语义；浏览器会有 deprecation 警告但可用）。
 *  服务端（插件的规则引擎）会注入同步 transport（worker + Atomics 桥），走那条路。 */
function syncProxy(target: string, method = 'GET', headers: Record<string, string> = {}, body?: string): string {
  const injected = getSyncTransport()
  if (injected) return injected(target, method, headers, body)
  const xhr = new XMLHttpRequest()
  xhr.open(method, buildProxyUrl(target), false)
  for (const [k, v] of Object.entries(headers)) {
    try {
      xhr.setRequestHeader(k, v)
    } catch {
      /* 非法头跳过 */
    }
  }
  xhr.send(body ?? null)
  if (xhr.status >= 200 && xhr.status < 300) {
    try {
      const data = JSON.parse(xhr.responseText) as { body?: string; error?: string }
      if (data.error) throw new Error(data.error)
      return data.body ?? ''
    } catch (e) {
      if (e instanceof SyntaxError) return xhr.responseText
      throw e
    }
  }
  throw new Error(`ajax ${xhr.status} ${target}`)
}

function parseHeaders(h: unknown): Record<string, string> {
  if (!h) return {}
  if (typeof h === 'string') {
    try {
      const o = JSON.parse(h) as Record<string, string>
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }
  if (typeof h === 'object') return h as Record<string, string>
  return {}
}

/** 书源 JS 规则的键值缓存（java.cache.get/put、cache.getFile/putFile）：
 *  只放**页面内存**——不写 localStorage（书源几 MB，浏览器 5MB 配额装不下，
 *  而且规则里 putFile 可能存整页；刷新后重算即可）。 */
const jsCache = new Map<string, string>()

function readCache(key: string): string | undefined {
  return jsCache.get(key)
}

function writeCache(key: string, value: string) {
  jsCache.set(key, value)
}

/** 构造注入 JS 规则的 java 对象（方法集对标 JsExtensions 常用部分） */

/** 规则求值钩子（由 analyzeRule 注册，避开循环依赖）：对标 java.getElement/getString/… */
export interface JavaRuleHooks {
  /** 元素列表（outerHTML 字符串）——对标原版 getElement/getElements 返回 Elements */
  elements?: (ctx: JsContext, rule: string) => string[]
  list?: (ctx: JsContext, rule: string) => string[]
  string?: (ctx: JsContext, rule: string) => string
}

let javaHooks: JavaRuleHooks = {}
export function setJavaRuleHooks(h: JavaRuleHooks) {
  javaHooks = h
}

function makeJava(scope: Scope, ctx: JsContext) {
  return {
    put: (k: string, v: unknown) => scope.put(k, v),
    // 原版 Kotlin 按参数个数重载：1 参=取变量，2~3 参=HTTP GET，这里同样按个数分流
    get: (a: unknown, b?: unknown, c?: unknown) =>
      b === undefined && c === undefined
        ? scope.get(String(a ?? ''))
        : syncProxy(String(a ?? ''), 'GET', parseHeaders(b)),
    log: (m: unknown) => {
      console.log('[js]', m)
      return m
    },
    toast: (m: unknown) => {
      console.log('[toast]', m)
      return String(m ?? '')
    },
    ajax: (url: unknown) => syncProxy(String(url)),
    // 缓存（对标 CacheManager）：页面内存实现（不碰 localStorage），支持发现页缓存分类/cookie 等
    cache: {
      get: (key: unknown): string | null => readCache(String(key ?? '')) ?? null,
      getFile: (key: unknown): string | null => readCache(String(key ?? '')) ?? null,
      put: (key: unknown, value: unknown): string => {
        writeCache(String(key ?? ''), String(value ?? ''))
        return String(value ?? '')
      },
      putFile: (key: unknown, value: unknown): string => {
        writeCache(String(key ?? ''), String(value ?? ''))
        return String(value ?? '')
      },
      delete: (key: unknown): void => {
        jsCache.delete(String(key ?? ''))
      },
    },
    connect: (url: unknown, header?: unknown) => syncProxy(String(url), 'GET', parseHeaders(header)),
    post: (url: unknown, body?: unknown, headers?: unknown) =>
      syncProxy(String(url), 'POST', { 'Content-Type': 'application/x-www-form-urlencoded', ...parseHeaders(headers) }, String(body ?? '')),
    getCookie: (_tag: unknown, _key?: unknown) => '',
    base64Encode: (s: unknown) => {
      const bytes = new TextEncoder().encode(String(s ?? ''))
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin)
    },
    base64Decode: (s: unknown) => {
      const bin = atob(String(s ?? '').trim())
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    },
    md5Encode: (s: unknown) => md5(String(s ?? '')),
    // 繁简转换（原版用词典；此处未内置完整词表，仅做兼容占位，避免规则报错）
    t2s: (s: unknown) => String(s ?? ''),
    s2t: (s: unknown) => String(s ?? ''),
    // 规则求值类（源码里常见：c=java.getElement('class.x'); if(!c.length){...}）
    getElement: (rule: unknown) => wrapEList(javaHooks.elements ? javaHooks.elements(ctx, String(rule ?? '')) : []),
    getElements: (rule: unknown) => wrapEList(javaHooks.elements ? javaHooks.elements(ctx, String(rule ?? '')) : []),
    getString: (rule: unknown) => (javaHooks.string ? javaHooks.string(ctx, String(rule ?? '')) : ''),
    getStringList: (rule: unknown) => (javaHooks.list ? javaHooks.list(ctx, String(rule ?? '')) : []),
    setContent: (v: unknown) => {
      scope.contentOverride = v
      return ''
    },
  }
}

export type JavaApi = ReturnType<typeof makeJava>

function defineProp(o: object, name: string, value: unknown) {
  try {
    Object.defineProperty(o, name, { value, writable: true, configurable: true, enumerable: false })
  } catch {
    /* ignore */
  }
}

/** 数组结果补 Java 式方法（toArray/size/get，对标 Rhino 里 Java List 的用法） */
function augmentList(arr: unknown[]): unknown[] {
  if ((arr as unknown as Record<string, unknown>).__legadoAug) return arr
  defineProp(arr, '__legadoAug', true)
  defineProp(arr, 'toArray', function (this: unknown[]) {
    return [...this]
  })
  defineProp(arr, 'size', function (this: unknown[]) {
    return this.length
  })
  defineProp(arr, 'get', function (this: unknown[], i: number) {
    return this[i]
  })
  return arr
}

function matchTops($: cheerio.CheerioAPI, tops: unknown[], sel: string): unknown[] {
  const out: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyScope = $ as any
  for (const el of tops) {
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

function loadTops(html: string): { $: cheerio.CheerioAPI; tops: unknown[] } | null {
  try {
    const $ = cheerio.load(html)
    const kids = $('body').children().toArray()
    return { $, tops: kids.length ? kids : $.root().children().toArray() }
  } catch {
    return null
  }
}

/**
 * 条目字符串包元素外观（select/attr/text/html/size/get，对标 Rhino 里 JSoup Element 的用法）。
 * 方法惰解析、不污染枚举，String() 可还原原始 HTML。
 */
export function wrapEl(html: string): String {
  const o = new String(html) as String & Record<string, (...args: never[]) => unknown>
  defineProp(o, 'select', (sel: unknown) => {
    try {
      const l = loadTops(html)
      if (!l) return wrapEList([])
      const found = matchTops(l.$, l.tops, String(sel ?? ''))
      return wrapEList(found.map((el) => l.$(el as never).toString()))
    } catch {
      return wrapEList([])
    }
  })
  defineProp(o, 'attr', (name: unknown) => {
    try {
      const l = loadTops(html)
      const first = l?.tops[0]
      if (!l || first === undefined) return ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return String((l.$(first as any) as any).attr(String(name ?? '')) ?? '')
    } catch {
      return ''
    }
  })
  defineProp(o, 'text', () => {
    try {
      const $ = cheerio.load(html)
      const t = $('body').text()
      return String((t || $.root().text()) ?? '').trim()
    } catch {
      return ''
    }
  })
  defineProp(o, 'html', () => {
    try {
      const l = loadTops(html)
      const first = l?.tops[0]
      if (!l || first === undefined) return ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return String((l.$(first as any) as any).html() ?? '')
    } catch {
      return ''
    }
  })
  defineProp(o, 'outerHtml', () => html)
  defineProp(o, 'size', () => 1)
  defineProp(o, 'get', (i: unknown) => (i === 0 ? o : undefined))
  return o
}

/** 列表包数组外观：条目逐个套外观 + 数组补 toArray/size/get + Elements 级 select/attr/text */
export function wrapEList(items: unknown[]): unknown[] {
  const arr: unknown[] = (items ?? []).map((x) => (typeof x === 'string' ? wrapEl(x) : x))
  augmentList(arr)
  const first = (): String | undefined => arr.find((x) => typeof x === 'object' && x !== null) as String | undefined
  defineProp(arr, 'select', (sel: unknown) => {
    const out: unknown[] = []
    for (const x of arr) {
      if (typeof x === 'object' && x !== null) {
        const r = (x as Record<string, (s: unknown) => unknown>).select?.(sel) as unknown[] | undefined
        if (Array.isArray(r)) out.push(...r)
      }
    }
    return wrapEList(out.map((x) => String(x)))
  })
  defineProp(arr, 'attr', (name: unknown) => {
    const f = first()
    return f ? String((f as unknown as Record<string, (n: unknown) => unknown>).attr?.(name) ?? '') : ''
  })
  defineProp(arr, 'text', () =>
    arr.map((x) => (typeof x === 'object' && x !== null ? String((x as unknown as Record<string, () => unknown>).text?.() ?? '') : String(x ?? ''))).join(' '),
  )
  defineProp(arr, 'html', () => {
    const f = first()
    return f ? String((f as unknown as Record<string, () => unknown>).html?.() ?? '') : ''
  })
  return arr
}

/** evalJsRule 入参整理：数组套外观（Rhino 元素写法可用），其余原样 */
function augmentInput(r: unknown): unknown {
  if (Array.isArray(r)) return wrapEList(r as unknown[])
  return r
}

const JS_PARAMS = [
  'result',
  'baseUrl',
  'key',
  'page',
  'java',
  'source',
  'book',
  'chapter',
  'title',
  'cookie',
  'cache',
  'infoMap',
] as const

/** 这些名字不进沙箱，仍由函数参数/全局提供（避免 with 遮住参数与内置对象） */
const SANDBOX_RESERVED = new Set<string>([
  ...JS_PARAMS,
  'JSON',
  'Math',
  'Date',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'RegExp',
  'Error',
  'Promise',
  'Map',
  'Set',
  'Symbol',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'btoa',
  'atob',
  'console',
  'eval',
  'Function',
  'arguments',
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
  'window',
])

/** 按源隔离的 JS 沙箱：隐式全局写进本源作用域，不污染其他源（对标 SharedJsScope） */
function makeSandbox(jsScope: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(jsScope, {
    // 只接管“非常规”名字；参数/内置对象/包装器自用变量一律放行，否则会遮住它们
    has: (_t, k) => typeof k === 'string' && !SANDBOX_RESERVED.has(k) && !k.startsWith('__legado_'),
    get: (t, k) => (k === Symbol.unscopables ? undefined : (t as Record<string | symbol, unknown>)[k]),
    set: (t, k, v) => {
      ;(t as Record<string | symbol, unknown>)[k] = v
      return true
    },
  })
}

/** 把 <js>xxx</js> / @js:xxx 剥出来执行，返回执行结果。
 *  对标 Rhino：松散模式（隐式全局不报错，承接到按源隔离的 jsScope 里），
 *  返回 completion value（多语句以最后表达式值为准）。 */
export function evalJsRule(code: string, ctx: JsContext, scope: Scope): unknown {
  const body = stripJsWrapper(code).trim()
  if (!body) return ctx.result ?? ''
  const java = makeJava(scope, ctx)
  const cookie = { getCookie: (_t: unknown, _k?: unknown) => readCache('cookie.' + String(_t ?? '')) ?? '' }
  // cache 绑定：与 java.cache 同一实现（规则里两种写法都有）
  const cache = (java as unknown as { cache: Record<string, unknown> }).cache
  const vals = [
    augmentInput(ctx.result ?? ''),
    ctx.baseUrl ?? '',
    ctx.key ?? '',
    ctx.page ?? 1,
    java,
    ctx.source ?? null,
    ctx.book ?? null,
    ctx.chapter ?? null,
    ctx.title ?? '',
    cookie,
    cache,
    ctx.infoMap ?? scope.infoMap ?? {},
  ]
  // 统一走 direct eval（对标 Rhino）：松散模式、宽松承接隐式全局、返回 completion value。
  // 表达式、多语句、无分号语句（如 if(x){y=1}）都能跑（早先按是否含 ';' 判表达式会误杀无分号语句）。
  try {
    const efn = new Function(
      ...JS_PARAMS,
      '__legado_scope_7f3a',
      '__legado_code_7f3a',
      'with(__legado_scope_7f3a){ return eval(__legado_code_7f3a); }',
    )
    const v = efn(...vals, makeSandbox(scope.jsScope), body)
    // completion value 为 undefined 时保留上一步结果（副作用型规则不冲掉 result）
    return v === undefined ? (ctx.result ?? '') : v
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    // 顶层 return / 纯表达式不适配 eval 时走下面备选；其他错误照旧抛出
    if (!/SyntaxError|Unexpected token|Invalid or unexpected|return/i.test(msg)) throw e
  }
  // 备选 1：函数体（允许顶层 return）
  try {
    const ffn = new Function(...JS_PARAMS, body)
    const v = ffn(...vals)
    return v === undefined ? (ctx.result ?? '') : v
  } catch {
    /* 继续备选 2 */
  }
  // 备选 2：纯表达式
  const xfn = new Function(...JS_PARAMS, `return (${body});`)
  return xfn(...vals)
}

/** 替换 {{...}} 模板：支持 key/page/baseUrl/result/source + java.get 等任意 JS 表达式。
 *  以 $./$[/@///(/<js>/@js: 开头的表达式视为嵌套规则，走 nested 回调（对标原版 makeUpRule
 *  里 {{}} 按规则求值的分支，如 {{$.book_id}}）。*/
export function applyTemplate(
  tpl: string,
  ctx: JsContext,
  scope?: Scope,
  nested?: (expr: string, result: unknown) => string | undefined,
): string {return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => {
    const e = expr.trim()
    if (e === 'key') return String(ctx.key ?? '')
    if (e === 'page') return String(ctx.page ?? 1)
    if (e === 'baseUrl') return String(ctx.baseUrl ?? '')
    if (e === 'result') return String(ctx.result ?? '')
    // 嵌套规则优先（如 {{$.book_id}}、{{//h1@text}}）
    if (nested) {
      const nv = nested(e, ctx.result)
      if (nv !== undefined) return nv
    }    try {
      const java = scope ? makeJava(scope, ctx) : undefined
      const v = new Function(
        'key',
        'page',
        'baseUrl',
        'result',
        'java',
        'source',
        'book',
        `return (${e});`,
      )(ctx.key ?? '', ctx.page ?? 1, ctx.baseUrl ?? '', augmentInput(ctx.result ?? ''), java, ctx.source ?? null, ctx.book ?? null)
      return v == null ? '' : String(v)
    } catch {
      return ''
    }
  })
}

