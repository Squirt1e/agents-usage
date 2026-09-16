import { useState } from 'react';

/**
 * A successful refresh remounts this reading. Each visible digit has its own
 * clipped reel, so it travels through 0–9 before landing on the new value.
 * The exact formatted reading remains as accessible text.
 */
export function ReplayNumber(props: { text: string; replay: boolean }) {
  const [rolling, setRolling] = useState(props.replay);
  if (!props.replay || !rolling) return <>{props.text}</>;

  const digits = Array.from({ length: 20 }, (_, index) => String(index % 10));
  return (
    <span className="replay-number">
      <span className="replay-number-target">{props.text}</span>
      <span aria-hidden="true">
        {Array.from(props.text, (character, index) =>
          /[0-9]/.test(character) ? (
            <span className="rolling-number-reel" key={index}>
              <span
                className="rolling-number-strip"
                style={{ transform: `translateY(-${10 + Number(character)}em)` }}
                onAnimationEnd={() => setRolling(false)}
              >
                {digits.map((digit, step) => <span className="rolling-number-digit" key={step}>{digit}</span>)}
              </span>
            </span>
          ) : character === '%' ? (
            <span className="replay-number-percent" key={index}>%</span>
          ) : (
            <span key={index}>{character}</span>
          )
        )}
      </span>
    </span>
  );
}
