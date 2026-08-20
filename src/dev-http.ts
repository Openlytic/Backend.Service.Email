// Local HTTP server for the tracking endpoints — mirrors the API Gateway event the
// lambda receives in prod (used only for dev E2E; `sam local start-api` is the
// production-faithful alternative). Usage: npm run dev:http -- --port 3001
import http from 'node:http'

import { handler } from 'src/index'
import { logger } from 'src/utils/logger'

interface LambdaResponse {
  statusCode?: number
  body?: string
  headers?: Record<string, string>
  isBase64Encoded?: boolean
}

const port = Number(process.argv[2]) || 3001

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    const event = {
      httpMethod: req.method || 'GET',
      path: url.pathname,
      body: Buffer.concat(chunks).toString('utf8'),
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      headers: {
        ...(req.headers as Record<string, string | undefined>),
        'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress || undefined
      }
    }

    const response = (await handler(event)) as LambdaResponse

    res.statusCode = response?.statusCode || 200
    Object.entries(response?.headers || {}).forEach(([key, value]) => {
      res.setHeader(key, value)
    })

    if (response?.isBase64Encoded) {
      res.end(Buffer.from(response?.body || '', 'base64'))
    } else {
      res.end(response?.body || '')
    }
  })
})

server.listen(port, () => {
  logger.info('[dev:http] tracking server listening on', `http://localhost:${port}`)
})