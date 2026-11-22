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
