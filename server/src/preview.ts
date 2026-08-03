import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dirs } from './store'
import { inlineDataIntoHtml } from './loop-adapter/shared-utils'

export const PREVIEW_HOST = process.env.PREVIEW_HOST?.trim() || '127.0.0.1'
export const PREVIEW_PORT = Number(process.env.PREVIEW_PORT ?? 8788)
export const PREVIEW_ORIGIN =
  process.env.PREVIEW_ORIGIN?.trim().replace(/\/+$/, '') || `http://${PREVIEW_HOST}:${PREVIEW_PORT}`

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', PREVIEW_CSP)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
}

export function artifactPreviewUrl(projectId: string, revisionId: string, cacheKey?: string | number): string {
  const url = new URL(
    `/preview/${encodeURIComponent(projectId)}/${encodeURIComponent(revisionId)}/index.html`,
    PREVIEW_ORIGIN
  )
  if (cacheKey !== undefined) url.searchParams.set('t', String(cacheKey))
  return url.toString()
}

export function normalizePreviewUrl(url: string | null): string | null {
  if (!url) return null
  return url.startsWith('/preview/') ? `${PREVIEW_ORIGIN}${url}` : url
}

export function isTrustedPreviewUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const trusted = new URL(PREVIEW_ORIGIN)
    return (
      url.origin === trusted.origin &&
      url.pathname.startsWith('/preview/') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export function createPreviewApp(): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(securityHeaders)
  app.get('/preview/:projectId/:revisionId/index.html', async (req, res, next) => {
    const { projectId, revisionId } = req.params
    if (
      typeof projectId !== 'string' ||
      typeof revisionId !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(projectId) ||
      !/^[A-Za-z0-9_-]+$/.test(revisionId)
    ) {
      res.sendStatus(404)
      return
    }

    const revisionDir = path.join(dirs.previews, projectId, revisionId)
    try {
      const html = await fs.readFile(path.join(revisionDir, 'index.html'), 'utf8')
      const dataJson = await fs.readFile(path.join(revisionDir, 'data.json'), 'utf8').catch(() => null)
      res.setHeader('Cache-Control', 'no-store')
      res.type('html').send(inlineDataIntoHtml(html, dataJson))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        next()
        return
      }
      next(error)
    }
  })
  app.use('/preview', express.static(dirs.previews, {
    dotfiles: 'deny',
    fallthrough: false,
    index: 'index.html',
    redirect: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store')
    }
  }))
  app.get('/healthz', (_req, res) => res.json({ ok: true }))
  return app
}
