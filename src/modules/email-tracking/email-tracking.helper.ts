import { createHmac, timingSafeEqual } from 'node:crypto'

import * as cheerio from 'cheerio'

import { env } from 'src/utils/env'

const TRACKING_PIXEL_BASE64 = 'R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='

const UNSUPPORTED_HREF_PREFIXES = ['#', 'about:', 'blob:', 'cid:', 'data:', 'javascript'.concat(':'), 'mailto:', 'tel:']

export interface TrackingPayload {
  email_id?: string
  recipient_email?: string
  recipients?: string[]
  target_url?: string
  link_name?: string
  tracking_scope?: string
}

export interface TrackableRecipients {
  to?: string[]
  cc?: string[]
  bcc?: string[]
}

const toBase64Url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

const fromBase64Url = (value: string): string => {
  const normalizedValue = value.replace(/-/g, '+').replace(/_/g, '/')
  const paddingLength = (4 - (normalizedValue.length % 4 || 4)) % 4

  return Buffer.from(`${normalizedValue}${'='.repeat(paddingLength)}`, 'base64').toString('utf8')
}

const getTrackingSecret = (): string => env('EMAIL_TRACKING_SECRET') || env('APPLICATION_TOKEN')

export const getEmailTrackingBaseUrl = (): string => env('EMAIL_TRACKING_BASE_URL').replace(/\/+$/, '')

const normalizeRecipients = (recipients: string[] = []): string[] =>
  recipients.map((recipient) => recipient?.toLowerCase?.()?.trim?.()).filter(Boolean)

const getTrackableRecipientEmails = (payload: TrackableRecipients = {}): string[] =>
  Array.from(
    new Set([
      ...normalizeRecipients(payload.to),
      ...normalizeRecipients(payload.cc),
      ...normalizeRecipients(payload.bcc)
    ])
  )

const getTrackingPayloadBase = (payload: TrackableRecipients & { id?: string }): TrackingPayload | null => {
  const recipients = getTrackableRecipientEmails(payload)
  if (!payload?.id || !recipients.length) return null

  if (recipients.length === 1) {
    return { email_id: payload.id, recipient_email: recipients[0], tracking_scope: 'recipient' }
  }

  return { email_id: payload.id, recipients, tracking_scope: 'email' }
}

export const createTrackingToken = (payload: TrackingPayload): string => toBase64Url(JSON.stringify(payload))

export const createTrackingSignature = (token: string): string => {
  const trackingSecret = getTrackingSecret()
  if (!token || !trackingSecret) return ''

  return createHmac('sha256', trackingSecret).update(token).digest('hex')
}

export const decodeTrackingToken = (token: string): TrackingPayload | null => {
  if (!token) return null

  try {
    return JSON.parse(fromBase64Url(token)) as TrackingPayload
  } catch {
    return null
  }
}

export const verifyTrackingSignature = ({ token = '', signature = '' } = {}): boolean => {
  const expectedSignature = createTrackingSignature(token)
  if (!expectedSignature || !signature || expectedSignature.length !== signature.length) return false

  return timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature))
}

const isSupportedTrackingHref = (href = ''): boolean => {
  if (!href) return false

  const normalizedHref = href.trim().toLowerCase()
  return !UNSUPPORTED_HREF_PREFIXES.some((prefix) => normalizedHref.startsWith(prefix))
}

const buildTrackingUrl = ({ endpoint = '', payload = {} } = {}): string => {
  const trackingBaseUrl = getEmailTrackingBaseUrl()
  if (!trackingBaseUrl || !endpoint) return ''

  const token = createTrackingToken(payload)
  const signature = createTrackingSignature(token)
  if (!token || !signature) return ''

  return `${trackingBaseUrl}${endpoint}?token=${encodeURIComponent(token)}&signature=${signature}`
}

export interface TrackedEmailBody {
  bodyHtml: string
  trackedLinks: Array<{ targetUrl: string; kind: 'click' | 'attachment'; label?: string | null }>
}

// Rewrites <a href> links to /email-tracking/click and appends the open pixel so
// opens/clicks are recorded by the tracking endpoints. No-ops when tracking is
// not configured (missing base URL or secret).
export const prepareTrackedEmailBody = ({
  bodyHtml = '',
  payload = {}
}: {
  bodyHtml?: string
  payload?: TrackableRecipients & { id?: string }
}): TrackedEmailBody => {
  const trackingPayloadBase = getTrackingPayloadBase(payload)
  if (!bodyHtml || !trackingPayloadBase?.email_id) {
    return { bodyHtml, trackedLinks: [] }
  }

  const trackingBaseUrl = getEmailTrackingBaseUrl()
  const trackingSecret = getTrackingSecret()
  if (!trackingBaseUrl || !trackingSecret) {
    return { bodyHtml, trackedLinks: [] }
  }

  const $ = cheerio.load(bodyHtml)
  const trackedLinks: TrackedEmailBody['trackedLinks'] = []

  $('a[href]').each((index, element) => {
    const $link = $(element)
    const href = $link.attr('href') || ''
    if (!isSupportedTrackingHref(href)) return

    const linkName = $link.attr('data-gain-link-name') || null

    const trackedUrl = buildTrackingUrl({
      endpoint: '/email-tracking/click',
      payload: { ...trackingPayloadBase, target_url: href, ...(linkName ? { link_name: linkName } : {}) }
    })

    if (trackedUrl) {
      $link.attr('href', trackedUrl)
      trackedLinks.push({ targetUrl: href, kind: 'click', label: linkName })
    }
  })

  $('img[src^="cid:"]').each((index, element) => {
    const $img = $(element)
    const src = $img.attr('src') || ''
    const attachmentName = $img.attr('data-gain-attachment-name') || null

    const trackedUrl = buildTrackingUrl({
      endpoint: '/email-tracking/attachment-view',
      payload: { ...trackingPayloadBase, target_url: src, ...(attachmentName ? { link_name: attachmentName } : {}) }
    })

    if (trackedUrl) {
      $img.attr('src', trackedUrl)
      trackedLinks.push({ targetUrl: src, kind: 'attachment', label: attachmentName })
    }
  })

  const openTrackingUrl = buildTrackingUrl({
    endpoint: '/email-tracking/open',
    payload: trackingPayloadBase
  })

  if (openTrackingUrl) {
    const trackingPixelHtml = `<img src="${openTrackingUrl}" alt="" width="1" height="1" style="display:block;border:0;height:1px;opacity:0;overflow:hidden;visibility:hidden;width:1px" />`

    if ($('body').length) {
      $('body').append(trackingPixelHtml)
    } else {
      $.root().append(trackingPixelHtml)
    }
  }

  return { bodyHtml: $.html(), trackedLinks }
}

export const parseAndVerifyTrackingRequest = ({ token = '', signature = '' } = {}): TrackingPayload | null => {
  if (!verifyTrackingSignature({ token, signature })) return null

  const payload = decodeTrackingToken(token)
  if (!payload?.email_id) return null
  if (!payload?.recipient_email && !(Array.isArray(payload?.recipients) && payload.recipients.length)) return null

  return payload
}

export const getTrackingPixelResponse = () => ({
  body: TRACKING_PIXEL_BASE64,
  headers: {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Expires: '0',
    Pragma: 'no-cache'
  },
  isBase64Encoded: true,
  statusCode: 200
})

export const getTrackingRedirectResponse = (location = '') => ({
  body: '',
  headers: {
    Location: location,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Expires: '0',
    Pragma: 'no-cache'
  },
  statusCode: 302
})
