import fs from 'node:fs'
import { chromium, type Page } from 'playwright'
import type { ValidationGateResult } from '../../wire'

export interface IduxRuntimeValidation {
  gates: ValidationGateResult[]
  screenshot: Buffer | null
  smallScreenshot: Buffer | null
}

interface IduxStyleAudit {
  themeToken: string
  buttonToken: string
  tableToken: string
  cardToken: string
  resetToken: string
  cardBackground: string
  selectedTheme: 'light' | 'dark' | 'unknown'
  bodyBackground: string
  headingContrast: number
  bodyFontSize: number
  headingFontSize: number
  primaryHeight: number
  inputHeight: number
  tableHeaderHeight: number
  cardCount: number
  nativeInteractiveCount: number
  contentWidth: number
  contentLeft: number
  expectedSummaryCount: number
}

interface IduxSmallAudit {
  headingFontSize: number
  minControlHeight: number
  summaryColumns: number
  primaryActionVisible: boolean
  tableHeaderVisible: boolean
  visibleRowCount: number
  expectedSummaryCount: number
}

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

function gate(
  id: string,
  title: string,
  passed: boolean,
  detail: string | null = null
): ValidationGateResult {
  return { id, title, status: passed ? 'passed' : 'failed', detail: passed ? null : detail }
}

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
    if (/Failed to load resource/i.test(message.text()) && /\/favicon\.ico(?:$|\?)/i.test(location)) {
      return
    }
    errors.push(location ? `${message.text()}（${location}）` : message.text())
  })
  page.on('request', request => {
    const requested = new URL(request.url())
    if (requested.origin !== expectedOrigin) externalRequests.add(requested.origin)
  })
}

export async function validateBuiltIduxPage(url: string): Promise<IduxRuntimeValidation> {
  const executablePath = browserExecutable()
  if (!executablePath) {
    throw new Error('浏览器验收环境不可用：请安装 Chromium、Chrome 或 Edge')
  }
  const browser = await chromium.launch({ headless: true, executablePath })
  const errors: string[] = []
  const externalRequests = new Set<string>()
  let screenshot: Buffer | null = null
  let smallScreenshot: Buffer | null = null
  try {
    const expectedOrigin = new URL(url).origin
    const large = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    collectRuntimeSignals(large, expectedOrigin, errors, externalRequests)
    const response = await large.goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
    await large.evaluate('document.fonts ? document.fonts.ready : Promise.resolve()')
    const h1 = (await large.locator('h1').first().textContent())?.trim() ?? ''
    const tableVisible = await large.locator('.ix-table').first().isVisible().catch(() => false)
    const styleAudit = await large.evaluate(`(() => {
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
          return normalized <= 0.03928
            ? normalized / 12.92
            : Math.pow((normalized + 0.055) / 1.055, 2.4)
        })
        return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2]
      }
      const contrast = (foreground, background) => {
        const a = luminance(foreground)
        const b = luminance(background)
        if (a === null || b === null) return 0
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      }
      const primary = document.querySelector('.ix-button-primary')
      const input = document.querySelector('.ix-input')
      const table = document.querySelector('.ix-table')
      const card = document.querySelector('.ix-card')
      const heading = document.querySelector('h1')
      const content = document.querySelector('.page-content')
      const tableHeader = document.querySelector('.ix-table-thead tr')
      const primaryStyle = primary ? getComputedStyle(primary) : null
      const tableStyle = table ? getComputedStyle(table) : null
      const cardStyle = card ? getComputedStyle(card) : null
      const rootStyle = getComputedStyle(document.documentElement)
      const bodyStyle = getComputedStyle(document.body)
      const headingStyle = heading ? getComputedStyle(heading) : null
      const contentRect = content?.getBoundingClientRect()
      const shell = document.querySelector('.page-shell')
      return {
        themeToken: rootStyle.getPropertyValue('--ix-color-bg').trim() || '',
        resetToken: rootStyle.getPropertyValue('--ix-reset-color-bg').trim() || '',
        buttonToken: primaryStyle?.getPropertyValue('--ix-button-height-md').trim() || '',
        tableToken: tableStyle?.getPropertyValue('--ix-table-head-bg-color').trim() || '',
        cardToken: cardStyle?.getPropertyValue('--ix-card-padding-size-md').trim() || '',
        cardBackground: cardStyle?.backgroundColor || '',
        selectedTheme: shell?.classList.contains('theme-dark')
          ? 'dark'
          : shell?.classList.contains('theme-light')
            ? 'light'
            : 'unknown',
        bodyBackground: bodyStyle.backgroundColor,
        headingContrast: headingStyle ? contrast(headingStyle.color, bodyStyle.backgroundColor) : 0,
        bodyFontSize: number(bodyStyle.fontSize),
        headingFontSize: headingStyle ? number(headingStyle.fontSize) : 0,
        primaryHeight: primary?.getBoundingClientRect().height || 0,
        inputHeight: input?.getBoundingClientRect().height || 0,
        tableHeaderHeight: tableHeader?.getBoundingClientRect().height || 0,
        cardCount: document.querySelectorAll('.ix-card').length,
        nativeInteractiveCount: document.querySelectorAll(
          'button:not(.ix-button), select, textarea, input:not(.ix-input-inner)'
        ).length,
        contentWidth: contentRect?.width || 0,
        contentLeft: contentRect?.left || 0,
        expectedSummaryCount: Number(shell?.getAttribute('data-summary-count') || '0')
      }
    })()`) as IduxStyleAudit
    const largeOverflow = await large.evaluate(
      'document.documentElement.scrollWidth > window.innerWidth + 1'
    ) as boolean
    screenshot = await large.screenshot({ type: 'png', fullPage: false })

    const feedback = large.locator('[role="status"]')
    const feedbackBefore = (await feedback.first().textContent())?.trim() ?? ''
    const primaryButton = large.locator('.ix-button-primary')
    await primaryButton.first().click()
    const feedbackAfter = (await feedback.first().textContent())?.trim() ?? ''
    const primaryActionWorks = feedbackAfter.length > 0 && feedbackAfter !== feedbackBefore

    const tableRows = large.locator('tbody tr')
    const rowsBeforeSearch = await tableRows.count()
    const firstCellText = (await tableRows.first().locator('td').first().textContent())?.trim() ?? ''
    const searchInput = large.locator('input[aria-label*="搜索"]').first()
    await searchInput.fill(firstCellText)
    await large.waitForTimeout(50)
    const rowsAfterSearch = await tableRows.count()
    const searchWorks =
      firstCellText.length > 0 &&
      rowsBeforeSearch > 1 &&
      rowsAfterSearch > 0 &&
      rowsAfterSearch < rowsBeforeSearch
    await large.close()

    const small = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    collectRuntimeSignals(small, expectedOrigin, errors, externalRequests)
    await small.goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
    await small.evaluate('document.fonts ? document.fonts.ready : Promise.resolve()')
    const smallOverflow = await small.evaluate(
      'document.documentElement.scrollWidth > window.innerWidth + 1'
    ) as boolean
    const smallAudit = await small.evaluate(`(() => {
      const number = value => Number.parseFloat(value || '0') || 0
      const visible = element => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 &&
          style.visibility !== 'hidden' && style.display !== 'none'
      }
      const heading = document.querySelector('h1')
      const controls = [...document.querySelectorAll(
        '.page-heading .ix-button, .toolbar-actions .ix-button, .toolbar-actions .ix-input'
      )]
      const heights = controls.map(item => item.getBoundingClientRect().height).filter(Boolean)
      const grid = document.querySelector('.summary-grid')
      const shell = document.querySelector('.page-shell')
      const columns = grid
        ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
        : 0
      const rows = [...document.querySelectorAll('tbody tr')]
      return {
        headingFontSize: heading ? number(getComputedStyle(heading).fontSize) : 0,
        minControlHeight: heights.length > 0 ? Math.min(...heights) : 0,
        summaryColumns: columns,
        primaryActionVisible: visible(document.querySelector('.ix-button-primary')),
        tableHeaderVisible: visible(document.querySelector('.ix-table-thead')),
        visibleRowCount: rows.filter(visible).length,
        expectedSummaryCount: Number(shell?.getAttribute('data-summary-count') || '0')
      }
    })()`) as IduxSmallAudit
    smallScreenshot = await small.screenshot({ type: 'png', fullPage: false })
    await small.close()

    const iduxStylesLoaded =
      styleAudit.themeToken.length > 0 &&
      styleAudit.buttonToken.length > 0 &&
      styleAudit.tableToken.length > 0 &&
      styleAudit.cardToken.length > 0
    const colorContrastPassed =
      styleAudit.bodyBackground !== 'rgba(0, 0, 0, 0)' &&
      styleAudit.bodyBackground !== 'transparent' &&
      styleAudit.headingContrast >= 4.5
    const themeConsistent = styleAudit.selectedTheme === 'dark'
      ? styleAudit.resetToken.toLowerCase() !== '#ffffff' &&
        styleAudit.cardBackground !== 'rgb(255, 255, 255)'
      : styleAudit.selectedTheme === 'light' &&
        styleAudit.cardBackground === 'rgb(255, 255, 255)'
    const visualBaselinePassed =
      styleAudit.bodyFontSize >= 12 &&
      styleAudit.headingFontSize >= 28 &&
      styleAudit.primaryHeight >= 28 &&
      styleAudit.inputHeight >= 28 &&
      styleAudit.tableHeaderHeight >= 36 &&
      styleAudit.cardCount >= styleAudit.expectedSummaryCount + 1
    const largeLayoutPassed =
      !largeOverflow &&
      styleAudit.contentWidth > 1200 &&
      styleAudit.contentWidth <= 1665 &&
      styleAudit.contentLeft >= 0
    const smallUsable =
      smallAudit.headingFontSize >= 24 &&
      smallAudit.minControlHeight >= 28 &&
      (
        smallAudit.expectedSummaryCount === 0 ||
        smallAudit.summaryColumns === smallAudit.expectedSummaryCount
      ) &&
      smallAudit.primaryActionVisible &&
      smallAudit.tableHeaderVisible &&
      smallAudit.visibleRowCount >= 1

    const gates = [
      gate(
        'runtime-http',
        '页面可以正常加载',
        Boolean(response?.ok()),
        `预览返回 HTTP ${response?.status() ?? '未知状态'}`
      ),
      gate(
        'runtime-content',
        '关键内容完整',
        h1.length > 0 && tableVisible,
        '缺少页面标题或 IDux 表格'
      ),
      gate(
        'runtime-idux-styles',
        'IDux 完整主题和组件结构样式真实生效',
        iduxStylesLoaded,
        '缺少 IDux 主题或组件变量；必须同时加载 index.full.css 与一个完整官方主题'
      ),
      gate(
        'visual-color-contrast',
        '页面背景与标题对比度清晰',
        colorContrastPassed,
        `背景 ${styleAudit.bodyBackground}，标题对比度 ${styleAudit.headingContrast.toFixed(2)}:1`
      ),
      gate(
        'runtime-theme-consistency',
        '参考图选择的 IDux 明暗主题完整生效',
        themeConsistent,
        `选择 ${styleAudit.selectedTheme}，重置背景 ${styleAudit.resetToken}，卡片背景 ${styleAudit.cardBackground}`
      ),
      gate(
        'idux-interactive-components',
        '页面没有退化成原生交互控件',
        styleAudit.nativeInteractiveCount === 0,
        `检测到 ${styleAudit.nativeInteractiveCount} 个未使用 IDux 封装的交互控件`
      ),
      gate(
        'visual-baseline',
        '字号、控件和内容层级清晰',
        visualBaselinePassed,
        `字号 ${styleAudit.bodyFontSize}/${styleAudit.headingFontSize}px，主按钮 ${styleAudit.primaryHeight}px，输入框 ${styleAudit.inputHeight}px，表头 ${styleAudit.tableHeaderHeight}px，卡片 ${styleAudit.cardCount} 个`
      ),
      gate(
        'runtime-console',
        '运行时没有脚本错误',
        errors.length === 0,
        errors.slice(0, 3).join('；')
      ),
      gate(
        'runtime-network',
        '没有访问外部网络',
        externalRequests.size === 0,
        `检测到外部来源：${[...externalRequests].join('、')}`
      ),
      gate(
        'large-screen-layout',
        '1920×1080 大屏页面布局完整',
        largeLayoutPassed,
        `页面级横向溢出：${largeOverflow ? '是' : '否'}；内容宽 ${styleAudit.contentWidth}px，左偏移 ${styleAudit.contentLeft}px`
      ),
      gate(
        'small-screen-layout',
        '1366×768 小屏页面没有页面级横向溢出',
        !smallOverflow,
        '1366×768 视口出现页面级横向滚动'
      ),
      gate(
        'small-screen-usability',
        '1366×768 首屏保留主操作、参考图中的概览和表格主体',
        smallUsable,
        `标题 ${smallAudit.headingFontSize}px，最小控件 ${smallAudit.minControlHeight}px，概览 ${smallAudit.summaryColumns}/${smallAudit.expectedSummaryCount} 列，首屏表格行 ${smallAudit.visibleRowCount}`
      ),
      gate(
        'table-search',
        '表格搜索可以使用',
        searchWorks,
        '输入关键词后表格没有正确过滤'
      ),
      gate(
        'primary-action',
        '页面主操作有明确反馈',
        primaryActionWorks,
        '点击主操作后页面没有可感知的状态反馈'
      )
    ]
    return { gates, screenshot, smallScreenshot }
  } finally {
    await browser.close()
  }
}
