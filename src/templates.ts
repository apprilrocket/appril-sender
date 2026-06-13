/** Reemplaza {{ var }} y {{ a.b.c }} en una plantilla con valores del payload. */
export function renderTemplate(
  input: string | null | undefined,
  vars: Record<string, any>,
): string {
  if (!input) return ''
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((acc: any, part: string) => acc?.[part], vars)
    return value !== undefined && value !== null ? String(value) : ''
  })
}
