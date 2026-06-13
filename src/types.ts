// Tipos de dominio compartidos por el sender y el webhook.

export type Channel = 'email' | 'whatsapp'

export type Payload = Record<string, unknown>

/** Resultado de un intento de envío (email o WhatsApp). */
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; errorCode: string; errorMessage: string }

/** Fila de `message_templates`. */
export interface MessageTemplate {
  template_key: string
  channel: Channel
  subject?: string | null
  html_body?: string | null
  text_body?: string | null
  wa_template_name?: string | null
  wa_language?: string | null
  wa_components?: unknown
  variables?: unknown
}

/** Fila de `message_queue` (los campos que lee el sender). */
export interface QueuedMessage {
  id: string
  workspace_id: string
  lead_id: string | null
  template_key: string
  channel: Channel
  to_address: string
  payload: Payload | null
  attempts: number | null
}

/** Argumentos comunes de sendEmail / sendWhatsApp. */
export interface SendArgs {
  to: string
  template: MessageTemplate
  payload: Payload
}
