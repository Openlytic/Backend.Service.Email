import { logger } from 'src/utils/logger'
import {
  trackEmailAttachmentView,
  trackEmailClick,
  trackEmailOpen
} from 'src/modules/email-tracking/email-tracking.service'

interface HttpTrackingEvent {
  httpMethod?: string
  path?: string
  queryStringParameters?: Record<string, string | undefined> | null
  headers?: Record<string, string | undefined>
}

interface HttpTrackingResponse {
  statusCode?: number
  body?: string
  headers?: Record<string, string>
  isBase64Encoded?: boolean
}

const buildResponse = ({
  response,
  contentType
}: {
  response: HttpTrackingResponse
  contentType: string
}) => ({
  body: response?.body || '',
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': true,
    'Content-Type': contentType,
    ...(response?.headers || {})
  },
  ...(response?.isBase64Encoded ? { isBase64Encoded: true } : {}),
  statusCode: response?.statusCode || 200
})

export const handler = async (event: HttpTrackingEvent) => {
  const method = event?.httpMethod
  const path = event?.path
  const queryParams = event?.queryStringParameters || {}
  const headers = event?.headers || {}

  logger.debug('[http-handler] tracking request', { path, method })

  try {
    let response: HttpTrackingResponse
    let contentType = 'application/json'

    switch (path) {
      case '/email-tracking/open':
        if (method !== 'GET') throw new Error('Invalid HTTP method for this endpoint')
        response = await trackEmailOpen({ headers, queryParams })
        contentType = 'image/gif'
        break

      case '/email-tracking/click':
        if (method !== 'GET') throw new Error('Invalid HTTP method for this endpoint')
        response = await trackEmailClick({ headers, queryParams })
        break

      case '/email-tracking/attachment-view':
        if (method !== 'GET') throw new Error('Invalid HTTP method for this endpoint')
        response = await trackEmailAttachmentView({ headers, queryParams })
        contentType = 'image/gif'
        break

      default:
        throw new Error('Unknown tracking endpoint')
    }

    return buildResponse({ response, contentType })
  } catch (err) {
    logger.error('[http-handler] error processing event', (err as Error)?.message)

    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: (err as Error)?.message }),
      statusCode: 500
    }
  }
}