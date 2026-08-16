import { randomUUID } from 'node:crypto'

import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses'

import { env } from 'src/utils/env'
import { logger } from 'src/utils/logger'

interface SimpleEmailParams {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html: string
  text: string
}

export interface SendEmailResult {
  message_id: string
  stubbed: boolean
}

const isStubMode = (): boolean =>
  env('EMAIL_DELIVERY_MODE', '').toLowerCase() === 'stub' ||
  !env('AWS_ACCESS_KEY_ID') ||
  !env('AWS_SECRET_ACCESS_KEY') ||
  !env('AWS_REGION')

const getSesClient = (): SESClient =>
  new SESClient({
    credentials: {
      accessKeyId: env('AWS_ACCESS_KEY_ID'),
      secretAccessKey: env('AWS_SECRET_ACCESS_KEY')
    },
    region: env('AWS_REGION', 'us-east-1')
  })

const sendViaSes = async (params: SimpleEmailParams): Promise<SendEmailResult> => {
  const client = getSesClient()
  const command = new SendEmailCommand({
    Source: params.from,
    Destination: {
      ToAddresses: params.to,
      CcAddresses: params.cc,
      BccAddresses: params.bcc
    },
    Message: {
      Subject: { Data: params.subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: params.html, Charset: 'UTF-8' },
        Text: { Data: params.text, Charset: 'UTF-8' }
      }
    }
  })

  const response = await client.send(command)
  const messageId = response?.MessageId || ''

  if (!messageId) {
    throw new Error('SES did not return a MessageId')
  }

  return { message_id: messageId, stubbed: false }
}

const sendViaStub = async (params: SimpleEmailParams): Promise<SendEmailResult> => {
  const messageId = `stubbed-${randomUUID()}`
  logger.info('[simple-email-service:stub] sendEmail', {
    from: params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    message_id: messageId
  })
  return { message_id: messageId, stubbed: true }
}

export const sendEmail = async (params: SimpleEmailParams): Promise<SendEmailResult> => {
  if (isStubMode()) {
    logger.warn(
      '[simple-email-service] stub mode (EMAIL_DELIVERY_MODE=stub or missing AWS credentials) - simulating delivery'
    )
    return sendViaStub(params)
  }

  try {
    const result = await sendViaSes(params)
    logger.info('[simple-email-service] sent via SES', { message_id: result.message_id })
    return result
  } catch (error) {
    throw new Error(`Could not send email via SES: ${(error as Error)?.message}`)
  }
}
