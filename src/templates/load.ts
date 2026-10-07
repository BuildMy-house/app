import type { TemplatePlan } from './types'

/** Template ids are lowercase kebab-case slugs; anything else is rejected before any fetch. */
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** `?template=<id>` from a location.search string, or null when absent/malformed. */
export function templateIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('template')
  return id !== null && TEMPLATE_ID.test(id) ? id : null
}

/** `search` with the template param removed, so a reload keeps the user's edits (autosaved draft) instead of re-applying the template. */
export function searchWithoutTemplate(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('template')
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}

export async function fetchTemplatePlan(id: string, fetchFn: typeof fetch = fetch): Promise<TemplatePlan> {
  // Relative like the catalog manifest, so it resolves under whatever base the app is served from.
  const response = await fetchFn(`templates/${id}.json`)
  if (!response.ok) throw new Error(`Template "${id}" not found (HTTP ${response.status})`)
  const plan = (await response.json()) as TemplatePlan
  if (plan.schemaVersion !== 1 || plan.id !== id) throw new Error(`Template "${id}" is not a valid template file`)
  return plan
}
