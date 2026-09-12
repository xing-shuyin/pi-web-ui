// 持久化（替代 Android Room）：书源 + 书架 + 阅读进度 + 检测结果。
// **只落数据目录文件** `<dataDir>/legado-web/*.json`：后端文件是唯一事实源，
// 页面里留一份内存镜像供同步渲染。不写 localStorage —— 书源动辄几 MB（5MB 配额
// 装不下会报 QuotaExceededError），而且清浏览器缓存就没了。
// 老版本的浏览器数据只做一次性只读迁移（见 hydrateFromBackend）。
import { backendAvailable, storeGet, storeMetas, storePut, type StoreMeta } from './core/backend'
import type { BookSource, Chapter } from './types'

const K_SOURCES = 'legado.sources.v1'
const K_SHELF = 'legado.shelf.v1'
const K_PROGRESS = 'legado.progress.v1'
const K_CHECK = 'legado.check.v1'
const K_PREFS = 'legado.prefs.v1'

/** 上一次检测结果（持久化，便于“书源”页直接标可用/不可用） */
export interface CheckRecord {
  ok: boolean
  /** ok 可用 / dead 废源（站点挂了/被墙/盾页/无搜索规则，可自动隐藏）/ suspect 可疑 */
  kind?: 'ok' | 'dead' | 'suspect'
  ts: number
  ms: number
  count?: number
  tocCount?: number
  reason: string
}

export const checkStore = {
  all(): Record<string, CheckRecord> {
    return read<Record<string, CheckRecord>>(K_CHECK, {})
  },
  get(url: string): CheckRecord | undefined {
    return this.all()[url]
  },
  setMany(map: Record<string, CheckRecord>) {
    write(K_CHECK, { ...this.all(), ...map })
  },
  clear() {
    write(K_CHECK, {})
  },
  /**
   * 删源时清掉它的检测记录（连 http/https、末尾 `/` `#` 的同址变体一起清）。
   * 不清的话：书源页顶部「废源 N」和检测页会一直挂着已删源，看着像“页面没刷新”。
   */
  removeBySource(sourceUrl: string): number {
    const norm = (u: string) => u.replace(/[/#]+$/, '')
    const all = this.all()
    const gone = Object.keys(all).filter((u) => norm(u) === norm(sourceUrl))
    if (!gone.length) return 0
    for (const u of gone) delete all[u]
    write(K_CHECK, all)
    return gone.length
  },
  /** 已判定为废源的书源 URL 集合（搜索默认跳过、列表默认隐藏） */
  deadUrls(): Set<string> {
    const s = new Set<string>()
    for (const [url, rec] of Object.entries(this.all())) {
      if (rec.kind === 'dead') s.add(url)
    }
    return s
  },
  counts(): { ok: number; dead: number; suspect: number; unchecked: number } {
    let ok = 0
    let dead = 0
    let suspect = 0
    for (const rec of Object.values(this.all())) {
      if (rec.kind === 'dead') dead++
      else if (rec.kind === 'ok') ok++
      else if (rec.kind === 'suspect') suspect++
    }
    const unchecked = Math.max(0, sourceStore.all().length - ok - dead - suspect)
    return { ok, dead, suspect, unchecked }
  },
}

export interface ShelfBook {
  bookUrl: string
  bookSourceUrl: string
  name: string
  author: string
  coverUrl?: string
  tocUrl?: string
  chapters?: Chapter[]
  /** 浏览器缓存里只留章节数（不存整份章节表，见 store-cache.ts）；与 chapters 二选一取 */
  chapterCount?: number
  chapterIndex?: number
}

/** 本会话的内存镜像：文件是事实源，页面里同步读的是它（渲染函数都是同步调用）。 */
const cache = new Map<string, unknown>()

function read<T>(k: string, fb: T): T {
  return cache.has(k) ? (cache.get(k) as T) : fb
}

/** 内存键 → 数据目录里的文件名（<dataDir>/legado-web/<name>.json）。 */
const BACKEND_KEY: Record<string, string> = {
  [K_SOURCES]: 'sources',
  [K_SHELF]: 'shelf',
  [K_PROGRESS]: 'progress',
  [K_CHECK]: 'check',
  [K_PREFS]: 'prefs',
}

/** 存储位置：'file' 数据目录文件（正常）/ 'browser' 只有内存（后端不可用或写入失败，刷新即丢）。 */
export const storageMode = { current: 'unknown' as 'unknown' | 'file' | 'browser' }

/** 写入降级时的通知（main.ts 注入状态栏提示；只报一次）。 */
export const storageEvents = {
  onDegraded: null as null | (() => void),
}

/**
 * 已知的文件版本（后端键 → `size:mtime`）：页面“看到的”内容对应哪个版本。
 * 与数据目录里当前版本不一致 = 文件被外部改过（AI 工具 / 另一个页面 / 手工编辑）。
 */
const fileVersion = new Map<string, string>()

function versionOf(meta?: StoreMeta | null): string {
  return meta ? `${meta.size}:${meta.mtime}` : ''
}

/** 记录某键的当前版本（写完 / hydrate 完调） */
function rememberVersion(key: string, meta?: StoreMeta | null) {
  if (meta) fileVersion.set(key, versionOf(meta))
}

/**
 * 数据目录里的文件是不是被“外部”改过了（页面自己的写入不算）。
 * 返回变化的后端键名（如 `['sources']`）；后端不可用 / 无变化返回 `[]`。
 * 调用方拿到非空结果后应 `hydrateFromBackend()` 重读再重渲染。
 */
export async function remoteStoreChanged(): Promise<string[]> {
  const metas = await storeMetas()
  if (!metas) return []
  const changed: string[] = []
  for (const [key, meta] of Object.entries(metas)) {
    if (fileVersion.get(key) !== versionOf(meta)) changed.push(key)
  }
  return changed
}
let degradedNotified = false
function degrade(why: string) {
  storageMode.current = 'browser'
  console.warn(`[存储] ${why}——数据只在内存里，刷新会丢（请确认 pi-web-ui 服务在运行）`)
  if (!degradedNotified) {
    degradedNotified = true
    try {
      storageEvents.onDegraded?.()
    } catch {
      /* 通知失败不影响存储 */
    }
  }
}

/** 写：内存立即生效，同时落数据目录文件（失败只降级，不抛错）。 */
function write(k: string, v: unknown) {
  cache.set(k, v)
  const bk = BACKEND_KEY[k]
  if (!bk) return
  void storePut(bk, v).then((r) => {
    if (r.ok) {
      storageMode.current = 'file'
      rememberVersion(bk, r.meta)
    } else {
      degrade(`写入 ${bk}.json 失败`)
    }
  })
}

/**
 * 启动时加载：**数据目录文件是唯一事实源**，读进内存镜像后界面才开始渲染。
 * 文件里没有、但浏览器 localStorage 有老数据时，做一次性迁移（只读浏览器，之后不再回写）。
 * 返回存储位置描述，供界面展示。
 */
export async function hydrateFromBackend(): Promise<'file' | 'file-seeded' | 'browser'> {
  if (!(await backendAvailable())) {
    degrade('后端不可用（/store 不通）')
    return 'browser'
  }
  let seeded = false
  for (const [memKey, bKey] of Object.entries(BACKEND_KEY)) {
    const remote = await storeGet<unknown>(bKey)
    if (remote != null) {
      cache.set(memKey, remote)
      continue
    }
    const legacy = legacyLocal(memKey)
    if (legacy != null) {
      // 老版本把数据放浏览器里：搬到文件一次，之后只认文件（顺手清掉老键）
      await storePut(bKey, legacy)
      cache.set(memKey, legacy)
      legacyRemove(memKey)
      seeded = true
    }
  }
  storageMode.current = 'file'
  // 记下“我们看到的版本”，之后用来发现外部改动（AI 改文件后页面能自动重读）
  const metas = await storeMetas()
  if (metas) {
    for (const [key, meta] of Object.entries(metas)) rememberVersion(key, meta)
  }
  return seeded ? 'file-seeded' : 'file'
}

/** 一次性迁移用的只读读取（我们不写 localStorage：几 MB 装不下、清缓存就没）。 */
function legacyLocal(key: string): unknown {
  try {
    const s = localStorage.getItem(key)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

/** 迁移成功后清掉浏览器里的老键（此后页面只在内存 + 数据目录文件里放数据）。 */
function legacyRemove(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export const sourceStore = {
  all(): BookSource[] {
    return read<BookSource[]>(K_SOURCES, [])
  },
  save(list: BookSource[]) {
    // 仅保留文本源
    write(K_SOURCES, list.filter((s) => (s.bookSourceType ?? 0) === 0))
  },
  addMany(list: BookSource[]) {
    const map = new Map(this.all().map((s) => [s.bookSourceUrl, s]))
    for (const s of list) {
      if ((s.bookSourceType ?? 0) !== 0) continue
      map.set(s.bookSourceUrl, s)
    }
    write(K_SOURCES, [...map.values()])
  },
  remove(url: string) {
    write(K_SOURCES, this.all().filter((s) => s.bookSourceUrl !== url))
    if (prefsStore.isPinned(url)) prefsStore.unpin(url) // 源都删了，置顶也一起清掉
  },
}

/** 本机偏好（目前只有置顶/收藏的书源 URL 列表），落 prefs.json。 */
export interface SourcePrefs {
  /** 置顶的书源 URL（列表里排在最前；与检测状态无关） */
  pinned: string[]
}

export const prefsStore = {
  all(): SourcePrefs {
    const v = read<Partial<SourcePrefs>>(K_PREFS, {})
    return { pinned: Array.isArray(v?.pinned) ? v.pinned.filter((u): u is string => typeof u === 'string') : [] }
  },
  pinnedSet(): Set<string> {
    return new Set(this.all().pinned)
  },
  isPinned(url: string): boolean {
    return this.pinnedSet().has(url)
  },
  count(): number {
    return this.all().pinned.length
  },
  /** 置顶 / 取消置顶；返回置顶后的状态。 */
  togglePin(url: string): boolean {
    const pinned = this.all().pinned
    const i = pinned.indexOf(url)
    if (i >= 0) pinned.splice(i, 1)
    else pinned.unshift(url)
    write(K_PREFS, { pinned })
    return i < 0
  },
  unpin(url: string) {
    const pinned = this.all().pinned.filter((u) => u !== url)
    write(K_PREFS, { pinned })
  },
  clearPins() {
    write(K_PREFS, { pinned: [] })
  },
}

export const shelfStore = {
  all(): ShelfBook[] {
    return read<ShelfBook[]>(K_SHELF, [])
  },
  upsert(b: ShelfBook) {
    const list = this.all()
    const i = list.findIndex((x) => x.bookUrl === b.bookUrl)
    if (i >= 0) list[i] = { ...list[i], ...b }
    else list.unshift(b)
    write(K_SHELF, list)
  },
  remove(bookUrl: string) {
    write(K_SHELF, this.all().filter((b) => b.bookUrl !== bookUrl))
  },
  /** 删除某个书源的全部书（删源就删书），返回移出的本数；顺手清掉这些书的阅读进度 */
  removeBySource(sourceUrl: string): number {
    const list = this.all()
    const gone = list.filter((b) => b.bookSourceUrl === sourceUrl)
    if (!gone.length) return 0
    write(
      K_SHELF,
      list.filter((b) => b.bookSourceUrl !== sourceUrl),
    )
    const p = read<Record<string, number>>(K_PROGRESS, {})
    for (const b of gone) delete p[b.bookUrl]
    write(K_PROGRESS, p)
    return gone.length
  },
  progress(bookUrl: string): number {
    const p = read<Record<string, number>>(K_PROGRESS, {})
    return p[bookUrl] ?? 0
  },
  saveProgress(bookUrl: string, idx: number) {
    const p = read<Record<string, number>>(K_PROGRESS, {})
    p[bookUrl] = idx
    write(K_PROGRESS, p)
  },
}
