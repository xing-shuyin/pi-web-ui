// 后端基址（代理 + 本地存储）。
//
// 这个前端有两种运行形态：
//   1) 作为 pi-web-ui 插件视图：页面在 <前缀>/plugins/legado-web/client/app/index.html，
//      接口在 <前缀>/plugins-api/legado-web/*（插件服务端 index.mjs 注册）。
//      这里按页面路径推导，前缀（如 nginx 子路径 /pi）自动带上。
//   2) 独立跑：VITE_API_BASE / VITE_PROXY_URL 显式指定（如 Worker/Node 部署），
//      都没给时回落同源 '/'（配合本地开发代理）。

function envOf(name: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
  return String(env[name] ?? '').trim()
}

/** 例：/pi/plugins/legado-web/client/app/index.html → /pi/plugins-api/legado-web */
function baseFromLocation(): string {
  if (typeof location === 'undefined') return ''
  const m = /^(.*)\/plugins\/([^/]+)\/client\//.exec(location.pathname)
  if (m) return `${m[1]}/plugins-api/${m[2]}`
  return ''
}

/** 接口根：'' 表示同源根路径（'/proxy'、'/store'）。 */
export function apiBase(): string {
  const explicit = envOf('VITE_API_BASE') || envOf('VITE_PROXY_URL')
  if (explicit) return explicit.replace(/\/$/, '')
  return baseFromLocation()
}
