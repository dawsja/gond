import { fileURLToPath } from "node:url";

const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    // Next takes plugins only by name; a relative one isn't found from where it evaluates this.
    [fileURLToPath(new URL("./postcss-rem.mjs", import.meta.url))]: {},
  },
};

export default config;
