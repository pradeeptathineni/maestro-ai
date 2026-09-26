import { describe, expect, it } from 'vitest';
import { formatFractionPercent } from './api.js';

describe('fraction presentation', () => {
  it('renders stored 0–1 coverage as a 0–100 percentage', () => {
    expect(formatFractionPercent(0)).toBe('0%');
    expect(formatFractionPercent(0.475)).toBe('48%');
    expect(formatFractionPercent(1)).toBe('100%');
  });
});
