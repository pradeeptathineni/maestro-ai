// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StateBadge } from './ui.js';

afterEach(cleanup);

describe('evidence-state presentation', () => {
  it('renders missing, zero, not applicable, stale, and contradicted as explicit text', () => {
    render(
      <div>
        {['missing', 'zero', 'not_applicable', 'stale', 'contradicted'].map((state) => (
          <StateBadge state={state} key={state} />
        ))}
      </div>,
    );
    for (const name of ['Missing', 'Zero', 'Not Applicable', 'Stale', 'Contradicted']) {
      expect(screen.getByText(name)).toBeDefined();
    }
  });
});
