/**
 * Build-time feature flags.
 *
 * Flags are read from VITE_ env vars at build time (Vite inlines them into
 * the bundle). A flag that is unset or holds any value other than the
 * documented "on" string is disabled — features default to OFF unless the
 * build explicitly opts in.
 */

/**
 * Whether multi-level/multi-floor UI is enabled (add level, level switcher,
 * delete level). Disabled unless VITE_ENABLE_MULTI_LEVEL is exactly 'true'.
 * Default: unset (disabled) — multi-level support is still being hardened,
 * so single-level homes are the polished default experience.
 */
export function isMultiLevelEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_MULTI_LEVEL === 'true'
}
