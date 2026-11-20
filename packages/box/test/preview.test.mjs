import assert from "node:assert/strict";
import test from "node:test";
import { PREVIEW_EDGE, previewArgv } from "../preview.mjs";

test("a preview reads the picture as the kind it was sent as, and shrinks only what is too big", () => {
  assert.deepEqual(previewArgv("/home/a/.bots/b/inbox/x.jpg", "image/jpeg", "/home/a/.run/preview/1.jpg"), [
    "convert",
    "jpeg:/home/a/.bots/b/inbox/x.jpg[0]",
    "-auto-orient",
    "-strip",
    "-resize",
    `${PREVIEW_EDGE}x${PREVIEW_EDGE}>`,
    "-quality",
    "85",
    "jpeg:/home/a/.run/preview/1.jpg",
  ]);
  assert.equal(previewArgv("/x.png", "image/png", "/o.jpg")[1], "png:/x.png[0]");
  assert.equal(previewArgv("/x.svg", "image/svg+xml", "/o.jpg"), null);
  assert.equal(previewArgv("/x.pdf", "application/pdf", "/o.jpg"), null);
  assert.equal(previewArgv("/x", undefined, "/o.jpg"), null);
});
