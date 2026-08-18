import {
  claimQueueForProcessing,
  markQueueCompleted,
  markQueueFailed,
  promoteNextHoldQueue,
  requeueWithBackoff,
  type AppQueueRow
} from 'src/modules/app-queue/app-queue.helper'
import { prepareTrackedEmailBody } from 'src/modules/email-tracking/email-tracking.helper'
import { persistTrackedLinks, upsertEmailAnalytic } from 'src/modules/email-tracking/email-tracking.service'
import { getEmailWithRecipients, type EmailRecipientRow } from 'src/modules/email/email.helper'
import { pool } from 'src/utils/database'
import { env, envInt } from 'src/utils/env'
import { logger } from 'src/utils/logger'
import { sendEmail } from 'src/utils/simple-email-service'

const getDefaultFromEmail = (): string => env('DEFAULT_FROM_EMAIL', 'no-reply@openlytic.local')

const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const getMaxRetries = (): number => envInt('MAX_RETRIES', 5)

const groupRecipientsByType = (recipients: EmailRecipientRow[]) =>
  recipients.reduce<{ to: string[]; cc: string[]; bcc: string[] }>(
    (groups, recipient) => {
      const email = recipient.email?.toLowerCase()?.trim()
      if (!email) return groups
      if (recipient.type === 'cc') groups.cc.push(email)
      else if (recipient.type === 'bcc') groups.bcc.push(email)
      else if (recipient.type === 'to') groups.to.push(email)
      return groups
    },
    { to: [], cc: [], bcc: [] }
  )

export const processSendEmailQueue = async (queue: AppQueueRow) => {
  const queueId = queue.id
  const claimed = await claimQueueForProcessing(queueId)
  if (!claimed) {
    logger.debug(`[email-service] queue ${queueId} already processing elsewhere - skipping`)
    return null
  }

  const params = queue.params || {}
  const emailId = params.emailId as string | undefined
  const maxRetries = getMaxRetries()

  try {
    if (!emailId) {
      throw new Error(`Missing params.emailId on queue ${queueId}`)
    }

    const emailWithRecipients = await getEmailWithRecipients(emailId)
    if (!emailWithRecipients) {
      throw new Error(`Email ${emailId} not found for queue ${queueId}`)
    }

    const { email, recipients } = emailWithRecipients
    const { to, cc, bcc } = groupRecipientsByType(recipients)
    const allRecipients = [...to, ...cc, ...bcc]

    if (!allRecipients.length) {
      await markQueueCompleted(queueId)
      await promoteNextHoldQueue(email.org_id, queue.category)
      logger.warn(`[email-service] queue ${queueId} completed with no recipients (email ${emailId})`)
      return { status: 'completed' }
    }

    const trackingEnabled = params.trackingEnabled !== false
    const originalBodyHtml = email.body_html || ''
    const text = email.snippet || stripHtml(originalBodyHtml)
    let html = originalBodyHtml
    let trackedLinks: Array<{ targetUrl: string; kind: 'click' | 'attachment'; label?: string | null }> = []

    if (trackingEnabled && html) {
      const trackedBody = prepareTrackedEmailBody({
        bodyHtml: html,
        payload: { id: emailId, to, cc, bcc }
      })
      html = trackedBody.bodyHtml
      trackedLinks = trackedBody.trackedLinks
    }

    const result = await sendEmail({
      from: getDefaultFromEmail(),
      to,
      cc,
      bcc,
      subject: email.subject || '',
      html,
      text
    })

    if (trackingEnabled) {
      await persistTrackedLinks({ emailId, orgId: email.org_id, trackedLinks })
      await upsertEmailAnalytic({ emailId, eventType: 'sent' })
    }

    await pool.query(
      `UPDATE email_recipient
       SET send_status = 'sent', provider_message_id = $2, sent_at = NOW(), updated_at = NOW()
       WHERE email_id = $1 AND send_status = 'pending'`,
      [emailId, result.message_id]
    )
    await pool.query(
      `UPDATE email
       SET message_id = $2, sent_at = NOW(), queued_at = COALESCE(queued_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [emailId, result.message_id]
    )
    await markQueueCompleted(queueId)
    await promoteNextHoldQueue(email.org_id, queue.category)

    logger.info(`[email-service] sent email ${emailId} (queue ${queueId}) via ${result.stubbed ? 'stub' : 'SES'}`, {
      message_id: result.message_id,
      recipient_count: allRecipients.length,
      tracking_enabled: trackingEnabled,
      tracked_link_count: trackedLinks.length
    })

    return { status: 'completed', message_id: result.message_id }
  } catch (error) {
    const errorMessage = (error as Error)?.message || 'Unknown error'
    logger.error(`[email-service] failed to send email for queue ${queueId}: ${errorMessage}`)

    if (emailId) {
      await pool.query(
        `UPDATE email_recipient
         SET send_status = 'failed', updated_at = NOW()
         WHERE email_id = $1 AND send_status = 'pending'`,
        [emailId]
      )
    }

    const nextRetry = (queue.retry_count || 0) + 1
    if (nextRetry >= maxRetries) {
      await markQueueFailed(queueId)
      logger.error(`[email-service] queue ${queueId} exhausted retries (${nextRetry}) - marked failed`)
      return { status: 'failed' }
    }

    await requeueWithBackoff(queueId, nextRetry)
    logger.warn(`[email-service] queue ${queueId} requeued with backoff (retry ${nextRetry})`)
    return { status: 'ready' }
  }
}
