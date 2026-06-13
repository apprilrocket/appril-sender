import { supabase } from './supabase'
import { sendEmail } from './ses'
import { sendWhatsApp } from './whatsapp'

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '50')
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS ?? '3')

/** Lambda `appril-crm-sender` — disparada por EventBridge cada 2 min (rate(2 minutes)). */
export async function handler(_event: any) {
  const sb = supabase()
  const startedAt = Date.now()
  const { data: pending, error: fetchErr } = await sb
    .from('message_queue')
    .select('id, workspace_id, lead_id, template_key, channel, to_address, payload, attempts')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(BATCH_SIZE)
  if (fetchErr) throw new Error(`Fetch queue failed: ${fetchErr.message}`)
  if (!pending || pending.length === 0) {
    console.log(`[${new Date().toISOString()}] sender: nothing to send`)
    return { processed: 0, ok: 0, failed: 0 }
  }
  console.log(`[${new Date().toISOString()}] sender: ${pending.length} mensajes a procesar`)
  const templateKeys = Array.from(new Set(pending.map((p) => p.template_key)))
  const { data: templates } = await sb
    .from('message_templates')
    .select(
      'template_key, channel, subject, html_body, text_body, wa_template_name, wa_language, wa_components, variables',
    )
    .in('template_key', templateKeys)
  const tplByKey = new Map((templates ?? []).map((t) => [t.template_key, t]))
  const ids = pending.map((p) => p.id)
  await sb.from('message_queue').update({ status: 'sending' }).in('id', ids)
  let ok = 0
  let failed = 0
  for (const msg of pending) {
    const tpl = tplByKey.get(msg.template_key)
    if (!tpl) {
      await markFailed(msg, 'TEMPLATE_NOT_FOUND', `Template ${msg.template_key} no encontrado o inactivo`)
      failed++
      continue
    }
    const attemptNumber = (msg.attempts ?? 0) + 1
    const attemptStart = new Date()
    const result =
      msg.channel === 'email'
        ? await sendEmail({ to: msg.to_address, template: tpl, payload: msg.payload ?? {} })
        : await sendWhatsApp({ to: msg.to_address, template: tpl, payload: msg.payload ?? {} })
    await sb.from('message_attempts').insert({
      message_id: msg.id,
      attempt_number: attemptNumber,
      started_at: attemptStart.toISOString(),
      finished_at: new Date().toISOString(),
      status: result.ok ? 'success' : 'error',
      error_code: result.ok ? null : result.errorCode,
      error_message: result.ok ? null : result.errorMessage,
      response_payload: result.ok ? { messageId: result.messageId } : null,
    })
    if (result.ok) {
      await sb
        .from('message_queue')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          attempts: attemptNumber,
          ses_message_id: msg.channel === 'email' ? result.messageId : null,
          wa_message_id: msg.channel === 'whatsapp' ? result.messageId : null,
        })
        .eq('id', msg.id)
      await sb.from('lead_events').insert({
        workspace_id: msg.workspace_id,
        lead_id: msg.lead_id,
        event_type: 'message_sent',
        event_channel: msg.channel,
        event_value: msg.template_key,
        metadata: { message_id: msg.id, external_id: result.messageId },
      })
      await sb
        .from('leads_master')
        .update({ last_contacted_at: new Date().toISOString(), last_channel_touched: msg.channel })
        .eq('id', msg.lead_id)
      ok++
    } else {
      const exhausted = attemptNumber >= MAX_ATTEMPTS
      await sb
        .from('message_queue')
        .update({
          status: exhausted ? 'failed' : 'pending',
          attempts: attemptNumber,
          last_error: `${result.errorCode}: ${result.errorMessage}`,
          scheduled_at: exhausted ? null : new Date(Date.now() + 60000 * attemptNumber * 5).toISOString(),
        })
        .eq('id', msg.id)
      failed++
    }
  }
  console.log(
    `[${new Date().toISOString()}] sender: done in ${Date.now() - startedAt}ms — ok=${ok} failed=${failed}`,
  )
  return { processed: pending.length, ok, failed }
}

async function markFailed(msg: any, code: string, message: string) {
  const sb = supabase()
  await sb.from('message_queue').update({ status: 'failed', last_error: `${code}: ${message}` }).eq('id', msg.id)
  await sb.from('message_attempts').insert({
    message_id: msg.id,
    attempt_number: (msg.attempts ?? 0) + 1,
    status: 'error',
    error_code: code,
    error_message: message,
  })
}
