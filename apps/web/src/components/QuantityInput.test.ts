import { describe, expect, it } from 'vitest';
import { draftFrom, draftToInput } from './QuantityInput';

// Review M5 F11: a stored default value saves unchanged, with its library reference.
describe('quantity drafts', () => {
  const stored = { value: '1.5', unit: 't', si: '1.5', source: 'Library 2026.1', provenance: 'default' as const, defaultRef: '9b2f7c1e-4d3a-4e8b-9c6d-2a1b3c4d5e6f' };
  it('keeps the library reference of a default value', () => {
    expect(draftToInput(draftFrom(stored, 't'))).toEqual({ value: '1.5', unit: 't', provenance: 'default', source: 'Library 2026.1', defaultRef: stored.defaultRef });
  });
  it('drops it when the value is no longer a default', () => {
    expect(draftToInput({ ...draftFrom(stored, 't'), provenance: 'measured' })).not.toHaveProperty('defaultRef');
  });
});
