import pg from 'pg'

import { env, envInt } from 'src/utils/env'

const { Pool } = pg

export const pool = new Pool({
  connectionString: env('POSTGRES_URL', 'postgres://postgres:*******@localhost:5432/openlytic'),
  max: envInt('POSTGRES_POOL_MAX', 5)
})
