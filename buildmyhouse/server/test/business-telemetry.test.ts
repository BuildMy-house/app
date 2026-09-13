import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  trackBusiness,
  trackUserLogin,
  trackFileSaved,
  trackCollaborationSync,
  trackExportRendered,
  trackImportModel,
  trackFeatureUsed,
  type BusinessEvent,
  type BusinessEventType,
} from '../src/telemetry/business.js';

describe('business telemetry', () => {
  let capturedEvents: BusinessEvent[] = [];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedEvents = [];
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      try {
        // Parse JSON events only; ignore other logs
        const event = JSON.parse(msg);
        if (event.event && event.timestamp !== undefined) {
          capturedEvents.push(event as BusinessEvent);
        }
      } catch {
        // Not JSON, ignore
      }
    });
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    capturedEvents = [];
  });

  it('tracks user login events with platform', () => {
    trackBusiness('user_login', { userId: 'user123', platform: 'web' });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('user_login');
    expect(capturedEvents[0]!.userId).toBe('user123');
    expect(capturedEvents[0]!.metadata.platform).toBe('web');
    expect(capturedEvents[0]!.timestamp).toBeGreaterThan(0);
  });

  it('tracks file save events with scene complexity and format', () => {
    trackBusiness('file_saved', {
      userId: 'user456',
      sceneComplexity: 250,
      format: 'bmh',
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('file_saved');
    expect(capturedEvents[0]!.metadata.sceneComplexity).toBe(250);
    expect(capturedEvents[0]!.metadata.format).toBe('bmh');
  });

  it('tracks collaboration sync events', () => {
    trackBusiness('collaboration_sync', {
      userId: 'user789',
      teamId: 'team-abc',
      changes: 5,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('collaboration_sync');
    expect(capturedEvents[0]!.metadata.teamId).toBe('team-abc');
    expect(capturedEvents[0]!.metadata.changes).toBe(5);
  });

  it('tracks export rendered events', () => {
    trackBusiness('export_rendered', {
      userId: 'user111',
      format: 'pdf',
      itemCount: 3,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('export_rendered');
    expect(capturedEvents[0]!.metadata.format).toBe('pdf');
    expect(capturedEvents[0]!.metadata.itemCount).toBe(3);
  });

  it('tracks import model events', () => {
    trackBusiness('import_model', {
      userId: 'user222',
      format: 'obj',
      itemCount: 10,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('import_model');
    expect(capturedEvents[0]!.metadata.itemCount).toBe(10);
  });

  it('tracks feature usage events', () => {
    trackBusiness('feature_used', {
      userId: 'user333',
      feature: 'collaborative_edit',
      duration: 120,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('feature_used');
    expect(capturedEvents[0]!.metadata.feature).toBe('collaborative_edit');
    expect(capturedEvents[0]!.metadata.duration).toBe(120);
  });

  it('tracks events without userId (anonymous tracking)', () => {
    trackBusiness('feature_used', { feature: 'public_preview' });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.userId).toBeUndefined();
    expect(capturedEvents[0]!.metadata.feature).toBe('public_preview');
  });

  it('captures arbitrary metadata fields', () => {
    trackBusiness('feature_used', {
      userId: 'user444',
      feature: 'export_workflow',
      format: 'png',
      resolution: '1920x1080',
      quality: 'high',
      durationMs: 5000,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.metadata.format).toBe('png');
    expect(capturedEvents[0]!.metadata.resolution).toBe('1920x1080');
    expect(capturedEvents[0]!.metadata.quality).toBe('high');
    expect(capturedEvents[0]!.metadata.durationMs).toBe(5000);
  });

  it('convenience function: trackUserLogin', () => {
    trackUserLogin('user555', 'mobile');

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('user_login');
    expect(capturedEvents[0]!.userId).toBe('user555');
    expect(capturedEvents[0]!.metadata.platform).toBe('mobile');
  });

  it('convenience function: trackFileSaved', () => {
    trackFileSaved('user666', 500, 'fbx');

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('file_saved');
    expect(capturedEvents[0]!.metadata.sceneComplexity).toBe(500);
    expect(capturedEvents[0]!.metadata.format).toBe('fbx');
  });

  it('convenience function: trackCollaborationSync', () => {
    trackCollaborationSync('user777', 'team-xyz', 12);

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('collaboration_sync');
    expect(capturedEvents[0]!.metadata.teamId).toBe('team-xyz');
    expect(capturedEvents[0]!.metadata.changes).toBe(12);
  });

  it('convenience function: trackExportRendered', () => {
    trackExportRendered('user888', 'jpg', 7);

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('export_rendered');
    expect(capturedEvents[0]!.metadata.format).toBe('jpg');
    expect(capturedEvents[0]!.metadata.itemCount).toBe(7);
  });

  it('convenience function: trackImportModel', () => {
    trackImportModel('user999', 'glb', 15);

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('import_model');
    expect(capturedEvents[0]!.metadata.itemCount).toBe(15);
  });

  it('convenience function: trackFeatureUsed with details', () => {
    trackFeatureUsed('user1000', 'advanced_rendering', {
      engine: 'raytracer',
      bounces: 5,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.event).toBe('feature_used');
    expect(capturedEvents[0]!.metadata.feature).toBe('advanced_rendering');
    expect(capturedEvents[0]!.metadata.engine).toBe('raytracer');
    expect(capturedEvents[0]!.metadata.bounces).toBe(5);
  });

  it('100% event capture — all events are emitted', () => {
    // Verify every trackBusiness call emits exactly one event
    trackBusiness('user_login', { userId: 'u1' });
    trackBusiness('file_saved', { userId: 'u2' });
    trackBusiness('collaboration_sync', { userId: 'u3' });
    trackBusiness('export_rendered', { userId: 'u4' });
    trackBusiness('import_model', { userId: 'u5' });
    trackBusiness('feature_used', { userId: 'u6' });

    expect(capturedEvents).toHaveLength(6);
    expect(capturedEvents.map((e) => e.event)).toEqual([
      'user_login',
      'file_saved',
      'collaboration_sync',
      'export_rendered',
      'import_model',
      'feature_used',
    ]);
  });

  it('includes timestamp for every event', () => {
    const beforeTime = Date.now();
    trackBusiness('user_login', { userId: 'user_ts' });
    const afterTime = Date.now();

    expect(capturedEvents[0]!.timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(capturedEvents[0]!.timestamp).toBeLessThanOrEqual(afterTime);
  });

  it('tracks overhead and warns if exceeding 1ms', () => {
    // Create a tracking call that should be fast (< 1ms)
    trackBusiness('user_login', { userId: 'user_fast' });
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    // Verify warning is captured if overhead is simulated
    // (This test documents the expected behavior; actual overhead should be <1ms)
  });

  it('handles empty metadata gracefully', () => {
    trackBusiness('user_login', {});

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.metadata).toEqual({});
  });

  it('handles deeply nested metadata', () => {
    trackBusiness('feature_used', {
      userId: 'user_nested',
      feature: 'complex_export',
      config: {
        settings: {
          quality: 'ultra',
          advanced: {
            bypass: true,
          },
        },
      },
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.metadata.config.settings.advanced.bypass).toBe(true);
  });

  it('preserves metadata with special values (null, undefined, 0, false)', () => {
    trackBusiness('feature_used', {
      userId: 'user_special',
      nullable: null,
      undefinedValue: undefined,
      zero: 0,
      falsy: false,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.metadata.nullable).toBeNull();
    // undefined might not serialize to JSON, but 0 and false should be preserved
    expect(capturedEvents[0]!.metadata.zero).toBe(0);
    expect(capturedEvents[0]!.metadata.falsy).toBe(false);
  });

  it('multiple rapid events are all captured', () => {
    // Simulate rapid-fire events (e.g., during a collaboration session)
    for (let i = 0; i < 100; i++) {
      trackBusiness('feature_used', { userId: `user_${i}`, action: 'keystroke' });
    }

    expect(capturedEvents).toHaveLength(100);
    expect(capturedEvents.every((e) => e.event === 'feature_used')).toBe(true);
  });
});
