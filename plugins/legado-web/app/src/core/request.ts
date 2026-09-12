// 统一请求层：浏览器里走代理（绕 CORS + GBK），服务端（插件的规则引擎）里走注入的 transport。
// 基址见 core/apiBase.ts：
//   插件内运行时 = /plugins-api/legado-web（pi-web-ui 插件服务端 index.mjs 的 /proxy）
//   独立部署     = VITE_API_BASE / VITE_PROXY_URL 指定的 Worker/Node 地址
// 注入见下方 setProxyTransport / setSyncTransport（engine-entry.ts 导出给 Node 宿主）。

import type { FetchOptions } from '../types'
import { apiBase } from './apiBase'

export interface ProxyResponse {
  url: string
  body: string
  headers: Record<string, string>
  status: number
}

/** 服务端注入的抓取实现（Node 宿主直接调 net.mjs，不经 HTTP 代理）。 */
export type ProxyTransport = (target: string, opts: FetchOptions) => Promise<ProxyResponse>

/** 服务端注入的同步抓取（书源 JS 规则里的 java.ajax/connect/get/post 是同步语义，
 *  浏览器用同步 XHR，Node 宿主用 worker + Atomics 桥）。 */
export type SyncProxyTransport = (target: string, method: string, headers: Record<string, string>, body?: string) => string

let injected: ProxyTransport | null = null
let injectedSync: SyncProxyTransport | null = null

/** 由 Node 宿主（插件的规则引擎 worker）注入；传 null 则退回 HTTP 代理。 */
export function setProxyTransport(t: ProxyTransport | null): void {
  injected = t
}

export function getProxyTransport(): ProxyTransport | null {
  return injected
}

export function setSyncTransport(t: SyncProxyTransport | null): void {
  injectedSync = t
}

export function getSyncTransport(): SyncProxyTransport | null {
  return injectedSync
}

export function buildProxyUrl(target: string, charset?: string): string {
  const prefix = `${apiBase()}/proxy`
  const cs = charset?.trim()
  return `${prefix}?url=${encodeURIComponent(target)}${cs ? `&charset=${encodeURIComponent(cs)}` : ''}`
}

export async function fetchText(target: string, opts: FetchOptions = {}): Promise<ProxyResponse> {
  if (injected) return injected(target, opts)
  // charset 透传给代理：POST 编请求体，GET（gbk 等）重编码 URL 中的中文（对标原版 charset 语义）
  const res = await fetch(buildProxyUrl(target, opts.charset), {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body:
      opts.method && opts.method.toUpperCase() !== 'GET'
        ? JSON.stringify({ headers: opts.headers ?? {}, body: opts.body ?? '', charset: opts.charset ?? '' })
        : undefined,
  })
  if (!res.ok) {
    // 代理自身失败（如网络不可达）：把代理返回的具体原因带出来，便于“检测”页分类
    let detail = ''
    try {
      const j = (await res.json()) as { error?: string }
      if (j?.error) detail = j.error
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(`代理请求失败 ${res.status}${detail ? `（${detail}）` : ''} ${target}`)
  }
  const data = (await res.json()) as ProxyResponse
  return data
}

/** 解析书源 header 字段（JSON 字符串） */
export function parseHeader(header?: string): Record<string, string> {
  if (!header) return {}
  try {
    const o = JSON.parse(header) as Record<string, string>
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}
