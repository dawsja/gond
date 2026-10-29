// Builds every pixel size as rem (16px to 1rem), so the phone apps' bigger root font (PHONE_SCALE in
// lib/theme/theme.ts) grows the whole design while everywhere else looks the same. Under 2px stays,
// so hairlines stay crisp, and so does Tailwind's endless radius (3.40282e38px); @media and @container
// conditions aren't declarations, so they keep measuring the screen.
const SIZES = /"[^"]*"|'[^']*'|url\([^)]*\)|(?<![\w.-])(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px\b/gi;

export function toRem(value) {
  if (!value.includes("px")) return value;
  return value.replace(SIZES, (match, number) => {
    if (number === undefined) return match;
    const px = Math.abs(Number(number));
    return px < 2 || px > 1e6 ? match : `${Number((Number(number) / 16).toFixed(5))}rem`;
  });
}

const plugin = () => ({
  postcssPlugin: "gond-rem",
  Declaration(declaration) {
    declaration.value = toRem(declaration.value);
  },
});
plugin.postcss = true;

export default plugin;
