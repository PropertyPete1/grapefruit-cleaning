/**
 * Keeps a modal inside the part of the screen the viewer can actually see.
 *
 * A centred `position: fixed` dialog is laid out against the layout viewport,
 * and on a phone that is not what's visible. iOS Safari's toolbars come and go,
 * and the on-screen keyboard (iOS, and Android Chrome since 108) shrinks only
 * the *visual* viewport. `vh` ignores the toolbars and both `vh` and `dvh`
 * ignore the keyboard, so a dialog sized with either can park its submit
 * button under the keys with nothing left to scroll.
 *
 * The visual viewport API reports the box that is really on screen. The dialog
 * primitives feed it into two CSS variables their classes are written against —
 * a height to cap at and a centre line to sit on — and fall back to `100dvh` and
 * `50%` wherever the API is missing.
 */
import { useLayoutEffect } from "react";

export const DIALOG_VIEWPORT_HEIGHT_VAR = "--dialog-viewport-height";
export const DIALOG_VIEWPORT_CENTER_VAR = "--dialog-viewport-center";

export type VisibleViewport = { height: number; offsetTop: number };

/**
 * The CSS variables for a visible box, or null when the numbers can't be
 * trusted (a zero-height viewport mid-rotation, say) — the class fallbacks are
 * a better guess than a dialog capped at nothing.
 */
export function dialogViewportVars(viewport: VisibleViewport): Record<string, string> | null {
  const { height, offsetTop } = viewport;
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(offsetTop)) return null;
  // Rubber-band overscroll can report a momentarily negative offset.
  const top = Math.max(0, offsetTop);
  return {
    [DIALOG_VIEWPORT_HEIGHT_VAR]: `${Math.round(height)}px`,
    [DIALOG_VIEWPORT_CENTER_VAR]: `${Math.round(top + height / 2)}px`,
  };
}

function isTextEntry(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT")
  );
}

/**
 * Tracks the visual viewport onto `node` for as long as it is mounted.
 *
 * A resize is the keyboard (or a toolbar) arriving, so the focused field is
 * brought back into view inside the now-shorter dialog. A scroll is iOS panning
 * the visual viewport, which only moves the centre line.
 */
export function useVisibleViewportFit(node: HTMLElement | null): void {
  useLayoutEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!node || !viewport) return;

    const clear = () => {
      node.style.removeProperty(DIALOG_VIEWPORT_HEIGHT_VAR);
      node.style.removeProperty(DIALOG_VIEWPORT_CENTER_VAR);
    };
    const apply = (revealFocus: boolean) => {
      const vars = dialogViewportVars(viewport);
      if (!vars) return clear();
      for (const [name, value] of Object.entries(vars)) node.style.setProperty(name, value);
      const active = document.activeElement;
      if (revealFocus && isTextEntry(active) && node.contains(active)) {
        active.scrollIntoView({ block: "nearest" });
      }
    };

    let frame = 0;
    let reveal = false;
    const schedule = (revealFocus: boolean) => {
      reveal ||= revealFocus;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const revealNow = reveal;
        reveal = false;
        apply(revealNow);
      });
    };
    const onResize = () => schedule(true);
    const onScroll = () => schedule(false);

    // Synchronously, before first paint: the dialog must open already fitted.
    apply(false);
    viewport.addEventListener("resize", onResize);
    viewport.addEventListener("scroll", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", onResize);
      viewport.removeEventListener("scroll", onScroll);
      clear();
    };
  }, [node]);
}
