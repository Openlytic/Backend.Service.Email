import { env, envBool } from 'src/utils/env'

const debugEnabled = envBool('DEBUG', false)

const write = (level: string, message: string, ...args: unknown[]): void => {
  const prefix = `[${new Date().toISOString()}] [${level}] ${message}`
  if (args.length) {
    console.log(prefix, ...args)
  } else {
    console.log(prefix)
  }
}

export const logger = {
  info: (message: string, ...args: unknown[]): void => write('INFO', message, ...args),
  warn: (message: string, ...args: unknown[]): void => write('WARN', message, ...args),
  error: (message: string, ...args: unknown[]): void => write('ERROR', message, ...args),
  debug: (message: string, ...args: unknown[]): void => {
    if (debugEnabled || env('DEBUG_MODULE') === 'email-service') {
      write('DEBUG', message, ...args)
    }
  }
}
