/**
 * 输入边界 —— 所有外部输入进系统前的统一卡口。
 *
 * 为什么单独一个文件：路径参数校验（修目录遍历漏洞）、消息内容校验、
 * 范围快判、限流都是「不信任外部输入」的同一层防线，放一起便于审计。
 * 全部手写、不引依赖；报错一律 HttpError + 大白话，由 routes 的 wrap() 转成 { error } JSON。
 */
import { HttpError } from './orchestrator'

/* ------------------------------ 路径参数 ------------------------------ */

// dashId / versionId 等会 path.join 进文件系统，传 ../../ 就是目录遍历。
// 我们的 id 全部是自己生成的（时间戳/随机串），只含字母数字下划线连字符，
// 所以白名单校验不会误伤正常请求。
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function assertSafeId(id: string): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new HttpError(400, '请求参数不对')
  }
  return id
}

/* ------------------------------ 消息内容 ------------------------------ */

const TEXT_MAX_CHARS = 4000
const ATTACHMENT_MAX_COUNT = 3
// base64 解码后的真实字节数上限（base64 文本会比原图大约 1/3）
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
const ATTACHMENT_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/

export function checkMessageInput(text: string, attachments: string[]): void {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new HttpError(400, '说点什么再发吧，消息不能是空的')
  }
  if (text.length > TEXT_MAX_CHARS) {
    throw new HttpError(400, '这条消息太长了，最多 4000 字，精简一下再发')
  }
  if (attachments.length > ATTACHMENT_MAX_COUNT) {
    throw new HttpError(400, '图片最多带 3 张，删掉几张再发')
  }
  for (const att of attachments) {
    const m = typeof att === 'string' ? ATTACHMENT_DATA_URL.exec(att) : null
    if (!m) {
      throw new HttpError(400, '图片格式不对：只支持 PNG、JPG、WebP 图片')
    }
    // 估不准 base64 里的填充和换行，直接解码量真实大小最稳妥
    const bytes = Buffer.from(m[2], 'base64').length
    if (bytes === 0) {
      throw new HttpError(400, '图片是空的，换一张再试')
    }
    if (bytes > ATTACHMENT_MAX_BYTES) {
      throw new HttpError(400, '图片太大了：每张不能超过 5MB，压缩一下再发')
    }
  }
}

/* ------------------------------ 范围快判 ------------------------------ */

/**
 * 确定性规则快判用户消息是否在「做数据大屏、改大屏、问数据展示」范围内。
 * 这是第一道便宜的闸：明显跑题的直接拒，拿不准的交給后面的模型判断。
 * 原则：宁可 unsure 不可误判 no —— 误拒正常用户需求比多调一次模型代价大。
 *
 * 判定顺序有讲究：
 * 1. 先查套话/注入（问提示词密钥、让扮演角色）——就算顺带提到大屏也拒
 * 2. 再查明显相关词和短动作指令 —— 命中即 yes
 * 3. 最后查明显跑题词 —— 到这一步说明一个大屏相关词都没有，才判 no
 */
const SENSITIVE_RE =
  /系统提示词|提示词|system\s*prompt|密钥|api\s*key|secret|password|密码|token|扮演|假装你|越狱|jailbreak/i

const IN_SCOPE_RE =
  /大屏|数据|图表|看板|指标|展示|可视化|面板|柱状|折线|饼图|地图|表格|标题|颜色|样式|背景|字体|布局|排行|趋势|占比|报表|仪表盘|卡片|改成|换成|加一个|删掉/

// 很短的动作指令（「改大一点」「换个颜色」这类）通常是对当前大屏的追问
const SHORT_ACTION_RE = /改|换|加|删|调|放大|缩小|大点|小点|亮点|暗点|重新|再来/

const OUT_OF_SCOPE_RE =
  /天气|气温|下雨|小说|讲故事|写诗|诗歌|作文|翻译|股票|炒股|基金|理财|荐股|投资建议|八卦|星座|算命|女朋友|男朋友|结婚|你多大了|你几岁/

export function isLikelyInScope(text: string): 'yes' | 'no' | 'unsure' {
  const t = text.trim()
  if (t.length === 0) return 'unsure'
  if (SENSITIVE_RE.test(t)) return 'no'
  if (IN_SCOPE_RE.test(t)) return 'yes'
  if (t.length <= 10 && SHORT_ACTION_RE.test(t)) return 'yes'
  if (OUT_OF_SCOPE_RE.test(t)) return 'no'
  return 'unsure'
}

/* ------------------------------ 限流 ------------------------------ */

/**
 * 手写滑动窗口限流：每个 key（如 IP）一分钟内最多放行 maxPerMinute 次。
 * 不引依赖、不起定时器（避免进程退出悬挂），靠调用时顺带清扫过期记录。
 */
export function createRateLimiter(maxPerMinute: number): (key: string) => boolean {
  const WINDOW_MS = 60_000
  const hits = new Map<string, number[]>()
  let lastSweep = Date.now()

  return (key: string): boolean => {
    const now = Date.now()
    // 定期全表清扫，防止 Map 只增不减变成内存漏斗
    if (now - lastSweep > WINDOW_MS) {
      for (const [k, arr] of hits) {
        const kept = arr.filter((t) => now - t < WINDOW_MS)
        if (kept.length === 0) hits.delete(k)
        else hits.set(k, kept)
      }
      lastSweep = now
    }
    const arr = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
    if (arr.length >= maxPerMinute) {
      hits.set(key, arr)
      return false
    }
    arr.push(now)
    hits.set(key, arr)
    return true
  }
}
