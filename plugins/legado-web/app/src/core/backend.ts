// 后端（本地存储服务）访问层：书源/书架/进度存到插件目录 storage/*.json，
// （**不写浏览器 localStorage**：书源几 MB 装不下，清缓存还会丢；便于备份、换浏览器、直接查看/编辑。）
// 基址见 core/apiBase.ts（插件内 = /plugins-api/legado-web/store，独立部署 = VITE_API_BASE）。

import { apiBase } from './apiBase'

/** 一个键文件的版本信息（数据目录里的 size + mtime） */
export interface StoreMeta {
  size: number
  mtime: number
}

/** 存储接口只有一个路径，键走 query —— pi-web-ui 插件路由是精确匹配，不带路径参数。 */
function storeUrl(key?: string): string {
  const prefix = `${apiBase()}/store`
  return key ? `${prefix}?key=${encodeURIComponent(key)}` : prefix
}

/** 版本信息接口（一次拿全部键的 size+mtime） */
function metaUrl(): string {
  return `${apiBase()}/store?meta=1`
}

/** 后端（本地存储）是否可用 */
export async function backendAvailable(): Promise<boolean> {
  try {
    const res = await fetch(storeUrl(), { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

export async function storeGet<T>(key: string): Promise<T | null> {
  try {
    const res = await fetch(storeUrl(key), { method: 'GET' })
    if (!res.ok) return null
    const j = (await res.json()) as { value?: T }
    return (j?.value ?? null) as T | null
  } catch {
    return null
  }
}

export async function storePut(key: string, value: unknown): Promise<{ ok: boolean; meta?: StoreMeta | null }> {
  try {
    const res = await fetch(storeUrl(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    })
    if (!res.ok) return { ok: false }
    // 回带的 meta：把自己写的版本记下来，避免下次巡检把自己的写入当成“外部改动”
    const j = (await res.json().catch(() => null)) as { meta?: StoreMeta | null } | null
    return { ok: true, meta: j?.meta ?? null }
  } catch {
    return { ok: false }
  }
}

/** 数据目录里各键文件的版本信息；后端不可用/接口不支持返回 null。 */
export async function storeMetas(): Promise<Record<string, StoreMeta> | null> {
  try {
    const res = await fetch(metaUrl(), { method: 'GET' })
    if (!res.ok) return null
    const j = (await res.json()) as { metas?: Record<string, StoreMeta> }
    return j?.metas ?? null
  } catch {
    return null
  }
}
