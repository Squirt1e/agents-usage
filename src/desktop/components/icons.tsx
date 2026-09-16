/**
 * Inline monochrome icons.
 *
 * The panel ships no icon dependency; these are the strokes the confirmed design
 * uses (refresh, platform management grid, pin, gear, tune sliders, back
 * chevron). Everything inherits `currentColor` so the CSS controls the accent
 * colour.
 */

export function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4" />
    </svg>
  );
}

export function ManagePlatformsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2.5" width="5" height="5" rx="1" />
      <rect x="12.5" y="2.5" width="5" height="5" rx="1" />
      <rect x="2.5" y="12.5" width="5" height="5" rx="1" />
      <path d="M15 12v6m-3-3h6" />
    </svg>
  );
}

export function PinIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="m7 3 6 0-1 5 3 3v1H5v-1l3-3-1-5Zm3 9v6" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="m8 2-.7 2.1-2 .9-2.1-.4-1 1.8 1.4 1.7-.2 2.2L2 12l1 1.8 2.2-.2 1.8 1.3.6 2.1h2.1l.9-2 2.1-.7 2 .5 1.2-1.8-1.2-1.8.2-2.2 1.5-1.5-1-1.8-2.2.1-1.8-1.3-.5-2.1Z" />
      <circle cx="9.5" cy="9.5" r="2.5" />
    </svg>
  );
}

/** Sliders: the per-platform configuration entry, kept distinct from the app
    settings gear so the two entries do not read as the same control. */
export function TuneIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3 6h14M3 14h14" />
      <path d="M13 3.5v5M7 11.5v5" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M12 4 6 10l6 6" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M9 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V11M12 4h4v4M16 4l-6 6" />
    </svg>
  );
}

/** Drag handle for reordering rows (six-dot grip). */
export function GripIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="7.5" cy="6" r="1.1" />
      <circle cx="12.5" cy="6" r="1.1" />
      <circle cx="7.5" cy="10" r="1.1" />
      <circle cx="12.5" cy="10" r="1.1" />
      <circle cx="7.5" cy="14" r="1.1" />
      <circle cx="12.5" cy="14" r="1.1" />
    </svg>
  );
}
