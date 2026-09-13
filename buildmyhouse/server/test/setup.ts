import { beforeEach } from 'vitest';
import { _resetRegRateLimit } from '../src/auth.js';

beforeEach(() => {
  _resetRegRateLimit();
});
