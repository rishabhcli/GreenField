import { describe, expect, it } from 'vitest';
import { trackedProductOutOfStock } from '../src/routes/commerce.js';

describe('trackedProductOutOfStock', () => {
  it('rejects a tracked product with no remaining units', () => {
    expect(
      trackedProductOutOfStock(
        { sku: 'zhc-founding', inventory_policy: 'track', inventory_on_hand: 1, inventory_reserved: 1 },
        1,
      ),
    ).toBe(true);
  });

  it('allows a tracked product with remaining units', () => {
    expect(
      trackedProductOutOfStock(
        { sku: 'zhc-founding', inventory_policy: 'track', inventory_on_hand: 5, inventory_reserved: 1 },
        2,
      ),
    ).toBe(false);
  });

  it('does not treat untracked inventory as out of stock', () => {
    expect(
      trackedProductOutOfStock(
        { sku: 'zhc-founding', inventory_policy: 'continue', inventory_on_hand: 0, inventory_reserved: 0 },
        1,
      ),
    ).toBe(false);
  });
});
