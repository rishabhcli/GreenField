import { describe, expect, it } from 'vitest';
import { DodoAdapter } from '../src/dodo/index.js';

describe('DodoAdapter.refund facade', () => {
  it('exposes refund() so RefundService can call a unified method', () => {
    expect(typeof DodoAdapter.prototype.refund).toBe('function');
  });
});
