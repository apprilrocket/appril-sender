import type { Payload, SendArgs, SendResult } from './types'

export async function sendWhatsApp(args: SendArgs): Promise<SendResult> {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID
  const accessToken = process.env.WA_ACCESS_TOKEN
  const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
  if (!args.template.wa_template_name) {
    return {
      ok: false,
      errorCode: 'INVALID_TEMPLATE',
      errorMessage: 'WhatsApp template requires wa_template_name (approved by Meta)',
    }
  }
  const to = args.to.replace(/^\+/, '')
  const components = args.template.wa_components
    ? injectPayload(args.template.wa_components, args.payload)
    : buildSimpleBody(args.payload)
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: args.template.wa_template_name,
      language: { code: args.template.wa_language ?? 'es' },
      components,
    },
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as {
      messages?: { id?: string }[]
      error?: { code?: number; message?: string }
    }
    if (!res.ok) {
      return {
        ok: false,
        errorCode: json?.error?.code ? String(json.error.code) : 'WA_ERROR',
        errorMessage: json?.error?.message ?? `HTTP ${res.status}`,
      }
    }
    return { ok: true, messageId: json?.messages?.[0]?.id ?? '' }
  } catch (err) {
    const e = err as { message?: string }
    return { ok: false, errorCode: 'WA_NETWORK', errorMessage: e.message ?? String(err) }
  }
}

function buildSimpleBody(payload: Payload) {
  const parameters = Object.values(payload).map((v) => ({ type: 'text', text: String(v ?? '') }))
  if (parameters.length === 0) return []
  return [{ type: 'body', parameters }]
}

function injectPayload(components: unknown, payload: Payload) {
  return JSON.parse(
    JSON.stringify(components).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
      const value = key.split('.').reduce<unknown>((acc, p) => (acc as any)?.[p], payload)
      return value !== undefined && value !== null ? String(value).replace(/"/g, '\\"') : ''
    }),
  )
}
