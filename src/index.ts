// Openlytic's email lambda routes SQS send_email jobs and the public tracking

import { handler as httpHandler } from 'src/modules/handlers/http/http.handler'
import { handler as sqsHandler } from 'src/modules/handlers/sqs/sqs.handler'

interface HttpTrackingEvent {
  httpMethod?: string
  path?: string
  queryStringParameters?: Record<string, string | undefined> | null
  headers?: Record<string, string | undefined>
}

interface SqsEvent {
  Records?: Array<{ body?: unknown; messageId?: string }>
}

export const handler = async (event: Record<string, unknown>) => {
  if (event?.httpMethod) {
    return httpHandler(event as HttpTrackingEvent)
  }

  if (event?.source === 'aws.events' || event?.['detail-type'] === 'Scheduled Event') {
    throw new Error('Scheduled handler not ported - Openlytic email lambda is SQS-triggered only')
  }

  return sqsHandler(event as SqsEvent)
}
