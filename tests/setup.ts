import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// jsdom does not implement `PointerEvent`, and Testing Library falls back to a
// plain `Event` for `fireEvent.pointer*` when it is missing — which drops
// `clientY`/`button` and makes pointer-driven UI untestable. `MouseEvent` carries
// exactly the fields the panel reads, so it stands in for the constructor.
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}
