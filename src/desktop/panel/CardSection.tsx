import type { ReactNode } from 'react';

export interface CardSectionProps {
  /** Accessible name for the group. */
  label: string;
  /** Optional visible heading; omit it when the divider already communicates the grouping. */
  title?: string;
  kind: 'primary' | 'secondary';
  children: ReactNode;
}

/** The shared information rhythm inside every provider card. */
export function CardSection(props: CardSectionProps) {
  return (
    <section className={`card-section card-section-${props.kind}`} aria-label={props.label}>
      {props.kind === 'secondary' && props.title ? (
        <h3 className="card-section-title">{props.title}</h3>
      ) : null}
      <div className="card-section-content">{props.children}</div>
    </section>
  );
}
