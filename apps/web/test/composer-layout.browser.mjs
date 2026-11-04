import assert from "node:assert/strict";

// The caller supplies a Playwright page open to a seeded conversation, with no call or native chrome.
export async function checkComposerLayout(page) {
  const field = page.locator("textarea[data-slot=input-group-control]");
  const original = await field.inputValue();
  const sample = async (state) => {
    await page.waitForTimeout(250);
    const samples = await field.evaluate(async (node) => {
      const rows = [];
      for (let i = 0; i <= 60; i++) {
        const pill = node.closest("[data-slot=input-group]");
        const host = node.closest('[style*="--composer-h"]');
        rows.push({
          pill: pill.offsetHeight,
          field: node.offsetHeight,
          align: pill.querySelector("[data-slot=input-group-addon]").dataset.align,
          composer: getComputedStyle(host).getPropertyValue("--composer-h").trim(),
        });
        if (i < 60) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return rows;
    });
    assert.equal(new Set(samples.map((row) => JSON.stringify(row))).size, 1, `${state}: idle layout changed`);
    console.log(JSON.stringify({ state, samples: samples.length, ...samples[0] }));
    return samples[0];
  };

  try {
    await field.fill("");
    const empty = await sample("fresh empty");
    assert.equal(empty.align, "inline-end");
    await field.fill("wrap this message ".repeat(12));
    assert.equal((await sample("wrapped")).align, "block-end");
    await field.fill("Hi");
    const shortened = await sample("shortened but held");
    assert.equal(shortened.align, "block-end");
    assert.equal(shortened.field, empty.field);
    await field.fill("");
    assert.deepEqual(await sample("cleared without a textarea height change"), empty);
    // An empty render alone is not enough: the next draft must not inherit the old latch either.
    await field.fill("Hi");
    assert.deepEqual(await sample("next short draft"), empty);
  } finally {
    await field.fill(original);
  }
}
