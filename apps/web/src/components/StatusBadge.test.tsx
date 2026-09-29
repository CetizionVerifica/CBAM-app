import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('always shows the status as a word, never colour alone', () => {
    render(<StatusBadge status="issued" />);
    expect(screen.getByText('Issued')).toBeInTheDocument();
  });
});
