// Local lambda invocation for dev: feeds a synthetic SQS record for a real queue row
// (or all pending `send_email` rows with --all) through the exact `handler` the lambda
// runs. Usage:
//   npm run invoke -- <queue_id>
//   npm run invoke -- --all
import { handler } from 'src/index'
import { findPendingSendQueues, getAppQueue } from 'src/modules/app-queue/app-queue.helper'
import { logger } from 'src/utils/logger'

const invokeQueue = async (queueId: string) => {
  const queue = await getAppQueue(queueId)
  if (!queue) {
    logger.warn(`[invoke] queue ${queueId} not found`)
    return
  }

  const event = {
    Records: [
      {
        body: JSON.stringify({ event: queue.event, queue_id: queue.id, params: queue.params }),
        messageId: `local-${queue.id}`
      }
    ]
  }

  const result = await handler(event)
  logger.info(`[invoke] queue ${queueId} (${queue.event}) ->`, result)
}

const run = async () => {
  const target = process.argv[2]

  if (target && target !== '--all') {
    await invokeQueue(target)
    return
  }

  const pending = await findPendingSendQueues(50)
  if (!pending.length) {
    logger.info('[invoke] no pending send_email queues')
    return
  }

  logger.info(`[invoke] invoking lambda for ${pending.length} pending send_email queue(s)`)
  await Promise.all(pending.map((queue) => invokeQueue(queue.id)))
}

run().catch((error) => {
  logger.error('[invoke] error', (error as Error)?.message)
  process.exit(1)
})
