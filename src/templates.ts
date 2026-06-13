import type { Payload } from './types'

/** Reemplaza {{ var }} y {{ a.b.c }} en una plantilla con valores del payload. */
export function renderTemplate(input: string | null | undefined, vars: Payload): string {
  if (!input) return ''
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => (acc as any)?.[part], vars)
    return value !== undefined && value !== null ? String(value) : ''
  })
}
