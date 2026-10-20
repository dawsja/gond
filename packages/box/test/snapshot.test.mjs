import assert from "node:assert/strict";
import test from "node:test";
import { compactSnapshot, MAX_LINES } from "../snapshot.mjs";

const view = { width: 1280, height: 800 };

test("the element list keeps the controls and headings on screen, with refs and their middles", () => {
  const snapshot = [
    '- generic [active] [ref=e1] [box=0,0,1280,4000]:',
    '  - heading "Whataburger" [level=1] [ref=e2] [box=40,20,400,40]',
    '  - link "Skip to content" [ref=e3] [cursor=pointer] [box=0,0,1,1]:',
    '    - /url: "#main"',
    '  - textbox "Search Uber Eats" [ref=e4] [box=300,80,400,40]: whataburger',
    '  - combobox "Quantity" [ref=e5] [box=800,80,100,40]:',
    '    - option "1" [selected]',
    '  - checkbox "Add cheese" [checked] [ref=e6] [box=40,200,20,20]',
     String.raw`  - button "Add 1 to order \"#1 Whataburger\"" [ref=e7] [cursor=pointer] [box=1000,700,200,48]`,
    '  - link "Whataburger Patty Melt" [ref=e8] [cursor=pointer] [box=40,300,300,200]:',
    '    - /url: /store/whataburger/item/patty-melt',
    '  - paragraph [ref=e9] [box=40,520,300,40]: Just text, not a control',
    '  - button "Up top" [ref=e10] [box=40,-400,100,40]',
    '  - button "Footer" [ref=e11] [box=40,3600,100,40]',
    '  - button "Off to the side" [ref=e12] [box=1400,100,100,40]',
  ].join("\n");
  const list = compactSnapshot(snapshot, view);
  assert.equal(
    list.text,
    [
      'e2 heading "Whataburger" (level=1) @240,40',
      'e4 textbox "Search Uber Eats" = "whataburger" @500,100',
      'e5 combobox "Quantity" @850,100',
      'e6 checkbox "Add cheese" (checked) @50,210',
      String.raw`e7 button "Add 1 to order \"#1 Whataburger\"" @1100,724`,
      'e8 link "Whataburger Patty Melt" -> /store/whataburger/item/patty-melt @190,400',
    ].join("\n"),
  );
  assert.equal(list.above, 1);
  assert.equal(list.below, 1);
  assert.equal(list.note, "1 more above, 1 more below; scroll to reach them.");
});

test("a huge page is cut to a size a model can take every time, and says how much is left", () => {
  const lines = Array.from({ length: MAX_LINES + 40 }, (_, i) => `- link "Item ${i}" [ref=e${i}] [box=0,${i},100,10]`);
  const list = compactSnapshot(lines.join("\n"), { width: 1280, height: 100_000 });
  assert.equal(list.count, MAX_LINES);
  assert.equal(list.below, 40);
  assert.equal(compactSnapshot("", view).text, "");
});

test("a checkbox drawn by the site stands in for its row, which is what takes the click", () => {
  const snapshot = [
    '- dialog "#1 Whatameal" [ref=e1] [box=340,40,600,700]:',
    '  - generic [ref=e17] [cursor=pointer] [box=357,381,568,57]:',
    '    - checkbox "Tomato" [checked] [box=357,409,0,0]',
    '    - generic [ref=e19] [box=393,400,52,18]: Tomato',
    '  - generic [ref=e20] [cursor=pointer] [box=357,438,568,57]:',
    '    - radio "Medium" [box=357,466,0,0]',
    '  - generic [ref=e30] [box=357,500,568,200]:',
    '    - checkbox "Mustard" [box=357,510,0,0]',
    '    - checkbox "Ketchup" [box=357,560,0,0]',
  ].join("\n");
  assert.equal(compactSnapshot(snapshot, view).text, ['e17 checkbox "Tomato" (checked) @641,410', 'e20 radio "Medium" @641,467'].join("\n"));
});

test("a control scrolled out of sight inside a panel is counted, not offered where something else would take the click", () => {
  const snapshot = ['- button "Add 1 to order" [ref=e1] [box=340,680,600,48]', '- checkbox "Mustard" [ref=e2] [box=357,690,20,20]'].join("\n");
  const list = compactSnapshot(snapshot, view, new Set(["e2"]));
  assert.equal(list.text, 'e1 button "Add 1 to order" @640,704');
  assert.equal(list.inside, 1);
  assert.equal(list.note, "1 more scrolled out of sight inside a panel; scroll the panel, or name them by label.");
});
