import { createPublicKey, verify } from 'node:crypto'

import { envBool } from 'src/utils/env'

const SIGNING_EXCLUDED_KEYS = new Set(['Message', 'Signature', 'SigningCertURL', 'Timestamp', 'Type', 'UnsubscribeURL'])

export const isSnsSignatureVerificationEnabled = (): boolean => envBool('SNS_WEBHOOK_SIGNATURE_VERIFICATION', true)

export const validateSigningCertUrl = (certUrl = ''): boolean => {
  if (!certUrl) return false

  try {
    const url = new URL(certUrl)
    if (url.protocol !== 'https:') return false
    return /(^|\.)amazonaws\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

export const buildSnsStringToSign = (message: Record<string, unknown>): string => {
  const signableKeys = Object.keys(message)
    .filter((key) => !SIGNING_EXCLUDED_KEYS.has(key))
    .sort()

  let stringToSign = ''
  signableKeys.forEach((key) => {
    stringToSign += `${key}\n${String(message[key])}\n`
  })
  stringToSign += `Message\n${String(message.Message || '')}\n`

  return stringToSign
}

export const verifySnsSignature = (message: Record<string, unknown>, publicKeyPem: string): boolean => {
  const signature = message.Signature
  const signatureVersion = message.SignatureVersion
  if (!signature || !signatureVersion) return false

  const algorithm = signatureVersion === '2' ? 'sha256' : 'sha1'

  try {
    const publicKey = createPublicKey(publicKeyPem)
    return verify(
      algorithm,
      Buffer.from(buildSnsStringToSign(message)),
      publicKey,
      Buffer.from(String(signature), 'base64')
    )
  } catch {
    return false
  }
}

export const fetchSnsPublicKey = async (certUrl: string): Promise<string | null> => {
  try {
    const response = await fetch(certUrl)
    if (!response.ok) return null

    const certPem = await response.text()
    const certMatch = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
    return certMatch ? certMatch[0] : null
  } catch {
    return null
  }
}

export const isSnsMessageSignatureValid = async (message: Record<string, unknown>): Promise<boolean> => {
  if (!isSnsSignatureVerificationEnabled()) return true
  if (!validateSigningCertUrl(String(message.SigningCertURL || ''))) return false

  const publicKeyPem = await fetchSnsPublicKey(String(message.SigningCertURL || ''))
  if (!publicKeyPem) return false

  return verifySnsSignature(message, publicKeyPem)
}
