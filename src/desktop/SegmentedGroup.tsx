import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface SegmentedGroupProps {
  label: string;
  children: ReactNode;
}

interface PillPosition {
  left: number;
  width: number;
}

/** A single visual selection moves across mutually exclusive choices. */
export function SegmentedGroup({ label, children }: SegmentedGroupProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PillPosition | null>(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const measure = () => {
      const active = group.querySelector<HTMLElement>('.segmented-option[aria-pressed="true"]');
      if (!active) {
        setPosition(null);
        return;
      }
      const next = { left: active.offsetLeft, width: active.offsetWidth };
      setPosition((previous) =>
        previous?.left === next.left && previous.width === next.width ? previous : next
      );
    };

    measure();
    // Font and host-width changes can move a choice without changing React state.
    // Re-measuring keeps the pill on its button; CSS owns the actual interpolation.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    group.querySelectorAll('.segmented-option').forEach((option) => observer.observe(option));
    return () => observer.disconnect();
  });

  return (
    <div ref={groupRef} className="segmented has-slider" role="group" aria-label={label}>
      {position ? (
        <span
          className="segmented-slider"
          aria-hidden="true"
          style={{ transform: `translateX(${position.left}px)`, width: position.width }}
        />
      ) : null}
      {children}
    </div>
  );
}
