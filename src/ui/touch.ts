// Double-tap zoom on iOS, held down with both hands.
//
// `touch-action: manipulation` on every element is the standards answer and it
// is in the stylesheet. This is the second belt, because Safari's handling of
// that property for the double-tap gesture specifically has been unreliable
// across versions, and the symptom is not cosmetic: the page jumps to 200% in
// front of somebody who is standing at a running machine trying to type a
// position.
//
// The rule is narrow on purpose. A second touch is only cancelled when it lands
// close to the first in BOTH time and place — which is what Safari itself calls
// a double tap. Two quick taps on different controls are two taps and are left
// alone, so a fast operator pressing one button after another is not fighting
// this.
//
// What preventDefault costs here: the synthesised `click` for that second tap.
// Nothing in this app opens on the second click of a double — the readout works
// from pointer events precisely because Safari would not deliver a dblclick
// through a captured pointer — so there is nothing to lose. If a control is
// ever added that needs the second click of a rapid pair, it needs to say so.

/** Longest gap Safari still treats as a double tap, ms. */
const WINDOW_MS = 350;
/** How near the second tap has to land to count as the same spot, px. */
const SLOP = 30;

export function suppressDoubleTapZoom(): void {
  if (typeof document === 'undefined') return;

  let lastAt = 0;
  let lastX = 0;
  let lastY = 0;

  document.addEventListener(
    'touchend',
    (e: TouchEvent) => {
      // Only a single-finger tap. A two-finger gesture is a pinch, and pinching
      // is the zoom that stays.
      const touch = e.changedTouches.length === 1 ? e.changedTouches[0]! : null;
      if (!touch) return;

      const now = Date.now();
      const near =
        now - lastAt < WINDOW_MS &&
        Math.abs(touch.clientX - lastX) < SLOP &&
        Math.abs(touch.clientY - lastY) < SLOP;

      if (near && e.cancelable) {
        e.preventDefault();
        // Reset rather than carry the timestamp forward, so a third tap starts
        // a fresh pair instead of every tap in a rapid run being cancelled.
        lastAt = 0;
        return;
      }

      lastAt = now;
      lastX = touch.clientX;
      lastY = touch.clientY;
    },
    // Not passive: preventDefault is the entire purpose, and a passive listener
    // is not allowed to call it.
    { passive: false },
  );
}
