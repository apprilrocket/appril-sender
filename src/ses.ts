import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'
import { randomUUID } from 'node:crypto'
import { renderTemplate } from './templates'
import type { SendArgs, SendResult } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Envío de email por SES con MIME crudo (SendRawEmailCommand).
// Motivo del cambio: el comando "Simple" (SendEmailCommand) NO admite headers
// personalizados, por lo que era imposible añadir `List-Unsubscribe` (requisito
// P0 de deliverability para envío masivo en Gmail/Outlook). Con RawEmail armamos
// el MIME a mano y podemos incluir los headers.
//
// List-Unsubscribe sale de payload.unsubscribe_url (per-lead, lo hidrata
// crm_launch_campaign con el token `dl`):
//   - Si es HTTPS (endpoint email-unsubscribe) → one-click: además se emite
//     `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
//   - Si es mailto → solo header mailto.
//   - Fallback global opcional: env SES_UNSUBSCRIBE_MAILTO.
// Si no hay ninguna fuente, se envía sin el header (comportamiento previo).
//
// Tracking de aperturas/clicks: se conserva vía ConfigurationSetName.
// ─────────────────────────────────────────────────────────────────────────────

let _ses: SESClient | null = null

function ses(): SESClient {
  if (_ses) return _ses
  _ses = new SESClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  return _ses
}

/** Codifica un header con RFC 2047 (Base64) solo si tiene caracteres no-ASCII.
 *  Pliega en varias palabras codificadas para no exceder el límite de 75 chars. */
function encodeHeaderWord(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s
  const MAX_BYTES = 39 // base64(39B)=52 chars; con envoltorio "=?UTF-8?B?...?=" < 75
  const words: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (curBytes + chBytes > MAX_BYTES && cur) {
      words.push(cur)
      cur = ''
      curBytes = 0
    }
    cur += ch
    curBytes += chBytes
  }
  if (cur) words.push(cur)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

/** Cuerpo en base64 plegado a 76 chars por línea (RFC 2045). */
function base64Body(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
}

interface RawEmailOpts {
  from: string
  to: string
  replyTo?: string
  subject: string
  html?: string
  text?: string
  listUnsubscribe?: string
  oneClick?: boolean
}

/** Arma un mensaje MIME crudo (CRLF) compatible con SES SendRawEmail. */
function buildRawEmail(opts: RawEmailOpts): string {
  const CRLF = '\r\n'
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  headers.push(`To: ${opts.to}`)
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`)
  headers.push(`Subject: ${encodeHeaderWord(opts.subject)}`)
  headers.push('MIME-Version: 1.0')
  if (opts.listUnsubscribe) {
    headers.push(`List-Unsubscribe: ${opts.listUnsubscribe}`)
    if (opts.oneClick) headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  }

  // multipart/alternative: text primero, html después (de menos a más preferido).
  const parts: { ct: string; body: string }[] = []
  if (opts.text) parts.push({ ct: 'text/plain; charset=UTF-8', body: opts.text })
  if (opts.html) parts.push({ ct: 'text/html; charset=UTF-8', body: opts.html })

  if (parts.length === 1) {
    const p = parts[0]
    headers.push(`Content-Type: ${p.ct}`)
    headers.push('Content-Transfer-Encoding: base64')
    return headers.join(CRLF) + CRLF + CRLF + base64Body(p.body) + CRLF
  }

  const boundary = `=_appril_${randomUUID()}`
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
  const segs: string[] = []
  for (const p of parts) {
    segs.push(`--${boundary}`)
    segs.push(`Content-Type: ${p.ct}`)
    segs.push('Content-Transfer-Encoding: base64')
    segs.push('')
    segs.push(base64Body(p.body))
  }
  segs.push(`--${boundary}--`)
  return headers.join(CRLF) + CRLF + CRLF + segs.join(CRLF) + CRLF
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const from = process.env.SES_FROM_EMAIL
  const replyTo = process.env.SES_REPLY_TO
  const configSet = process.env.SES_CONFIGURATION_SET
  const subject = renderTemplate(args.template.subject, args.payload)
  const htmlBody = renderTemplate(args.template.html_body, args.payload)
  const textBody = renderTemplate(args.template.text_body, args.payload)

  if (!from)
    return { ok: false, errorCode: 'CONFIG', errorMessage: 'SES_FROM_EMAIL no configurado' }
  if (!subject)
    return { ok: false, errorCode: 'INVALID_TEMPLATE', errorMessage: 'Email template requires subject' }
  if (!htmlBody && !textBody)
    return { ok: false, errorCode: 'INVALID_TEMPLATE', errorMessage: 'Email template requires html_body or text_body' }

  // ── List-Unsubscribe ────────────────────────────────────────────────────────
  // Fuente principal: payload.unsubscribe_url (per-lead, lo hidrata
  // crm_launch_campaign con el token dl). Si es HTTPS → one-click (RFC 8058).
  // Si es mailto → solo header mailto. SES_UNSUBSCRIBE_MAILTO es fallback global.
  const unsubEntries: string[] = []
  let oneClick = false
  const leadUnsub = typeof args.payload.unsubscribe_url === 'string' ? args.payload.unsubscribe_url.trim() : ''
  if (leadUnsub) {
    unsubEntries.push(`<${leadUnsub}>`)
    if (/^https:\/\//i.test(leadUnsub)) oneClick = true
  }
  const mailtoEnv = process.env.SES_UNSUBSCRIBE_MAILTO?.trim()
  if (!leadUnsub && mailtoEnv) unsubEntries.push(`<${mailtoEnv}>`)
  const listUnsubscribe = unsubEntries.length ? unsubEntries.join(', ') : undefined

  const raw = buildRawEmail({
    from,
    to: args.to,
    replyTo: replyTo || undefined,
    subject,
    html: htmlBody || undefined,
    text: textBody || undefined,
    listUnsubscribe,
    oneClick,
  })

  try {
    const result = await ses().send(
      new SendRawEmailCommand({
        Source: from,
        Destinations: [args.to],
        ConfigurationSetName: configSet,
        RawMessage: { Data: Buffer.from(raw, 'utf8') },
      }),
    )
    return { ok: true, messageId: result.MessageId ?? '' }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    return { ok: false, errorCode: e.name ?? 'SES_ERROR', errorMessage: e.message ?? String(err) }
  }
}
