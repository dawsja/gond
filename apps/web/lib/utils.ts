import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A size in pixels as rem, so it grows with the phone apps' bigger root font as the CSS does (postcss-rem.mjs). */
export function rem(px: number): string {
  return `${px / 16}rem`;
}
