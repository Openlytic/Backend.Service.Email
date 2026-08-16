import { resolve } from 'node:path'

import dotenv from 'dotenv'

dotenv.config({ path: resolve(process.cwd(), '.env') })

export const env = (name: string, fallback = ''): string => process.env[name] || fallback

export const envInt = (name: string, fallback: number): number => {
  const value = Number.parseInt(env(name), 10)
  return Number.isNaN(value) ? fallback : value
}

export const envBool = (name: string, fallback = false): boolean => {
  const value = env(name)
  if (!value) return fallback
  return value === 'true' || value === '1'
}
