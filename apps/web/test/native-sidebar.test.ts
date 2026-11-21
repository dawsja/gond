import { describe, expect, test } from "bun:test";
import type { Bot } from "@gond/shared";
import type { ThreadRow } from "../components/store";
import { faceOf, settingsSectionOf, sidebarLists, sidebarSections } from "../lib/native-sidebar";
import { groupedSections } from "../lib/settings-sections";
import { isPhoneShell, isWebViewShell, nativeShell, shellBridge, type GondMac } from "../lib/shell";

const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id, title: `${id}'s job`, color: "#189c47", shape: "cog", expression: "smile", primary: false, pinned: false, hidden: false, ...extra }) as Bot;
const chat = (id: string, extra: Partial<ThreadRow> = {}) =>
  ({ id, kind: "bot", botId: id, name: id, members: [], pinned: false, lastMessage: { author: "you", body: "**hi**", at: "2026-11-20T09:00:00Z" }, unread: 0, unreadTeam: false, noticed: null, space: null, createdAt: "2026-11-01T00:00:00Z", ...extra }) as ThreadRow;

describe("the Mac app's sidebar", () => {
  const bots = [bot("ada", { pinned: true }), bot("bo"), bot("cy"), bot("dee")];
  const room = chat("room", { kind: "room", botId: null, name: "Launch", members: ["bo", "cy"], unread: 2 });
  const rows = [chat("ada", { unread: 3 }), chat("bo", { unread: 1 }), chat("cy"), chat("dee", { unreadTeam: true }), room];
  const lists = (extra: Partial<Parameters<typeof sidebarLists>[0]> = {}) =>
    sidebarLists({
      rows,
      query: "",
      bots,
      activity: { room: { cy: "Reading the brief" } },
      drafts: { cy: "  half a\n thought ", bo: "unseen" },
      pathname: "/app/t/bo",
      call: { threadId: "dee", connecting: false },
      ink: "#16181d",
      membersOf: (thread) => thread.members.map((id) => bots.find((b) => b.id === id)!),
      menuOf: () => [[{ id: "delete", label: "Delete bot", symbol: "trash", destructive: true }]],
      now: new Date("2026-11-20T12:00:00Z"),
      ...extra,
    });

  test("its rows say what the page's sidebar says", () => {
    const { pinned, rows: listed } = lists();
    expect(pinned.map((tile) => [tile.id, tile.title, tile.unread])).toEqual([["ada", "ada", "you"]]);
    const byId = Object.fromEntries(listed.map((row) => [row.id, row]));
    expect(Object.keys(byId)).toEqual(["bo", "cy", "dee", "room"]);
    // The open chat shows no dot and never its draft.
    expect(byId.bo).toMatchObject({ active: true, unread: null, previewKind: "text", preview: "You: hi", job: "bo's job" });
    expect(byId.cy).toMatchObject({ previewKind: "draft", preview: "half a thought" });
    expect(byId.dee).toMatchObject({ previewKind: "call", preview: "On a call", unread: "team" });
    expect(byId.room).toMatchObject({ previewKind: "working", preview: "cy: Reading the brief", working: true, job: "", unread: "you", color: "#16181d", title: "Launch" });
    expect(byId.bo!.time).not.toBe("");
  });

  test("while searching nothing is pinned, so every match is a row", () => {
    const { pinned, rows: listed } = lists({ query: "a", rows: [rows[0]!] });
    expect(pinned).toEqual([]);
    expect(listed.map((row) => row.id)).toEqual(["ada"]);
  });

  test("a face changes key only when what it draws does", () => {
    const ada = bots[0]!;
    const key = faceOf(chat("ada"), ada, [], "#16181d").key;
    expect(faceOf(chat("ada"), { ...ada, name: "Ada Lovelace", title: "Analyst" }, [], "#ffffff").key).toBe(key);
    expect(faceOf(chat("ada"), { ...ada, color: "#c2410c" }, [], "#16181d").key).not.toBe(key);
    const two = [bots[1]!, bots[2]!];
    const roomKey = faceOf(room, undefined, two, "#16181d").key;
    expect(faceOf(room, undefined, two, "#ffffff").key).toBe(roomKey);
    expect(faceOf(room, undefined, [...two, bots[3]!], "#16181d").key).not.toBe(roomKey);
    // A third bot adds the +1 chip, painted in the theme.
    expect(faceOf(room, undefined, [...two, bots[3]!], "#ffffff").key).not.toBe(faceOf(room, undefined, [...two, bots[3]!], "#16181d").key);
    expect(faceOf({ ...room, space: {} as ThreadRow["space"] }, undefined, two, "#16181d").key).not.toBe(roomKey);
    // Every face a row or tile names is one to paint.
    const { faces, rows: listed, pinned } = lists();
    expect(new Set(faces.map((face) => face.key))).toEqual(new Set([...pinned, ...listed].map((item) => item.face)));
  });

  test("Settings lists only what the person may open, the open one marked", () => {
    const sections = sidebarSections(groupedSections("user"), settingsSectionOf("/app/settings/appearance"));
    const ids = sections.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).not.toContain("shared-computer");
    expect(ids).toContain("about");
    expect(sections.at(-1)!.label).toBe("");
    expect(sections.flatMap((group) => group.items).filter((item) => item.active).map((item) => item.path)).toEqual(["/app/settings/appearance"]);
    expect(sidebarSections(groupedSections("admin"), null).flatMap((group) => group.items.map((item) => item.id))).toContain("shared-computer");
    expect(settingsSectionOf("/app/settings")).toBe("account");
    expect(settingsSectionOf("/app/t/settings")).toBeNull();
  });
});

test("the Mac app is a computer around a web view, never a phone", () => {
  const mac = { platform: () => "macos", changeServer: () => {} } as unknown as GondMac;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { gondMac: mac } });
  try {
    expect(nativeShell()).toBe("mac");
    expect(isPhoneShell(nativeShell())).toBe(false);
    expect(isWebViewShell()).toBe(true);
    expect(shellBridge()).toBe(mac);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
