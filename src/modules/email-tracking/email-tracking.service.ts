import { randomUUID } from 'node:crypto'

import { pool } from 'src/utils/database'
import { logger } from 'src/utils/logger'
import {
  getTrackingPixelResponse,
  getTrackingRedirectResponse,
  parseAndVerifyTrackingRequest,
  type TrackingPayload
} from 'src/modules/email-tracking/email-tracking.helper'

export type EmailTrackingEventType = 'open' | 'click' | 'attachment_viewed'

interface RecordEmailTrackingEventParams {
  emailId: string
  recipientEmail: string | null
  eventType: EmailTrackingEventType
  targetUrl: string | null
  linkName: string | null
  trackingScope: string | null
  userAgent: string | null
  ipAddress: string | null
}

const buildDedupeKey = ({ emailId, recipientEmail, eventType, targetUrl }: RecordEmailTrackingEventParams): string =>
  [emailId, recipientEmail || '', eventType, targetUrl || ''].join('|')

const getRecipientEmail = (payload: TrackingPayload): string | null => {
  if (payload?.recipient_email) return payload.recipient_email
  if (Array.isArray(payload?.recipients) && payload.recipients.length) return payload.recipients[0] || null
  return null
}

const getRequestIpAddress = (headers: Record<string, string | undefined>): string | null => {
  const forwardedFor = headers?.['x-forwarded-for'] || headers?.['X-Forwarded-For']
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim() || null

  return headers?.['x-real-ip'] || headers?.['X-Real-IP'] || null
}

// Append-only event log (source of truth). Returns the new row id when the event was
// accepted (dedupe_key unique) or null when it was a duplicate delivery.
export const recordEmailTrackingEvent = async (params: RecordEmailTrackingEventParams): Promise<string | null> => {
  const dedupeKey = buildDedupeKey(params)
  const result = await pool.query(
    `INSERT INTO email_tracking_events (
       id, email_id, email_recipient_id, org_id, provider, event_type,
       recipient_email, target_url, link_id, link_name, tracking_scope,
       metadata, user_agent, ip_address, source, dedupe_key, occurred_at
     )
     SELECT $1, $2, NULL, org_id, NULL, $3, $4, $5, NULL, $6, $7, NULL, $8, $9, 'tracking', $10, NOW()
     FROM email WHERE id = $2
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      params.emailId,
      params.eventType,
      params.recipientEmail,
      params.targetUrl,
      params.linkName,
      params.trackingScope,
      params.userAgent,
      params.ipAddress,
      dedupeKey
    ]
  )

  return result.rows.length ? (result.rows[0].id as string) : null
}

// Materialized per-email projection. Keyed on email_id (email_recipient_id stays NULL
// until per-recipient identity lands); idempotent upsert on every accepted event. The
// INSERT branch seeds the event-specific state so a first-ever event lands correctly.
export const upsertEmailAnalytic = async ({
  emailId,
  eventType,
  occurredAt
}: {
  emailId: string
  eventType: EmailTrackingEventType | 'sent'
  occurredAt?: Date
}): Promise<void> => {
  const timestamp = occurredAt?.toISOString() || new Date().toISOString()

  const initial = {
    sent: {
      status: 'sent',
      openCount: 0,
      clickCount: 0,
      attachmentViewCount: 0,
      firstOpenAt: null,
      lastOpenAt: null,
      firstClickAt: null,
      clickedAt: null,
      sentAt: timestamp
    },
    open: {
      status: 'opened',
      openCount: 1,
      clickCount: 0,
      attachmentViewCount: 0,
      firstOpenAt: timestamp,
      lastOpenAt: timestamp,
      firstClickAt: null,
      clickedAt: null,
      sentAt: null
    },
    click: {
      status: 'clicked',
      openCount: 0,
      clickCount: 1,
      attachmentViewCount: 0,
      firstOpenAt: null,
      lastOpenAt: null,
      firstClickAt: timestamp,
      clickedAt: timestamp,
      sentAt: null
    },
    attachment_viewed: {
      status: 'sent',
      openCount: 0,
      clickCount: 0,
      attachmentViewCount: 1,
      firstOpenAt: null,
      lastOpenAt: null,
      firstClickAt: null,
      clickedAt: null,
      sentAt: null
    }
  } as const

  const seed = initial[eventType]

  await pool.query(
    `INSERT INTO email_analytic (
       id, email_id, email_recipient_id, org_id, status,
       open_count, click_count, attachment_view_count,
       first_open_at, last_open_at, first_click_at, clicked_at,
       sent_at, created_at, updated_at
     )
     SELECT $1, $2, NULL, org_id, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
     FROM email WHERE id = $2
     ON CONFLICT (email_id) DO UPDATE SET
       status = CASE
         WHEN $3 = 'click' AND email_analytic.status IN ('pending', 'sent', 'delivered', 'opened') THEN 'clicked'
         WHEN $3 = 'open' AND email_analytic.status IN ('pending', 'sent', 'delivered') THEN 'opened'
         WHEN $3 = 'sent' THEN 'sent'
         ELSE email_analytic.status
       END,
       open_count = email_analytic.open_count + CASE WHEN $3 = 'open' THEN 1 ELSE 0 END,
       click_count = email_analytic.click_count + CASE WHEN $3 = 'click' THEN 1 ELSE 0 END,
       attachment_view_count = email_analytic.attachment_view_count + CASE WHEN $3 = 'attachment_viewed' THEN 1 ELSE 0 END,
       first_open_at = CASE WHEN $3 = 'open' THEN COALESCE(email_analytic.first_open_at, $4::timestamptz) ELSE email_analytic.first_open_at END,
       last_open_at = CASE WHEN $3 = 'open' THEN $4::timestamptz ELSE email_analytic.last_open_at END,
       first_click_at = CASE WHEN $3 = 'click' THEN COALESCE(email_analytic.first_click_at, $4::timestamptz) ELSE email_analytic.first_click_at END,
       clicked_at = CASE WHEN $3 = 'click' THEN $4::timestamptz ELSE email_analytic.clicked_at END,
       sent_at = CASE WHEN $3 = 'sent' THEN COALESCE(email_analytic.sent_at, $4::timestamptz) ELSE email_analytic.sent_at END,
       updated_at = NOW()`,
    [
      randomUUID(),
      emailId,
      eventType,
      timestamp,
      seed.status,
      seed.openCount,
      seed.clickCount,
      seed.attachmentViewCount,
      seed.firstOpenAt,
      seed.lastOpenAt,
      seed.firstClickAt,
      seed.clickedAt,
      seed.sentAt
    ]
  )
}

export const persistTrackedLinks = async ({
  emailId,
  orgId,
  trackedLinks
}: {
  emailId: string
  orgId: string | null
  trackedLinks: Array<{ targetUrl: string; kind: 'click' | 'attachment'; label?: string | null }>
}): Promise<void> => {
  if (!trackedLinks.length) return

  const values = trackedLinks.map((link, index) => {
    const offset = index * 6
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, NOW(), NOW())`
  })

  const params: unknown[] = []
  trackedLinks.forEach((link) => {
    params.push(randomUUID(), emailId, orgId, link.targetUrl, link.label ?? null, link.kind)
  })

  await pool.query(
    `INSERT INTO tracked_link (id, email_id, org_id, target_url, label, kind, created_at, updated_at)
     VALUES ${values.join(',')}
     ON CONFLICT (email_id, target_url) DO NOTHING`,
    params
  )
}

const trackEmailEvent = async ({
  eventType,
  headers = {},
  queryParams = {}
}: {
  eventType: EmailTrackingEventType
  headers?: Record<string, string | undefined>
  queryParams?: Record<string, string | undefined>
}) => {
  const payload = parseAndVerifyTrackingRequest({
    token: (queryParams as Record<string, string | undefined>)?.token,
    signature: (queryParams as Record<string, string | undefined>)?.signature
  })

  if (!payload) {
    throw new Error('Invalid email tracking token')
  }

  const eventId = await recordEmailTrackingEvent({
    emailId: payload.email_id as string,
    recipientEmail: getRecipientEmail(payload),
    eventType,
    targetUrl: payload?.target_url || null,
    linkName: payload?.link_name || null,
    trackingScope: payload?.tracking_scope || null,
    userAgent: (headers as Record<string, string | undefined>)?.['user-agent'] || null,
    ipAddress: getRequestIpAddress(headers as Record<string, string | undefined>)
  })

  if (eventId) {
    await upsertEmailAnalytic({ emailId: payload.email_id as string, eventType })
  }

  return payload
}

export const trackEmailOpen = async ({ headers = {}, queryParams = {} } = {}) => {
  try {
    await trackEmailEvent({ eventType: 'open', headers, queryParams })
  } catch (error) {
    logger.error('[email-tracking] error tracking email open', (error as Error)?.message)
  }

  return getTrackingPixelResponse()
}

export const trackEmailClick = async ({ headers = {}, queryParams = {} } = {}) => {
  const payload = await trackEmailEvent({ eventType: 'click', headers, queryParams })

  if (!payload?.target_url) {
    throw new Error('Missing target URL for email click tracking')
  }

  return getTrackingRedirectResponse(payload.target_url)
}

export const trackEmailAttachmentView = async ({ headers = {}, queryParams = {} } = {}) => {
  try {
    await trackEmailEvent({ eventType: 'attachment_viewed', headers, queryParams })
  } catch (error) {
    logger.error('[email-tracking] error tracking email attachment view', (error as Error)?.message)
  }

  return getTrackingPixelResponse()
}