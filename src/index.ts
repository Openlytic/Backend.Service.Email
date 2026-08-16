// Openlytic's email lambda is SQS-triggered only (port of just what the micro-saas
// needs): the `{ event, queue_id, params }` envelope for `send_email` jobs.
import { handler as sqsHandler } from 'src/modules/handlers/sqs/sqs.handler'

export const handler = async (event: Record<string, unknown>) => {
  // HTTP (tracking endpoints / webhooks) and scheduled handlers are not ported.
  if (event?.httpMethod) {
    throw new Error('HTTP handler not ported - Openlytic email lambda is SQS-triggered only')
  }

  if (event?.source === 'aws.events' || event?.['detail-type'] === 'Scheduled Event') {
    throw new Error('Scheduled handler not ported - Openlytic email lambda is SQS-triggered only')
  }

  return sqsHandler(event as { Records?: Array<{ body?: unknown; messageId?: string }> })
}
