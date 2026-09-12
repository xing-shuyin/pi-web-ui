/**
 * 章末导航（阅读页正文底部那一条）的纯逻辑：决定「上一章 / 下一章」能不能走、
 * 底部那行说明写什么。
 *
 * 为什么单独一个文件：main.ts 是直接操作 DOM 的应用（import 即开始跑、要 document），
 * 不方便单测；把判断抽成纯函数就能在 vitest 里钉住边界（第一章 / 最后一章 / 单章 / 空目录）。
 */

export type ChapterNavState = {
  /** 「上一章」可点（第一章不可） */
  canPrev: boolean
  /** 「下一章」可点（最后一章 / 空目录不可） */
  canNext: boolean
  /** 章末那行说明（调用方负责 esc 转义后再插进 DOM） */
  note: string
}

/**
 * @param idx      当前章下标（0 基）
 * @param total    目录总章数
 * @param bookName 书名（会原样进 note，调用方转义）
 */
export function chapterNavState(idx: number, total: number, bookName: string): ChapterNavState {
  if (!(total > 0)) return { canPrev: false, canNext: false, note: '目录为空 —— 用顶部「刷新」重拉目录' }
  const canPrev = idx > 0
  const canNext = idx < total - 1
  // 走到最后一章明说一句：不再让「下一章」点了没反应
  const note = `《${bookName}》· 第 ${idx + 1}/${total} 章${canNext ? '' : ' · 已是最后一章'}`
  return { canPrev, canNext, note }
}
