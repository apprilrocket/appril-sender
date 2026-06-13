import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { renderTemplate } from './templates'

let _ses: SESClient | null = null

function ses(): SESClient {
  if (_ses) return _ses
  _ses = new SESClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  return _ses
}

export async function sendEmail(args: {
  to: string
  template: any
  payload: Record<string, any>
}) {
  const from = process.env.SES_FROM_EMAIL
  const replyTo = process.env.SES_REPLY_TO
  const configSet = process.env.SES_CONFIGURATION_SET
  const subject = renderTemplate(args.template.subject, args.payload)
  const htmlBody = renderTemplate(args.template.html_body, args.payload)
  const textBody = renderTemplate(args.template.text_body, args.payload)
  if (!subject)
    return { ok: false, errorCode: 'INVALID_TEMPLATE', errorMessage: 'Email template requires subject' }
  if (!htmlBody && !textBody)
    return { ok: false, errorCode: 'INVALID_TEMPLATE', errorMessage: 'Email template requires html_body or text_body' }
  try {
    const result = await ses().send(
      new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: [args.to] },
        ReplyToAddresses: replyTo ? [replyTo] : undefined,
        ConfigurationSetName: configSet,
        Message: {
          Subject: { Charset: 'UTF-8', Data: subject },
          Body: {
            ...(htmlBody ? { Html: { Charset: 'UTF-8', Data: htmlBody } } : {}),
            ...(textBody ? { Text: { Charset: 'UTF-8', Data: textBody } } : {}),
          },
        },
      }),
    )
    return { ok: true, messageId: result.MessageId ?? '' }
  } catch (err: any) {
    return { ok: false, errorCode: err.name ?? 'SES_ERROR', errorMessage: err.message ?? String(err) }
  }
}
