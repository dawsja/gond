import localFont from "next/font/local";

// One family per font, one face per Google subset (CLAUDE.md, Web). The `font-family` declaration
// joins the faces; keep Google's order, since where ranges overlap the face defined last wins.

export const interCyrillicExt = localFont({
  src: "./fonts/inter-cyrillic-ext-wght.woff2",
  weight: "400 700",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "inter" },
    { prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
  ],
});
export const interCyrillic = localFont({
  src: "./fonts/inter-cyrillic-wght.woff2",
  weight: "400 700",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "inter" },
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  ],
});
export const interGreekExt = localFont({
  src: "./fonts/inter-greek-ext-wght.woff2",
  weight: "400 700",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "inter" },
    { prop: "unicode-range", value: "U+1F00-1FFF" },
  ],
});
export const interGreek = localFont({
  src: "./fonts/inter-greek-wght.woff2",
  weight: "400 700",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "inter" },
    { prop: "unicode-range", value: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF" },
  ],
});
export const interVietnamese = localFont({
  src: "./fonts/inter-vietnamese-wght.woff2",
  weight: "400 700",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "inter" },
    { prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  ],
});
export const interLatinExt = localFont({
  src: "./fonts/inter-latin-ext-wght.woff2",
  weight: "400 700",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "inter" },
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  ],
});
export const inter = localFont({
  src: "./fonts/inter-latin-wght.woff2",
  weight: "400 700",
  variable: "--font-inter",
  declarations: [
    { prop: "font-family", value: "inter" },
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});

export const jetbrainsCyrillicExt = localFont({
  src: "./fonts/jetbrains-mono-cyrillic-ext-wght.woff2",
  weight: "400 600",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "jetbrains" },
    { prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
  ],
});
export const jetbrainsCyrillic = localFont({
  src: "./fonts/jetbrains-mono-cyrillic-wght.woff2",
  weight: "400 600",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "jetbrains" },
    { prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  ],
});
export const jetbrainsGreek = localFont({
  src: "./fonts/jetbrains-mono-greek-wght.woff2",
  weight: "400 600",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "jetbrains" },
    { prop: "unicode-range", value: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF" },
  ],
});
export const jetbrainsVietnamese = localFont({
  src: "./fonts/jetbrains-mono-vietnamese-wght.woff2",
  weight: "400 600",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "jetbrains" },
    { prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  ],
});
export const jetbrainsLatinExt = localFont({
  src: "./fonts/jetbrains-mono-latin-ext-wght.woff2",
  weight: "400 600",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "jetbrains" },
    { prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  ],
});
export const jetbrains = localFont({
  src: "./fonts/jetbrains-mono-latin-wght.woff2",
  weight: "400 600",
  variable: "--font-jetbrains",
  declarations: [
    { prop: "font-family", value: "jetbrains" },
    { prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  ],
});
