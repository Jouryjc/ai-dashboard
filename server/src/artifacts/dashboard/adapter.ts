import type {
  ArtifactManifest,
  TargetProfile,
  ValidationGateResult,
  ValidationReport
} from '../../wire'
import type { ArtifactAdapter, ArtifactDraft } from '../types'

function gate(
  id: string,
  title: string,
  passed: boolean,
  detail: string | null = null
): ValidationGateResult {
  return { id, title, status: passed ? 'passed' : 'failed', detail }
}

/**
 * Dashboard code may only read its colocated data file. Preview responses inline
 * that file and enforce connect-src 'none', while this gate also protects exported
 * artifacts and catches accidental network code before a revision is accepted.
 */
export function hasOnlyAllowedDashboardNetwork(html: string): boolean {
  const fetchCalls = html.match(/\bfetch\s*\(/gi)?.length ?? 0
  const allowedFetchCalls =
    html.match(/\bfetch\s*\(\s*(["'])\.\/data\.json\1\s*\)/gi)?.length ?? 0
  if (fetchCalls !== allowedFetchCalls) return false

  return !(
    /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|SharedWorker|Worker)\b/i.test(html) ||
    /(?:globalThis|window|self)\s*\[\s*["'](?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)["']\s*\]/i.test(html) ||
    /<\s*(?:base|form)\b|<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b/i.test(html)
  )
}

export const dashboardArtifactAdapter: ArtifactAdapter = {
  kind: 'dashboard',

  createTargetProfile(): TargetProfile {
    return {
      framework: 'static-html',
      uiLibrary: 'none',
      uiLibraryVersion: null,
      viewportProfiles: ['1920x1080', '2560x1440']
    }
  },

  createManifest(draft?: ArtifactDraft): ArtifactManifest {
    const files = draft ? Object.keys(draft.files).sort() : ['index.html']
    return {
      schemaVersion: 1,
      kind: 'dashboard',
      entryFile: draft?.entryFile ?? 'index.html',
      files,
      exportFormat: 'html'
    }
  },

  validateDraft(draft: ArtifactDraft): ValidationReport {
    const html = draft.files[draft.entryFile] ?? ''
    const gates = [
      gate('html-document', '完整 HTML 文档', /<html[\s>]/i.test(html), '缺少 html 标签'),
      gate('html-closed', 'HTML 文档闭合', /<\/html>/i.test(html), '缺少 </html>'),
      gate('body-present', '页面正文存在', /<body[\s>]/i.test(html), '缺少 body 标签'),
      gate('body-closed', '页面正文闭合', /<\/body>/i.test(html), '缺少 </body>'),
      gate('minimum-content', '页面内容完整', html.length >= 2048, '内容少于 2048 字节'),
      gate(
        'runtime-data-loader',
        '真实数据在运行时加载',
        !('data.json' in draft.files) ||
          /fetch\(\s*["']\.\/data\.json["']\s*\)/.test(html) ||
          /id\s*=\s*["']dashboard-data["']/.test(html),
        '存在 data.json，但页面没有同源数据加载器'
      ),
      gate(
        'no-external-resources',
        '不引用外部资源',
        !(
          /(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(html) ||
          /url\(\s*["']?\s*https?:\/\//i.test(html)
        ),
        '检测到外部资源地址'
      ),
      gate(
        'network-policy',
        '仅访问当前产物的事实数据',
        hasOnlyAllowedDashboardNetwork(html),
        "仅允许 fetch('./data.json')，禁止其他网络 API、表单和跳转"
      )
    ]
    return {
      status: gates.every(item => item.status === 'passed') ? 'passed' : 'failed',
      gates
    }
  },

  exportFileName(projectName: string, revisionLabel: string): string {
    return `${projectName}-${revisionLabel}.html`
  }
}
