// 页面级异常识别（盾页/乱码/空页）与网络错误分类，供「检测」和正文抓取共用。
// 抽成独立模块避免 check.ts ↔ webBook.ts 循环依赖。

/** 人机验证/盾页特征（小写包含匹配） */
const BLOCK_MARKS = [
  'just a moment',
  'cf-mitigated',
  '__cf_chl',
  'attention required',
  'enable javascript and cookies to continue',
  'checking your browser',
  '请输入验证码',
  '安全验证',
  '访问验证',
]

/** 返回问题描述（没问题返回 null） */
export function detectPageProblem(body: string): string | null {
  const head = body.slice(0, 6000).toLowerCase()
  for (const m of BLOCK_MARKS) {
    if (head.includes(m)) return '站点人机验证（Cloudflare/盾），本项目不支持过验证'
  }
  const sample = body.slice(0, 20000)
  const bad = (sample.match(/\ufffd/g) ?? []).length
  if (bad > 20) return '页面编码异常（源未声明 charset，GBK 站中文可能乱码）'
  if (sample.trim().length === 0) return '返回内容为空'
  return null
}

/** 网络错误分类为中文结论 */
export function classifyError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('enotfound') || m.includes('eai_again')) return '网络不可达：域名解析失败（DNS 黑洞/被墙）'
  if (m.includes('econnrefused')) return '网络不可达：连接被拒绝'
  if (m.includes('timeout') || m.includes('etimedout') || m.includes('und_err_connect_timeout')) return '网络不可达：连接超时'
  if (m.includes('econnreset') || m.includes('socket hang up')) return '网络不可达：连接被重置（可能被墙）'
  if (m.includes('fetch failed')) return '网络不可达：代理到目标站请求失败'
  if (m.includes('cert')) return 'HTTPS 证书错误'
  return msg
}

/** 判断是否网络层错误（而非站点/规则错误） */
export function isNetworkError(msg: string): boolean {
  return /代理请求失败|fetch failed|ENOTFOUND|ECONN|timeout|ETIMEDOUT|certificate/i.test(msg)
}

/**
 * 正文内容是否是“站点提示/报错”而非小说内容（如“当前版本过低，请升级”）。
 * 这类源表面能返回内容，实际读不了，应算废源。
 */
export function detectContentNotice(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  // 只在短文本里判定，避免把正文中偶然出现的词误判
  const sample = t.slice(0, 300)
  const marks: Array<[RegExp, string]> = [
    [/版本过低|版本太低|请升级到最新版|升级到新版本/, '站点要求升级客户端（旧接口已停用）'],
    [/已停止使用|已停止服务|服务已下线/, '站点声明服务已停止'],
    [/请(下载|安装|使用)\s*(最新版|官方)?\s*(APP|app|客户端)/, '站点要求使用其客户端'],
    [/内容(已下架|不存在|被删)|本章(不存在|已删除)|章节不存在/, '章节已不存在/已下架'],
    [/(登录|登陆)(后|才能)?.{0,6}(阅读|查看|继续)/, '需要登录后才能阅读'],
    [/VIP|会员(专享|章节)/, 'VIP/会员章节'],
  ]
  if (t.length <= 300) {
    for (const [re, reason] of marks) {
      if (re.test(sample)) return reason
    }
  } else {
    // 长文本：只认最确定的“升级客户端”类提示
    if (/版本过低|请升级到最新版/.test(sample)) return '站点要求升级客户端（旧接口已停用）'
  }
  return null
}
