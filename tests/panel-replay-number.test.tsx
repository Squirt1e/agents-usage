// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReplayNumber } from '../src/desktop/panel/ReplayNumber';

describe('refresh number reel', () => {
  it('returns to live text after its roll so later data updates are not frozen', () => {
    const { rerender } = render(<div data-testid="reading"><ReplayNumber text="42" replay /></div>);
    expect(screen.getByTestId('reading').querySelector('.rolling-number-reel')).not.toBeNull();

    fireEvent.animationEnd(screen.getByTestId('reading').querySelector('.rolling-number-strip')!);
    rerender(<div data-testid="reading"><ReplayNumber text="43" replay /></div>);

    expect(screen.getByTestId('reading')).toHaveTextContent('43');
    expect(screen.getByTestId('reading').querySelector('.rolling-number-reel')).toBeNull();
  });
});
