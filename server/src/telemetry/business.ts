/**
 * Business event tracking for engagement and feature adoption metrics
 * 100% capture (no sampling) of key business events
 * Targets: <1ms per event, structured metadata capture
 *
 * Usage:
 *   trackBusiness('user_login', { userId: 'u123', platform: 'web' })
 *   trackBusiness('file_saved', { userId: 'u123', sceneComplexity: 250, format: 'bmh' })
 *   trackBusiness('feature_used', { userId: 'u123', feature: 'collaborative_edit', details: {...} })
 */

export type BusinessEventType =
  | 'user_login'
  | 'file_saved'
  | 'collaboration_sync'
  | 'export_rendered'
  | 'import_model'
  | 'feature_used';

export interface BusinessEventMetadata {
  [key: string]: any;
}

export interface BusinessEvent {
  event: BusinessEventType;
  userId?: string;
  timestamp: number;
  metadata: BusinessEventMetadata;
}

/**
 * Emit a structured business event to telemetry
 * Low-overhead, 100% capture — no sampling or filtering
 *
 * @param eventType - Type of business event
 * @param data - Event metadata (userId, contextual details)
 */
export function trackBusiness(eventType: BusinessEventType, data: BusinessEventMetadata = {}): void {
  const t0 = performance.now();

  const businessEvent: BusinessEvent = {
    event: eventType,
    userId: data.userId,
    timestamp: Date.now(),
    metadata: { ...data },
  };

  // Emit event as JSON for aggregation
  console.log(JSON.stringify(businessEvent));

  // Monitor overhead
  const overheadMs = performance.now() - t0;
  if (overheadMs > 1) {
    console.warn(
      `[telemetry-overhead] Business event tracking took ${overheadMs.toFixed(3)}ms (target <1ms) for event=${eventType}`,
    );
  }
}

/**
 * Generic escape hatch for ad-hoc business event types not yet in the
 * BusinessEventType union — mirrors the client-side telemetry.track().
 */
export function trackCustomEvent(eventType: string, data: BusinessEventMetadata = {}): void {
  trackBusiness(eventType as BusinessEventType, data);
}

/**
 * Convenience function to track user login events
 */
export function trackUserLogin(userId: string, platform?: string): void {
  trackBusiness('user_login', { userId, platform });
}

/**
 * Convenience function to track file save events
 */
export function trackFileSaved(userId: string, sceneComplexity?: number, format?: string): void {
  trackBusiness('file_saved', { userId, sceneComplexity, format });
}

/**
 * Convenience function to track collaboration sync events
 */
export function trackCollaborationSync(userId: string, teamId?: string, changes?: number): void {
  trackBusiness('collaboration_sync', { userId, teamId, changes });
}

/**
 * Convenience function to track export events
 */
export function trackExportRendered(userId: string, format?: string, itemCount?: number): void {
  trackBusiness('export_rendered', { userId, format, itemCount });
}

/**
 * Convenience function to track import events
 */
export function trackImportModel(userId: string, format?: string, itemCount?: number): void {
  trackBusiness('import_model', { userId, format, itemCount });
}

/**
 * Convenience function to track feature usage
 */
export function trackFeatureUsed(userId: string, feature: string, details?: Record<string, any>): void {
  trackBusiness('feature_used', { userId, feature, ...details });
}
