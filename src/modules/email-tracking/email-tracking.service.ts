import { randomUUID } from 'node:crypto'

import {
  getTrackingPixelResponse,
  getTrackingRedirectResponse,
  parseAndVerifyTrackingRequest,
  type TrackingPayload
} from 'src/modules/email-tracking/email-tracking.helper'
import { isSnsMessageSignatureValid } from 'src/modules/email-tracking/sns.helper'
import { pool } from 'src/utils/database'
import { logger } from 'src/utils/logger'

export type EmailTrackingEventType =
  | 'open'
  | 'click'
  | 'attachment_viewed'
  | 'delivered'
  | 'bounce_permanent'
  | 'bounce_transient'
  | 'bounce_undetermined'
  | 'complaint'
  | 'reject'
  | 'delivery_delayed'

interface RecordEmailTrackingEventParams {
  emailId: string
  recipientEmail: string | null
  eventType: EmailTrackingEventType
  targetUrl: string | null
  linkName: string | null
  trackingScope: string | null
  userAgent: string | null
  ipAddress: string | null
  provider?: string | null
  source?: string
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
     SELECT $1, $2, NULL, org_id, $3, $4, $5, $6, NULL, $7, $8, NULL, $9, $10, $11, $12, NOW()
     FROM email WHERE id = $2
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      params.emailId,
      params.provider || null,
      params.eventType,
      params.recipientEmail,
      params.targetUrl,
      params.linkName,
      params.trackingScope,
      params.userAgent,
      params.ipAddress,
      params.source || 'tracking',
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

  const seedBase = {
    openCount: 0,
    clickCount: 0,
    attachmentViewCount: 0,
    firstOpenAt: null,
    lastOpenAt: null,
    firstClickAt: null,
    clickedAt: null,
    sentAt: null,
    deliveredAt: null,
    bouncedAt: null,
    complainedAt: null,
    rejectedAt: null
  }

  const initial = {
    sent: { ...seedBase, status: 'sent', sentAt: timestamp },
    open: { ...seedBase, status: 'opened', openCount: 1, firstOpenAt: timestamp, lastOpenAt: timestamp },
    click: { ...seedBase, status: 'clicked', clickCount: 1, firstClickAt: timestamp, clickedAt: timestamp },
    attachment_viewed: { ...seedBase, status: 'sent', attachmentViewCount: 1 },
    delivered: { ...seedBase, status: 'delivered', deliveredAt: timestamp },
    bounce_permanent: { ...seedBase, status: 'bounced', bouncedAt: timestamp },
    bounce_transient: { ...seedBase, status: 'bounced', bouncedAt: timestamp },
    bounce_undetermined: { ...seedBase, status: 'bounced', bouncedAt: timestamp },
    complaint: { ...seedBase, status: 'complained', complainedAt: timestamp },
    reject: { ...seedBase, status: 'rejected', rejectedAt: timestamp },
    delivery_delayed: { ...seedBase, status: 'sent' }
  }

  const seed = initial[eventType]

  await pool.query(
    `INSERT INTO email_analytic (
       id, email_id, email_recipient_id, org_id, status,
       open_count, click_count, attachment_view_count,
       first_open_at, last_open_at, first_click_at, clicked_at,
       sent_at, delivered_at, bounced_at, complained_at, rejected_at,
       created_at, updated_at
     )
     SELECT $1, $2, NULL, org_id, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW()
     FROM email WHERE id = $2
     ON CONFLICT (email_id) DO UPDATE SET
       status = CASE
         WHEN $3 IN ('bounce_permanent', 'bounce_transient', 'bounce_undetermined') AND email_analytic.status IN ('pending', 'sent', 'delivered', 'opened') THEN 'bounced'
         WHEN $3 = 'complaint' AND email_analytic.status IN ('pending', 'sent', 'delivered', 'opened') THEN 'complained'
         WHEN $3 = 'reject' AND email_analytic.status IN ('pending', 'sent', 'delivered', 'opened') THEN 'rejected'
         WHEN $3 = 'click' AND email_analytic.status IN ('pending', 'sent', 'delivered', 'opened') THEN 'clicked'
         WHEN $3 = 'open' AND email_analytic.status IN ('pending', 'sent', 'delivered') THEN 'opened'
         WHEN $3 = 'delivered' AND email_analytic.status IN ('pending', 'sent') THEN 'delivered'
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
       delivered_at = CASE WHEN $3 = 'delivered' THEN COALESCE(email_analytic.delivered_at, $4::timestamptz) ELSE email_analytic.delivered_at END,
       bounced_at = CASE WHEN $3 IN ('bounce_permanent', 'bounce_transient', 'bounce_undetermined') THEN COALESCE(email_analytic.bounced_at, $4::timestamptz) ELSE email_analytic.bounced_at END,
       complained_at = CASE WHEN $3 = 'complaint' THEN COALESCE(email_analytic.complained_at, $4::timestamptz) ELSE email_analytic.complained_at END,
       rejected_at = CASE WHEN $3 = 'reject' THEN COALESCE(email_analytic.rejected_at, $4::timestamptz) ELSE email_analytic.rejected_at END,
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
      seed.sentAt,
      seed.deliveredAt,
      seed.bouncedAt,
      seed.complainedAt,
      seed.rejectedAt
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

interface SesNotification {
  notificationType?: string
  mail?: {
    messageId?: string
    timestamp?: string
    destination?: string[]
  }
  delivery?: { recipients?: string[]; timestamp?: string }
  bounce?: {
    bounceType?: string
    bouncedRecipients?: Array<{ emailAddress?: string }>
    timestamp?: string
  }
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>
    timestamp?: string
    userAgent?: string
  }
  deliveryDelay?: {
    delayedRecipients?: Array<{ emailAddress?: string }>
    timestamp?: string
  }
}

const getSesBounceEventType = (bounceType?: string): EmailTrackingEventType => {
  switch (bounceType) {
    case 'Permanent':
      return 'bounce_permanent'
    case 'Transient':
      return 'bounce_transient'
    default:
      return 'bounce_undetermined'
  }
}

// Maps an SES notification to a tracked event + analytic update. Correlates on the
// stored email.message_id (SES SendEmail MessageId). Per-recipient fan-out means the
// stored message_id is the last recipient's send; other recipients' notifications are
// logged and skipped until per-recipient identity lands.
const processSesNotification = async (notification: SesNotification): Promise<void> => {
  const notificationType = notification?.notificationType
  const mail = notification?.mail || {}
  const { messageId } = mail
  if (!notificationType || !messageId) {
    logger.warn('[email-tracking] SES notification without notificationType/messageId')
    return
  }

  const emailResult = await pool.query('SELECT id FROM email WHERE message_id = $1', [messageId])
  const emailId = emailResult.rows[0]?.id as string | undefined
  if (!emailId) {
    logger.warn(`[email-tracking] SES notification for unknown messageId ${messageId}`)
    return
  }

  let eventType: EmailTrackingEventType | null = null
  let recipientEmail: string | null = null
  let userAgent: string | null = null
  let occurredAt: string | null = null

  switch (notificationType) {
    case 'Delivery':
      eventType = 'delivered'
      recipientEmail = notification.delivery?.recipients?.[0] || mail.destination?.[0] || null
      occurredAt = notification.delivery?.timestamp || mail.timestamp || null
      break
    case 'Bounce':
      eventType = getSesBounceEventType(notification.bounce?.bounceType)
      recipientEmail = notification.bounce?.bouncedRecipients?.[0]?.emailAddress || mail.destination?.[0] || null
      occurredAt = notification.bounce?.timestamp || mail.timestamp || null
      break
    case 'Complaint':
      eventType = 'complaint'
      recipientEmail = notification.complaint?.complainedRecipients?.[0]?.emailAddress || mail.destination?.[0] || null
      userAgent = notification.complaint?.userAgent || null
      occurredAt = notification.complaint?.timestamp || mail.timestamp || null
      break
    case 'DeliveryDelay':
      eventType = 'delivery_delayed'
      recipientEmail = notification.deliveryDelay?.delayedRecipients?.[0]?.emailAddress || mail.destination?.[0] || null
      occurredAt = notification.deliveryDelay?.timestamp || mail.timestamp || null
      break
    case 'Reject':
      eventType = 'reject'
      recipientEmail = mail.destination?.[0] || null
      occurredAt = mail.timestamp || null
      break
    default:
      logger.warn(`[email-tracking] unsupported SES notificationType ${notificationType}`)
      return
  }

  const eventId = await recordEmailTrackingEvent({
    emailId,
    recipientEmail,
    eventType,
    targetUrl: null,
    linkName: null,
    trackingScope: null,
    userAgent,
    ipAddress: null,
    provider: 'ses',
    source: 'transport_webhook'
  })

  if (eventId) {
    await upsertEmailAnalytic({ emailId, eventType, occurredAt: occurredAt ? new Date(occurredAt) : undefined })
  }
}

// POST /email-tracking/webhook — SNS subscription confirmation + SES notification
// ingestion. Fails open per notification (event/logged), so a bad notification never
// breaks the endpoint; envelope-level errors (invalid JSON/signature) still surface.
export const ingestTransportWebhook = async ({ headers = {}, body = '' } = {}) => {
  let snsMessage: Record<string, unknown>
  try {
    snsMessage = JSON.parse(body || '{}') as Record<string, unknown>
  } catch {
    throw new Error('Invalid webhook payload: expected JSON')
  }

  const messageType = snsMessage?.Type
  if (!messageType) {
    throw new Error('Invalid SNS message: missing Type')
  }

  if (messageType === 'SubscriptionConfirmation') {
    const valid = await isSnsMessageSignatureValid(snsMessage)
    if (!valid) throw new Error('Invalid SNS subscription confirmation signature')

    if (snsMessage?.SubscribeURL) {
      fetch(String(snsMessage.SubscribeURL)).catch((error) =>
        logger.warn('[email-tracking] failed to confirm SNS subscription', (error as Error)?.message)
      )
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) }
  }

  if (messageType !== 'Notification') {
    throw new Error(`Unsupported SNS message type: ${messageType}`)
  }

  const valid = await isSnsMessageSignatureValid(snsMessage)
  if (!valid) throw new Error('Invalid SNS notification signature')

  let notification: SesNotification
  try {
    notification = JSON.parse(String(snsMessage?.Message || '')) as SesNotification
  } catch {
    throw new Error('Invalid SNS notification: Message is not valid JSON')
  }

  try {
    await processSesNotification(notification)
  } catch (error) {
    logger.error('[email-tracking] error ingesting SES notification', (error as Error)?.message)
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) }
}
