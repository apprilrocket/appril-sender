import crypto from 'crypto'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { supabase } from './supabase'

/** Lambda `appril-crm-webhook` — detrás de API Gateway (HTTP API v2). Recibe webhooks
 *  de SES (vía SNS), WhatsApp Cloud API y endpoints externos. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath ?? '/'
  try {
    if (path.startsWith('/webhook/ses')) return await handleSes(event)
    if (path.startsWith('/webhook/whatsapp')) return await handleWhatsApp(event)
    if (path.startsWith('/webhook/external')) return await handleExternalEvent(event)
    return { statusCode: 404, body: 'Not found' }
  } catch (err) {
    const e = err as { message?: string }
    console.error('webhook error:', err)
    return { statusCode: 500, body: `Internal error: ${e.message}` }
  }
}

async function handleSes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body ?? '{}')
  if (body.Type === 'SubscriptionConfirmation') {
    console.log('SNS subscription confirm URL:', body.SubscribeURL)
    try {
      await fetch(body.SubscribeURL)
      console.log('SNS subscription confirmed successfully')
    } catch (e) {
      console.error('Failed to confirm SNS subscription:', e)
    }
    return { statusCode: 200, body: 'confirmed' }
  }
  if (body.Type !== 'Notification') return { statusCode: 200, body: 'ignored' }
  const message = JSON.parse(body.Message)
  const eventType: string = message.eventType ?? message.notificationType
  const sesMessageId: string | undefined = message.mail?.messageId
  if (!sesMessageId) return { statusCode: 200, body: 'no messageId' }
  const sb = supabase()
  const { data: queue } = await sb
    .from('message_queue')
    .select('id, workspace_id, lead_id')
    .eq('ses_message_id', sesMessageId)
    .maybeSingle()
  if (!queue) {
    console.log(`SES event ${eventType} for unknown sesMessageId=${sesMessageId}`)
    return { statusCode: 200, body: 'ignored' }
  }
  const eventMap: Record<string, string> = {
    Delivery: 'email_delivered',
    Open: 'email_opened',
    Click: 'email_clicked',
    Bounce: 'email_bounced',
    Complaint: 'email_complained',
    Reject: 'email_rejected',
  }
  const internalType = eventMap[eventType] ?? `email_${eventType.toLowerCase()}`
  await sb.from('lead_events').insert({
    workspace_id: queue.workspace_id,
    lead_id: queue.lead_id,
    event_type: internalType,
    event_channel: 'email',
    event_value: eventType,
    metadata: message,
  })
  if (eventType === 'Open') await sb.from('leads_master').update({ opened_email: true }).eq('id', queue.lead_id)
  if (eventType === 'Click') await sb.from('leads_master').update({ clicked_email: true }).eq('id', queue.lead_id)
  if (eventType === 'Bounce' && message.bounce?.bounceType === 'Permanent')
    await sb.from('leads_master').update({ hard_bounce: true, can_email: false }).eq('id', queue.lead_id)
  if (eventType === 'Complaint')
    await sb.from('leads_master').update({ unsubscribed_email: true, can_email: false }).eq('id', queue.lead_id)
  return { statusCode: 200, body: 'ok' }
}

async function handleWhatsApp(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method === 'GET') {
    const qs = event.queryStringParameters ?? {}
    if (qs['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
      return { statusCode: 200, body: qs['hub.challenge'] ?? '' }
    }
    return { statusCode: 403, body: 'forbidden' }
  }
  const signature = event.headers?.['x-hub-signature-256']
  const appSecret = process.env.WA_APP_SECRET
  if (signature && appSecret) {
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(event.body ?? '').digest('hex')
    if (signature !== expected) return { statusCode: 401, body: 'invalid signature' }
  }
  const body = JSON.parse(event.body ?? '{}')
  const sb = supabase()
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {}
      for (const s of value.statuses ?? []) {
        const { data: queue } = await sb
          .from('message_queue')
          .select('id, workspace_id, lead_id')
          .eq('wa_message_id', s.id)
          .maybeSingle()
        if (!queue) continue
        await sb.from('lead_events').insert({
          workspace_id: queue.workspace_id,
          lead_id: queue.lead_id,
          event_type: `wa_${s.status}`,
          event_channel: 'whatsapp',
          event_value: s.status,
          metadata: s,
        })
        if (s.status === 'failed') {
          await sb
            .from('message_queue')
            .update({ status: 'failed', last_error: JSON.stringify(s.errors) })
            .eq('id', queue.id)
        }
      }
      for (const m of value.messages ?? []) {
        const fromPhone: string = m.from
        const { data: lead } = await sb
          .from('leads_master')
          .select('id, workspace_id')
          .or(`phone.eq.${fromPhone},phone.eq.+${fromPhone}`)
          .maybeSingle()
        if (lead) {
          await sb.from('lead_events').insert({
            workspace_id: lead.workspace_id,
            lead_id: lead.id,
            event_type: 'wa_reply',
            event_channel: 'whatsapp',
            event_value: m.type,
            metadata: m,
          })
        } else {
          console.log(`WA reply from unknown phone ${fromPhone}`)
        }
      }
    }
  }
  return { statusCode: 200, body: 'ok' }
}

async function handleExternalEvent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const token = event.queryStringParameters?.token
  if (!token) return { statusCode: 401, body: 'missing token' }
  const sb = supabase()
  const { data: endpoint } = await sb
    .from('webhook_endpoints')
    .select('id, workspace_id, secret, active')
    .eq('url_token', token)
    .maybeSingle()
  if (!endpoint || !endpoint.active) return { statusCode: 404, body: 'unknown endpoint' }
  const signature = event.headers?.['x-signature']
  if (signature) {
    const expected = crypto.createHmac('sha256', endpoint.secret).update(event.body ?? '').digest('hex')
    if (signature !== expected) return { statusCode: 401, body: 'invalid signature' }
  }
  const body = JSON.parse(event.body ?? '{}')
  const { event_type, payload } = body
  await sb.from('webhook_events').insert({
    workspace_id: endpoint.workspace_id,
    endpoint_id: endpoint.id,
    event_type,
    payload,
  })
  await sb.from('webhook_endpoints').update({ last_used_at: new Date().toISOString() }).eq('id', endpoint.id)
  return { statusCode: 202, body: 'accepted' }
}
