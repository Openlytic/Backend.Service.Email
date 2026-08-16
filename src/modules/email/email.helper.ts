import { pool } from 'src/utils/database'

export interface EmailRow {
  id: string
  subject: string | null
  snippet: string | null
  body_html: string | null
  thread_id: string | null
  message_id: string | null
  org_id: string | null
  org_user_id: string | null
  stage: string
}

export interface EmailRecipientRow {
  id: string
  email_id: string
  email: string
  type: string
  send_status: string
  provider_message_id: string | null
  provider_thread_id: string | null
  sent_at: Date | null
}

export interface EmailWithRecipients {
  email: EmailRow
  recipients: EmailRecipientRow[]
}

export const getEmailWithRecipients = async (emailId: string): Promise<EmailWithRecipients | null> => {
  const emailResult = await pool.query('SELECT * FROM email WHERE id = $1', [emailId])
  if (!emailResult.rows.length) return null

  const recipientsResult = await pool.query(
    'SELECT * FROM email_recipient WHERE email_id = $1 ORDER BY created_at ASC',
    [emailId]
  )

  return {
    email: emailResult.rows[0] as EmailRow,
    recipients: recipientsResult.rows as EmailRecipientRow[]
  }
}
