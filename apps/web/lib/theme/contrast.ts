/** WCAG 2 contrast over six-digit hex colours, for the palette test (test/palette.test.ts). */

function channels(hex: string): [number, number, number] {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!match) throw new Error(`Not a six-digit hex colour: ${hex}`);
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `colour` at `alpha` painted over `under`, as a browser composites `bg-x/20` or `ring-x/50`. */
export function over(colour: string, alpha: number, under: string): string {
  const top = channels(colour);
  const bottom = channels(under);
  return `#${top.map((v, i) => Math.round(v * alpha + bottom[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}
