import { useRef, useState } from "react";

/**
 * Client half of the anti-spam protection on public forms (see
 * server/antiSpam.ts): renders an invisible honeypot input that humans never
 * see but bots tend to fill, and records when the form first rendered so the
 * server can reject implausibly fast submissions. Render `honeypotField`
 * inside the <form> and spread `spamSignals` into the mutation payload.
 */
export function useSpamGuard() {
  const [website, setWebsite] = useState("");
  const renderedAt = useRef(Date.now());

  const honeypotField = (
    <input
      type="text"
      name="website"
      tabIndex={-1}
      autoComplete="off"
      aria-hidden="true"
      value={website}
      onChange={(e) => setWebsite(e.target.value)}
      className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
    />
  );

  return { honeypotField, spamSignals: { website, formRenderedAt: renderedAt.current } };
}
