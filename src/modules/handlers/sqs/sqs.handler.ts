import { getAppQueue } from 'src/modules/app-queue/app-queue.helper'
import { processSendEmailQueue } from 'src/modules/email/email.service'
import { logger } from 'src/utils/logger'

interface QueueEnvelope {
  event?: string
  queue_id?: string
  params?: Record<string, unknown>
}

interface SqsRecord {
  body?: unknown
  messageId?: string
}

interface SqsEvent {
  Records?: SqsRecord[]
}

export const processQueueEnvelope = async (envelope: QueueEnvelope) => {
  const queueId = envelope?.queue_id
  if (!queueId) {
    logger.warn('[sqs-handler] envelope missing queue_id - skipping')
    return null
  }

  const queue = await getAppQueue(queueId)
  if (!queue) {
    logger.warn(`[sqs-handler] queue ${queueId} not found - skipping`)
    return null
  }

  if (queue.event === 'send_email') {
    return processSendEmailQueue(queue)
  }

  logger.warn(`[sqs-handler] unsupported event "${queue.event}" on queue ${queueId} - leaving for another consumer`)
  return null
}

const prepareEventBody = (record: SqsRecord): QueueEnvelope => {
  if (typeof record?.body !== 'string') {
    return (record?.body || {}) as QueueEnvelope
  }
  try {
    return JSON.parse(record.body) as QueueEnvelope
  } catch {
    return {}
  }
}

export const handler = async (event: SqsEvent) => {
  const { Records = [] } = event || {}

  if (!Records.length) {
    return { batchItemFailures: [] }
  }

  const results = await Promise.all(
    Records.map(async (record) => {
      try {
        await processQueueEnvelope(prepareEventBody(record))
        return null
      } catch (error) {
        logger.error('[sqs-handler] error processing record', (error as Error)?.message)
        return record?.messageId || null
      }
    })
  )

  const failedMessageIds = results.filter((messageId): messageId is string => Boolean(messageId))
  return { batchItemFailures: failedMessageIds.map((itemIdentifier) => ({ itemIdentifier })) }
}
