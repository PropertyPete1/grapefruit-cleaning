/**
 * One way to render a dollar figure, so the headline estimate and the line
 * items under it can never disagree.
 *
 * The estimate panel used to show a rounded headline over an exact line item —
 * "$113" above "$112.99" — which reads like a mistake even though both came
 * from the same number.
 */

/** Cents to show for a figure: none when it is whole, two otherwise. */
export function priceDecimals(value: number): 0 | 2 {
  return Math.round(value * 100) % 100 === 0 ? 0 : 2;
}

/**
 * Formats a price without the currency symbol: "112.99", "80", "1,234.50".
 *
 * Whole amounts stay whole rather than gaining a needless ".00", and anything
 * with cents keeps both digits. Pass `decimals` to hold the precision steady
 * while a figure is animating between two values.
 */
export function formatPrice(value: number, decimals: 0 | 2 = priceDecimals(value)): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
