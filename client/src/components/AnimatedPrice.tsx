import { useEffect, useMemo, useRef, useState } from "react";
import { formatPrice, priceDecimals } from "@/lib/formatPrice";

/** Smoothly animates numeric price changes with an ease-out counting effect. */
export function AnimatedPrice({ value, className }: { value: number; className?: string }) {
  const [display, setDisplay] = useState(value);
  // Precision comes from the target, not the frame being drawn, so digits don't
  // flicker in and out mid-count — and the figure lands on the exact price
  // ($112.99, not $113) so it always matches the line items beside it.
  const decimals = useMemo(() => priceDecimals(value), [value]);
  const prevRef = useRef(value);
  const rafRef = useRef<number>(0);
  const settleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    if (from === to) return;
    const duration = 500;
    const start = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      setDisplay(from + (to - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else prevRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);

    // The count is decoration; being right is not. A browser stops serving
    // animation frames to a hidden tab, which would strand the headline on the
    // old price while the line items beside it show the new one. This lands on
    // the real figure once the animation's time is up, whether or not a single
    // frame was ever drawn.
    clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => {
      cancelAnimationFrame(rafRef.current);
      prevRef.current = to;
      setDisplay(to);
    }, duration + 50);

    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(settleRef.current);
    };
  }, [value]);

  return <span className={className}>${formatPrice(display, decimals)}</span>;
}

