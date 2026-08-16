import { pool } from 'src/utils/database'
import { envInt } from 'src/utils/env'

export interface AppQueueRow {
  id: string
  category: string | null
  destination: string
  event: string
  params: Record<string, unknown>
  status: string
  org_id: string | null
  created_by: string | null
  retry_count: number
  delay_seconds: number
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

const mapRow = (row: Record<string, unknown>): AppQueueRow =>
  ({
    ...row,
    params:
      typeof row.params === 'string'
        ? (JSON.parse(row.params as string) as Record<string, unknown>)
        : (row.params as Record<string, unknown>)
  }) as AppQueueRow

export const getAppQueue = async (queueId: string): Promise<AppQueueRow | null> => {
  const { rows } = await pool.query('SELECT * FROM app_queue WHERE id = $1', [queueId])
  return rows.length ? mapRow(rows[0]) : null
}

export const findPendingSendQueues = async (limit: number): Promise<AppQueueRow[]> => {
  const staleMinutes = envInt('STALE_PROCESSING_MINUTES', 5)
  const { rows } = await pool.query(
    `SELECT * FROM app_queue
     WHERE category = 'send_email'
       AND (
         (status IN ('ready', 'sent') AND (updated_at + (delay_seconds * interval '1 second')) <= NOW())
         OR (status = 'processing' AND updated_at <= NOW() - make_interval(mins => $2))
       )
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit, staleMinutes]
  )
  return rows.map((row: Record<string, unknown>) => mapRow(row))
}

export const claimQueueForProcessing = async (queueId: string): Promise<boolean> => {
  const staleMinutes = envInt('STALE_PROCESSING_MINUTES', 5)
  const result = await pool.query(
    `UPDATE app_queue
     SET status = 'processing', updated_at = NOW()
     WHERE id = $1 AND (
       status IN ('ready', 'sent')
       OR (status = 'processing' AND updated_at <= NOW() - make_interval(mins => $2))
     )
     RETURNING id`,
    [queueId, staleMinutes]
  )
  return (result.rowCount ?? 0) > 0
}

export const markQueueCompleted = async (queueId: string): Promise<void> => {
  await pool.query(
    `UPDATE app_queue SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [queueId]
  )
}

export const markQueueFailed = async (queueId: string): Promise<void> => {
  await pool.query(`UPDATE app_queue SET status = 'failed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [
    queueId
  ])
}

export const requeueWithBackoff = async (queueId: string, retryCount: number): Promise<void> => {
  await pool.query(
    `UPDATE app_queue
     SET status = 'ready', retry_count = $2, delay_seconds = LEAST($2 * 60, 300), updated_at = NOW()
     WHERE id = $1`,
    [queueId, retryCount]
  )
}

export const promoteNextHoldQueue = async (orgId: string | null, category: string | null): Promise<void> => {
  if (!orgId || !category) return

  await pool.query(
    `UPDATE app_queue
     SET status = 'ready', updated_at = NOW()
     WHERE id = (
       SELECT id FROM app_queue
       WHERE status = 'hold' AND category = $2 AND org_id = $1
       ORDER BY created_at ASC
       LIMIT 1
     )`,
    [orgId, category]
  )
}
