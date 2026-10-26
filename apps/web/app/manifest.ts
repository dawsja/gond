import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Gond",
    short_name: "Gond",
    description: "Your team of always-on AI bots, each with its own computer.",
    start_url: "/app",
    display: "standalone",
    background_color: "#f5f3ee",
    theme_color: "#f5f3ee",
    icons: [
      { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/logo-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
