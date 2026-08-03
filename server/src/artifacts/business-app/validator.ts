/**
 * business-app 浏览器验收器。
 *
 * 在 1920×1080 与 1366×768 两个独立页面中检查应用壳、IDux 样式、可访问性、布局和网络边界，
 * 随后逐一执行蓝图声明的业务验收场景。
 */
import fs from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import type { ValidationGateResult } from '../../wire'
import type {
  BusinessAppAcceptanceScenario,
  BusinessAppScenarioStep
} from './domain/model'

/** 浏览器验收结果以及用于视觉复核的截图。 */
export interface BusinessAppRuntimeValidation {
  gates: ValidationGateResult[]
  screenshot: Buffer | null
  smallScreenshot: Buffer | null
  scenarioScreenshots: Buffer[]
}

/** 单个视口采集的运行时结构和视觉指标。 */
interface RuntimeAudit {
  appShell: boolean
  moduleCount: number
  heading: string
  themeToken: string
  buttonToken: string
  cardToken: string
  bodyBackground: string
  headingContrast: number
  headingFontSize: number
  minControlHeight: number
  nativeInteractiveCount: number
  pageOverflow: boolean
  workspaceWidth: number
  visiblePrimaryAction: boolean
}

/** 按优先级查找可用 Chromium、Chrome 或 Edge 可执行文件。 */
function browserExecutable(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(candidate => fs.existsSync(candidate))
}

/** 创建格式统一的验收门禁结果。 */
function gate(id: string, title: string, passed: boolean, detail: string | null = null): ValidationGateResult {
  return { id, title, status: passed ? 'passed' : 'failed', detail: passed ? null : detail }
}

/** 监听页面脚本错误和越出预览源站的网络请求。 */
function collectRuntimeSignals(
  page: Page,
  expectedOrigin: string,
  errors: string[],
  externalRequests: Set<string>
): void {
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const location = message.location().url
    if (/Failed to load resource/i.test(message.text()) && /\/favicon\.ico(?:$|\?)/i.test(location)) return
    errors.push(location ? `${message.text()}（${location}）` : message.text())
  })
  page.on('request', request => {
    const requested = new URL(request.url())
    if (requested.origin !== expectedOrigin) externalRequests.add(requested.origin)
  })
}

/** 在页面上下文采集结构、样式、对比度和溢出指标。 */
async function audit(page: Page): Promise<RuntimeAudit> {
  return page.evaluate(`(() => {
    const number = value => Number.parseFloat(value || '0') || 0
    const rgb = value => {
      const parts = value.match(/[\\d.]+/g)
      return parts && parts.length >= 3 ? parts.slice(0, 3).map(Number) : null
    }
    const luminance = color => {
      const parsed = rgb(color)
      if (!parsed) return null
      const channel = parsed.map(value => {
        const normalized = value / 255
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2]
    }
    const contrast = (foreground, background) => {
      const a = luminance(foreground)
      const b = luminance(background)
      if (a === null || b === null) return 0
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const visible = element => {
      if (!element) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 &&
        style.visibility !== 'hidden' && style.display !== 'none'
    }
    const shell = document.querySelector('.business-app-shell')
    const workspace = document.querySelector('.app-workspace')
    const heading = document.querySelector('h1')
    const primary = document.querySelector('.ix-button-primary')
    const card = document.querySelector('.ix-card')
    const bodyStyle = getComputedStyle(document.body)
    const headingStyle = heading ? getComputedStyle(heading) : null
    const rootStyle = getComputedStyle(document.documentElement)
    const controls = [...document.querySelectorAll('.view-heading .ix-button, .app-navigation .ix-button, .top-navigation .ix-button, .ix-input, .ix-select-selector')]
    const heights = controls.map(item => item.getBoundingClientRect().height).filter(value => value > 0)
    return {
      appShell: Boolean(shell),
      moduleCount: Number(shell?.getAttribute('data-module-count') || '0'),
      heading: heading?.textContent?.trim() || '',
      themeToken: rootStyle.getPropertyValue('--ix-color-bg').trim(),
      buttonToken: primary ? getComputedStyle(primary).getPropertyValue('--ix-button-height-md').trim() : '',
      cardToken: card ? getComputedStyle(card).getPropertyValue('--ix-card-padding-size-md').trim() : '',
      bodyBackground: bodyStyle.backgroundColor,
      headingContrast: headingStyle ? contrast(headingStyle.color, bodyStyle.backgroundColor) : 0,
      headingFontSize: headingStyle ? number(headingStyle.fontSize) : 0,
      minControlHeight: heights.length ? Math.min(...heights) : 0,
      nativeInteractiveCount: document.querySelectorAll('button:not(.ix-button), select, textarea:not(.ix-textarea-inner), input:not(.ix-input-inner)').length,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      workspaceWidth: workspace?.getBoundingClientRect().width || 0,
      visiblePrimaryAction: visible(primary)
    }
  })()`) as Promise<RuntimeAudit>
}

/** 根据字段控件类型填写文本、数值或选择项。 */
async function fillField(page: Page, field: string, value: string | number | boolean): Promise<void> {
  const root = page.locator(`[data-testid="field-${field}"]`).first()
  if (await root.count() === 0) throw new Error(`找不到表单字段 ${field}`)
  const editable = root.locator('textarea, input').first()
  const input = await editable.count() > 0 ? editable : root
  const readOnly = await input.getAttribute('readonly').catch(() => null)
  if (readOnly !== null || (await root.getAttribute('class') ?? '').includes('select')) {
    await root.click()
    const exactOption = page.locator('.ix-select-option').filter({ hasText: String(value) }).first()
    const option = await exactOption.count() > 0 ? exactOption : page.locator('.ix-select-option').first()
    if (await option.count() === 0) throw new Error(`字段 ${field} 没有可选项`)
    await option.click()
    return
  }
  await input.fill(String(value))
}

/** 执行一个验收原子步骤，并在不满足预期时立即给出明确错误。 */
async function executeStep(page: Page, step: BusinessAppScenarioStep, moduleId: string): Promise<void> {
  switch (step.kind) {
    case 'navigate': {
      const target = page.locator(`[data-testid="view-${step.viewId}"]`)
      if (!await target.isVisible().catch(() => false)) {
        const moduleButton = page.locator(`[data-testid="module-${moduleId}"]`).first()
        if (await moduleButton.count() > 0) await moduleButton.click()
      }
      if (!await target.isVisible().catch(() => false)) throw new Error(`无法导航到视图 ${step.viewId}`)
      return
    }
    case 'select-first-record': {
      const row = page.locator('[data-testid="record-table"] tbody tr').first()
      if (!await row.isVisible().catch(() => false)) throw new Error('列表没有可选择的首条记录')
      return
    }
    case 'click-action': {
      const action = page.locator(`[data-testid="action-${step.actionId}"]`).first()
      if (!await action.isVisible().catch(() => false)) throw new Error(`操作 ${step.actionId} 不可见`)
      await action.click()
      return
    }
    case 'fill-form':
      for (const [field, value] of Object.entries(step.values)) await fillField(page, field, value)
      return
    case 'submit-form': {
      const submit = page.locator('[data-testid^="action-"][data-testid*="submit"]').first()
      if (!await submit.isVisible().catch(() => false)) throw new Error('当前表单没有可执行的提交操作')
      await submit.click()
      return
    }
    case 'confirm-action': {
      const confirm = page.locator('[data-testid="confirm-action"]').first()
      if (!await confirm.isVisible().catch(() => false)) throw new Error('高风险操作没有出现二次确认')
      await confirm.click()
      return
    }
    case 'assert-view':
      if (!await page.locator(`[data-testid="view-${step.viewId}"]`).isVisible().catch(() => false)) {
        throw new Error(`期望视图 ${step.viewId} 没有显示`)
      }
      return
    case 'assert-record': {
      const tableText = await page.locator('[data-testid="record-table"]').textContent() ?? ''
      if (!tableText.includes(String(step.value))) throw new Error(`列表没有出现验收记录：${step.field}=${String(step.value)}`)
      return
    }
    case 'assert-record-absent': {
      const tableText = await page.locator('[data-testid="record-table"]').textContent() ?? ''
      if (tableText.includes(String(step.value))) throw new Error(`列表仍然包含应移除的记录：${step.field}=${String(step.value)}`)
      return
    }
    case 'assert-feedback': {
      const feedback = await page.locator('[data-testid="business-feedback"]').textContent() ?? ''
      if (!feedback.includes(step.contains)) throw new Error(`操作反馈不符合预期：${step.contains}`)
      return
    }
  }
}

/** 在独立浏览器页中执行单个场景，避免不同场景之间共享脏状态。 */
async function runScenario(
  browser: Browser,
  url: string,
  expectedOrigin: string,
  scenario: BusinessAppAcceptanceScenario,
  viewport: '1920x1080' | '1366x768',
  errors: string[],
  externalRequests: Set<string>
): Promise<{ passed: boolean; detail: string | null; screenshot: Buffer | null }> {
  const [width, height] = viewport.split('x').map(Number)
  const page = await browser.newPage({ viewport: { width, height } })
  collectRuntimeSignals(page, expectedOrigin, errors, externalRequests)
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
    if (!response?.ok()) return { passed: false, detail: `预览返回 HTTP ${response?.status() ?? '未知'}`, screenshot: null }
    for (const [index, step] of scenario.steps.entries()) {
      try {
        await executeStep(page, step, scenario.moduleId)
        await page.waitForTimeout(60)
      } catch (error) {
        return {
          passed: false,
          detail: `第 ${index + 1} 步 ${step.kind} 失败：${error instanceof Error ? error.message : String(error)}`,
          screenshot: await page.screenshot({ type: 'png', fullPage: false })
        }
      }
    }
    return { passed: true, detail: null, screenshot: await page.screenshot({ type: 'png', fullPage: false }) }
  } finally {
    await page.close()
  }
}

/** 执行业务应用的双视口结构检查与全部端到端验收场景。 */
export async function validateBuiltBusinessApp(
  url: string,
  scenarios: BusinessAppAcceptanceScenario[] = []
): Promise<BusinessAppRuntimeValidation> {
  const executablePath = browserExecutable()
  if (!executablePath) throw new Error('浏览器验收环境不可用：请安装 Chromium、Chrome 或 Edge')
  const browser = await chromium.launch({ headless: true, executablePath })
  const errors: string[] = []
  const externalRequests = new Set<string>()
  const scenarioScreenshots: Buffer[] = []
  let screenshot: Buffer | null = null
  let smallScreenshot: Buffer | null = null
  try {
    const expectedOrigin = new URL(url).origin
    const audits: Array<{ viewport: '1920x1080' | '1366x768'; audit: RuntimeAudit; responseOk: boolean }> = []
    for (const viewport of ['1920x1080', '1366x768'] as const) {
      const [width, height] = viewport.split('x').map(Number)
      const page = await browser.newPage({ viewport: { width, height } })
      collectRuntimeSignals(page, expectedOrigin, errors, externalRequests)
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.evaluate('document.fonts ? document.fonts.ready : Promise.resolve()')
      const result = await audit(page)
      const shot = await page.screenshot({ type: 'png', fullPage: false })
      if (viewport === '1920x1080') screenshot = shot
      else smallScreenshot = shot
      audits.push({ viewport, audit: result, responseOk: Boolean(response?.ok()) })
      await page.close()
    }
    const large = audits[0]!.audit
    const small = audits[1]!.audit
    const gates: ValidationGateResult[] = [
      gate('runtime-http', '双视口都可以正常加载', audits.every(item => item.responseOk), '至少一个视口无法加载'),
      gate('runtime-application-shell', '呈现完整业务应用结构', large.appShell && large.moduleCount > 0 && large.heading.length > 0, '缺少应用壳、业务模块或视图标题'),
      gate('runtime-idux-styles', 'IDux 主题与组件样式真实生效', Boolean(large.themeToken && large.buttonToken && large.cardToken), '缺少 IDux 主题、按钮或卡片设计变量'),
      gate('visual-color-contrast', '标题与背景对比清晰', large.bodyBackground !== 'rgba(0, 0, 0, 0)' && large.headingContrast >= 4.5, `背景 ${large.bodyBackground}，对比度 ${large.headingContrast.toFixed(2)}:1`),
      gate('idux-interactive-components', '交互控件没有退化为原生组件', large.nativeInteractiveCount === 0, `检测到 ${large.nativeInteractiveCount} 个原生交互控件`),
      gate('large-screen-layout', '1920×1080 应用布局完整', !large.pageOverflow && large.workspaceWidth >= 1100 && large.headingFontSize >= 28, `页面溢出：${large.pageOverflow ? '是' : '否'}；工作区 ${large.workspaceWidth}px；标题 ${large.headingFontSize}px`),
      gate('small-screen-layout', '1366×768 应用布局可用', !small.pageOverflow && small.workspaceWidth >= 900 && small.headingFontSize >= 24 && small.minControlHeight >= 28 && small.visiblePrimaryAction, `页面溢出：${small.pageOverflow ? '是' : '否'}；工作区 ${small.workspaceWidth}px；标题 ${small.headingFontSize}px；最小控件 ${small.minControlHeight}px`)
    ]
    for (const scenario of scenarios) {
      for (const viewport of scenario.viewportProfiles) {
        const result = await runScenario(browser, url, expectedOrigin, scenario, viewport, errors, externalRequests)
        if (result.screenshot) scenarioScreenshots.push(result.screenshot)
        gates.push(gate(
          `scenario-${scenario.id}-${viewport}`,
          `${scenario.name}（${viewport}）`,
          result.passed,
          result.detail
        ))
      }
    }
    gates.push(
      gate('runtime-console', '运行时没有脚本错误', errors.length === 0, errors.slice(0, 3).join('；')),
      gate('runtime-network', '预览没有访问外部网络', externalRequests.size === 0, `检测到外部来源：${[...externalRequests].join('、')}`),
      gate('acceptance-scenarios', '所有必需能力都有可执行验收场景', scenarios.length > 0, '业务应用没有定义任何可执行验收场景')
    )
    return { gates, screenshot, smallScreenshot, scenarioScreenshots }
  } finally {
    await browser.close()
  }
}
