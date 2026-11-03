import { describe, expect, test } from "bun:test";
import type { ShoppingProduct } from "@gond/shared";
import { largerPhoto, photosInPage, privateAddress, withPhotos, type Loads } from "../src/product-photos.ts";

const product = (id: string, images: string[], url = `https://shop.example.com/${id}`): ShoppingProduct => ({
  id, title: id, images, badges: [],
  variants: [{ id: "v", options: {}, offers: [{ id: "o", store: "Shop", url, price: { amount: 100, currency: "USD" }, availability: "unknown", observedAt: new Date().toISOString() }] }],
});

describe("product photos", () => {
  test("a store page's photos: Amazon's hi-res first, then JSON-LD and og:image, never an SVG or a private host", () => {
    const html = `<meta property="og:image" content="https://cdn.example.com/og.jpg">
      <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/61abc._AC_SL1500_.jpg" src="https://m.media-amazon.com/images/I/61abc._AC_SX355_.jpg">
      <script type="application/ld+json">{"@graph":[{"@type":"Product","image":["/p/1.jpg",{"url":"https://cdn.example.com/2.jpg"}]}]}</script>
      <meta name="twitter:image" content="https://cdn.example.com/logo.svg"><meta property="og:image:url" content="https://localhost/x.jpg">`;
    expect(photosInPage(html, "https://shop.example.com/item")).toEqual([
      "https://m.media-amazon.com/images/I/61abc._AC_SL1500_.jpg",
      "https://m.media-amazon.com/images/I/61abc._AC_SX355_.jpg",
      "https://shop.example.com/p/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/og.jpg",
    ]);
  });

  test("a guessed photo is dropped for the store page's, a slow one is kept, and a page without any leaves the card bare", async () => {
    const loads: Record<string, Loads> = { "https://img.example.com/real.jpg": "yes", "https://img.example.com/slow.jpg": "unknown" };
    const pages: Record<string, string> = { "https://shop.example.com/guessed": `<meta property="og:image" content="https://img.example.com/real.jpg">` };
    const { products, missing } = await withPhotos(
      [product("guessed", ["https://img.example.com/made-up.jpg"]), product("slow", ["https://img.example.com/slow.jpg"]), product("bare", ["https://img.example.com/made-up.jpg"])],
      { loads: async (url) => loads[url] ?? "no", page: async (url) => pages[url] ?? null },
    );
    expect(products.map((p) => p.images)).toEqual([["https://img.example.com/real.jpg"], ["https://img.example.com/slow.jpg"], []]);
    expect(missing).toEqual(["bare"]);
  });

  test("an Amazon thumbnail becomes its large photo; other addresses stay as given", () => {
    expect(largerPhoto("https://m.media-amazon.com/images/I/81+HcYgDo1L._AC_SY300_SX300_QL70_FMwebp_.jpg")).toBe("https://m.media-amazon.com/images/I/81+HcYgDo1L._AC_SL1500_.jpg");
    expect(largerPhoto("https://cdn.example.com/a._SX300_.jpg")).toBe("https://cdn.example.com/a._SX300_.jpg");
  });

  test("private, loopback and link-local addresses never count as public", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.5", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(privateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "2606:4700::6810:84e5"]) expect(privateAddress(ip)).toBe(false);
  });
});
