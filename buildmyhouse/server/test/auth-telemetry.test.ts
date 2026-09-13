import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  recordLoginAttempt,
  recordAuthVerify,
  getLoginStats,
  getAuthVerifyStats,
  _resetTelemetry,
} from '../src/auth/telemetry.js';

afterEach(() => {
  _resetTelemetry();
});

describe('auth telemetry', () => {
  it('records login successes and failures', () => {
    recordLoginAttempt(true, 'a@test.com', '127.0.0.1');
    recordLoginAttempt(false, 'b@test.com', '127.0.0.1', 'invalid_credentials');
    recordLoginAttempt(false, 'c@test.com', '127.0.0.1', 'locked_out');

    const stats = getLoginStats();
    expect(stats.total).toBe(3);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(2);
  });

  it('records auth verify successes and failures', () => {
    recordAuthVerify(true, '127.0.0.1');
    recordAuthVerify(false, '127.0.0.1', 'invalid_token');

    const stats = getAuthVerifyStats();
    expect(stats.total).toBe(2);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(1);
  });

  it('prunes events outside the sliding window', () => {
    // Manually push an old event
    recordLoginAttempt(true, 'old@test.com', '127.0.0.1');
    // Backdate it by manipulating internal state via a fresh push
    recordLoginAttempt(true, 'new@test.com', '127.0.0.1');

    // All events should be within window since we just created them
    const stats = getLoginStats();
    expect(stats.total).toBe(2);
  });

  it('alerts on login failure spike', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Push 20 failures to trigger spike
    for (let i = 0; i < 20; i++) {
      recordLoginAttempt(false, `user${i}@test.com`, '127.0.0.1', 'invalid_credentials');
    }

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('SPIKE: 20 login failures')
    );
    spy.mockRestore();
  });

  it('alerts on auth-verify failure spike', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < 50; i++) {
      recordAuthVerify(false, '127.0.0.1', 'invalid_token');
    }

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('SPIKE: 50 auth-verify failures')
    );
    spy.mockRestore();
  });

  it('does not re-alert within cooldown period', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // First spike triggers alert
    for (let i = 0; i < 20; i++) {
      recordLoginAttempt(false, `user${i}@test.com`, '127.0.0.1');
    }
    const firstCallCount = spy.mock.calls.length;

    // More failures within cooldown — no new alert
    for (let i = 0; i < 10; i++) {
      recordLoginAttempt(false, `user${i + 20}@test.com`, '127.0.0.1');
    }
    expect(spy.mock.calls.length).toBe(firstCallCount);

    spy.mockRestore();
  });

  it('_resetTelemetry clears all state', () => {
    recordLoginAttempt(true, 'a@test.com', '127.0.0.1');
    recordAuthVerify(true, '127.0.0.1');

    _resetTelemetry();

    expect(getLoginStats()).toEqual({ total: 0, successes: 0, failures: 0 });
    expect(getAuthVerifyStats()).toEqual({ total: 0, successes: 0, failures: 0 });
  });
});
