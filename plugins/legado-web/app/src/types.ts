// 对应 Android 端 app/.../data/entities/BookSource.kt + rule/*.kt
// 仅保留文本源（bookSourceType = 0）核心字段，其余原样透传以兼容书源 JSON。

export interface SearchRule {
  bookList?: string
  name?: string
  author?: string
  kind?: string
  wordCount?: string
  lastChapter?: string
  intro?: string
  coverUrl?: string
  bookUrl?: string
}

export interface BookInfoRule {
  /** 初始化规则：先执行，结果作为后续规则的求值根（对标原版） */
  init?: string
  name?: string
  author?: string
  kind?: string
  wordCount?: string
  lastChapter?: string
  intro?: string
  coverUrl?: string
  tocUrl?: string
}

export interface TocRule {
  chapterList?: string
  chapterName?: string
  chapterUrl?: string
  isVolume?: string
  updateTime?: string
  nextTocUrl?: string
}

export interface ContentRule {
  content?: string
  nextContentUrl?: string
  webJs?: string
  sourceRegex?: string
  replaceRegex?: string
  imageStyle?: string
}

export interface ExploreRule {
  bookList?: string
  name?: string
  author?: string
  kind?: string
  intro?: string
  coverUrl?: string
  bookUrl?: string
}

export interface BookSource {
  bookSourceUrl: string
  bookSourceName: string
  bookSourceGroup?: string
  /** 0 文本（本项目只支持 0，非 0 会被过滤） */
  bookSourceType?: number
  bookUrlPattern?: string
  enabled?: boolean
  enabledExplore?: boolean
  jsLib?: string
  header?: string
  loginUrl?: string
  loginCheckJs?: string
  exploreUrl?: string
  searchUrl?: string
  ruleExplore?: ExploreRule
  ruleSearch?: SearchRule
  ruleBookInfo?: BookInfoRule
  ruleToc?: TocRule
  ruleContent?: ContentRule
  [k: string]: unknown
}

export interface SearchBook {
  bookSourceUrl: string
  bookSourceName: string
  name: string
  author: string
  kind?: string
  intro?: string
  coverUrl?: string
  bookUrl: string
  wordCount?: string
  lastChapter?: string
}

export interface BookInfo {
  name?: string
  author?: string
  kind?: string
  intro?: string
  coverUrl?: string
  tocUrl: string
  lastChapter?: string
  wordCount?: string
}

export interface Chapter {
  name: string
  url: string
  isVolume?: boolean
  updateTime?: string
}

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 请求体编码（书源 ,{json} 里的 charset，如 gbk；默认 utf-8） */
  charset?: string
}
