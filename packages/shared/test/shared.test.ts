import { describe, expect, test } from "bun:test";
import { addressedIn, newerVersion, BOT_TEMPLATES, CURATED_TOOLKITS, draftIdOf, editedEmailInput, emailDraftOf, emailEditable, emailName, emailText, sendDraftAction, wordDiff, LEGACY_MOBILE_SIGN_IN_CALLBACK, MOBILE_SIGN_IN_CALLBACK, SIGN_IN_APPS, approvalLine, botInputSchema, composioCard, composioCardToolkit, fromNativeAction, gerund, handleOf, isClosing, isQuietReply, isQuietTool, isStopRequest, routineName, joinCommandLine, mentionsIn, pickBotName, pickVoiceProvider, plainMarkdown, roomAnswerer, roomTargets, ruleLabel, splitCommandLine, toolLabel, toolLine } from "../src/index.ts";

describe("shared", () => {
  test("pickBotName avoids taken names and numbers when exhausted", () => {
    expect(pickBotName(["scout"], () => 0)).not.toBe("Scout");
    const all = [...Array(200)].map((_, i) => `n${i}`);
    const name = pickBotName(all, () => 0);
    expect(name).toBeTruthy();
  });

  test("mentions are lowercased and unique", () => {
    expect(mentionsIn("@Scout and @scout, then @Pixel-2")).toEqual(["scout", "pixel-2"]);
    expect(mentionsIn("mail me at a@b.com")).toEqual([]);
  });

  test("handles drop spaces and punctuation", () => {
    expect(handleOf("Inbox Manager")).toBe("inboxmanager");
  });

  test("templates parse as bot input", () => {
    for (const t of BOT_TEMPLATES) {
      const parsed = botInputSchema.safeParse({ name: t.name, title: t.title, description: t.description, color: t.color, expression: t.expression, toolkits: t.toolkits });
      expect(parsed.success).toBe(true);
      expect("isChief" in t).toBe(false);
      for (const toolkit of t.toolkits) expect(CURATED_TOOLKITS.has(toolkit)).toBe(true);
    }
  });

  test("bot input defaults", () => {
    const bot = botInputSchema.parse({ name: "Pip" });
    expect(bot.approval).toBe("auto");
    expect(bot.toolkits).toEqual([]);
  });

  test("a command line splits like a shell and joins back", () => {
    expect(splitCommandLine("")).toEqual([]);
    expect(splitCommandLine("  uv  run -m  aseprite_mcp ")).toEqual(["uv", "run", "-m", "aseprite_mcp"]);
    expect(splitCommandLine(`uv --directory "/home/agent/My Tools/mcp" run`)).toEqual(["uv", "--directory", "/home/agent/My Tools/mcp", "run"]);
    expect(splitCommandLine(`echo 'a "b"' "c \\"d\\"" e\\ f ''`)).toEqual(["echo", 'a "b"', 'c "d"', "e f", ""]);
    for (const words of [["uv", "--directory", "/a b/c", "run"], ["say", "it's", 'a "quote"', "back\\slash", ""]]) {
      expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
    }
    expect(joinCommandLine(["uv", "run"])).toBe("uv run");
  });
});

describe("sign-in and cards", () => {
  test("the phone apps come back to the gond scheme, the older one to the legacy scheme", () => {
    expect(MOBILE_SIGN_IN_CALLBACK).toBe("gond://sign-in");
    expect(LEGACY_MOBILE_SIGN_IN_CALLBACK).toBe("krubot://sign-in");
    expect(SIGN_IN_APPS).toEqual(["android", "app", "desktop"]);
  });

  test("a connected app's card is named by its toolkit", () => {
    expect(composioCard("gmail")).toBe("composio:gmail");
    expect(composioCardToolkit("composio:gmail")).toBe("gmail");
    expect(composioCardToolkit("mcp-1")).toBeNull();
  });
});

describe("plain markdown", () => {
  test("a reply becomes one line of words for a notification", () => {
    const reply = "# Storage\n\n:badge[Healthy — plenty of free space]{tone=ok}\n\n::meter{value=6 label=\"Root filesystem (`/`)\" text=\"6% used\" left=\"6.1 GB\" tone=ok}\n\n**Inode usage:** 2%\n\n:::warning\nSee `df -h`.\n:::";
    expect(plainMarkdown(reply)).toBe("Storage Healthy — plenty of free space Root filesystem (/): 6% used Inode usage: 2% See df -h.");
  });
  test("a meter without words says its percentage, and a plain badge is its label", () => {
    expect(plainMarkdown("::meter{value=3 max=8 label=\"Seats\"}")).toBe("Seats: 38%");
    expect(plainMarkdown("::meter{value=40}")).toBe("40%");
    expect(plainMarkdown("Which one?\n::choices[Pickup | Delivery]")).toBe("Which one? Pickup or Delivery?");
    expect(plainMarkdown("Status :badge[Plain] today")).toBe("Status Plain today");
  });

  test("toolLabel puts a tool call in plain words, verb first", () => {
    expect(toolLabel("Bash", { command: "bun test\necho done" })).toEqual({ verb: "Running", detail: "`bun test`" });
    expect(toolLabel("Bash", { command: `echo ${"x".repeat(80)}` })?.detail).toBe(`\`echo ${"x".repeat(54)}…\``);
    expect(toolLabel("Read", { file_path: "/home/agent/.bots/b1/notes.md" }, { home: "/home/agent/.bots/b1" })).toEqual({ verb: "Reading", detail: "notes.md" });
    expect(toolLabel("NotebookRead", { notebook_path: "/x/a.ipynb" })).toEqual({ verb: "Reading", detail: "/x/a.ipynb" });
    expect(toolLabel("Write", { file_path: "site/index.html" })).toEqual({ verb: "Editing", detail: "site/index.html" });
    expect(toolLabel("MultiEdit", { file_path: "a.ts" })?.verb).toBe("Editing");
    expect(toolLabel("Grep", { pattern: "TODO" })).toEqual({ verb: "Searching files", detail: "for TODO" });
    expect(toolLabel("Glob", { pattern: "**/*.ts" })?.detail).toBe("for **/*.ts");
    expect(toolLabel("LS", { path: "/home/agent/site" }, { home: "/home/agent" })).toEqual({ verb: "Listing", detail: "site" });
    expect(toolLabel("WebFetch", { url: "https://docs.example.com/a/b?x=1" })).toEqual({ verb: "Opening", detail: "docs.example.com" });
    expect(toolLabel("WebSearch", { query: "gond bots" })).toEqual({ verb: "Searching the web", detail: "for “gond bots”" });
    expect(toolLabel("Task", { description: "Find the bug" })).toEqual({ verb: "Running a subtask", detail: "Find the bug" });
    expect(toolLabel("TodoWrite", { todos: [] })).toEqual({ verb: "Planning", detail: null });
    expect(toolLabel("mcp__gond__permission", {})).toBeNull();
    expect(toolLabel("mcp__kru__permission", {})).toBeNull();
    expect(toolLabel("mcp__gond__set_profile", { title: "x" })).toEqual({ verb: "Updating its profile", detail: null });
    expect(toolLabel("post_message", { text: "hi" })).toEqual({ verb: "Posting a message", detail: null });
    expect(toolLabel("send_file", { path: "~/.team/u1/report.pdf" })).toEqual({ verb: "Sending", detail: "report.pdf" });
    expect(toolLabel("list_bots", {})).toEqual({ verb: "Listing bots", detail: null });
    expect(toolLabel("message_bot", { bot: "Pip", text: "x" })).toEqual({ verb: "Messaging", detail: "Pip" });
    expect(toolLabel("delegate_bot", { bot: "Pip", brief: "x" })).toEqual({ verb: "Delegating to", detail: "Pip" });
    expect(toolLabel("ask_bot", { bot: "Pip", question: "x" })).toEqual({ verb: "Asking", detail: "Pip" });
    expect(toolLabel("create_bot", { name: "Nova" })).toEqual({ verb: "Creating a bot", detail: "Nova" });
    expect(toolLabel("update_bot", { bot: "Nova" })).toEqual({ verb: "Updating a bot", detail: "Nova" });
    expect(toolLabel("create_room", { name: "Launch" })).toEqual({ verb: "Creating a room", detail: "Launch" });
    expect(toolLabel("list_handoffs", {})?.verb).toBe("Listing handoffs");
    expect(toolLabel("cancel_handoff", { handoff: "h1" })?.verb).toBe("Cancelling a handoff");
    expect(toolLabel("amend_handoff", { handoff: "h1" })?.verb).toBe("Updating a handoff");
    expect(toolLabel("use_skill", { slug: "weekly-report" })).toEqual({ verb: "Using the weekly-report skill", detail: null });
    expect(toolLabel("save_skill", { name: "Weekly report" })).toEqual({ verb: "Saving a skill", detail: "Weekly report" });
    expect(toolLabel("update_skill", { slug: "weekly-report" })).toEqual({ verb: "Updating a skill", detail: "weekly-report" });
    expect(toolLabel("connect_app", { app: "gmail" })).toEqual({ verb: "Connecting", detail: "gmail" });
    expect(toolLabel("add_mcp_server", { name: "linear" })).toEqual({ verb: "Adding an MCP server", detail: "linear" });
    expect(toolLabel("list_routines", {})?.verb).toBe("Listing routines");
    expect(toolLabel("create_routine", { name: "Morning brief" })).toEqual({ verb: "Creating a routine", detail: "Morning brief" });
    expect(toolLabel("run_routine", { routine: "Morning brief" })).toEqual({ verb: "Running a routine", detail: "Morning brief" });
    expect(toolLabel("follow_up", {})?.verb).toBe("Setting a follow-up");
    expect(toolLabel("read_conversation", {})?.verb).toBe("Reading a conversation");
    expect(toolLabel("search_messages", { query: "invoice" })).toEqual({ verb: "Searching messages", detail: "for “invoice”" });
    expect(toolLabel("request_secret", { name: "STRIPE_API_KEY" })).toEqual({ verb: "Requesting a secret", detail: "STRIPE_API_KEY" });
    expect(toolLabel("set_composio_key", {})).toEqual({ verb: "Requesting a secret", detail: null });
    expect(toolLabel("list_secrets", {})?.verb).toBe("Listing secrets");
    expect(toolLabel("ask_approval", { summary: "x" })?.verb).toBe("Requesting approval");
    expect(toolLabel("whatever", { x: 1 })).toEqual({ verb: "Working", detail: null });
  });

  test("toolLabel reads a screen batch by the first action that does something", () => {
    expect(toolLabel("computer", { actions: [{ type: "screenshot" }] })).toEqual({ verb: "Taking a screenshot", detail: null });
    expect(toolLabel("computer", { actions: [{ type: "screenshot" }, { type: "click", x: 1, y: 2 }, { type: "type", text: "hi" }] })).toEqual({ verb: "Clicking", detail: null });
    expect(toolLabel("browser", { actions: [{ type: "type", text: "x".repeat(50) }] })?.detail).toBe(`"${"x".repeat(39)}…"`);
    expect(toolLabel("browser", { actions: [{ type: "type_login", name: "UBER_EATS_PASSWORD" }] })).toEqual({ verb: "Typing a sign-in", detail: null });
    expect(toolLabel("browser", { actions: [{ type: "fill", ref: "e4", text: "a@b.c" }, { type: "click", ref: "e7" }] })).toEqual({ verb: "Filling in a field", detail: null });
    expect(toolLabel("browser", { actions: [{ type: "select", ref: "e6", option: "Large" }] })).toEqual({ verb: "Choosing", detail: "“Large”" });
    expect(toolLabel("browser", { actions: [{ type: "read" }] })).toEqual({ verb: "Reading the page", detail: null });
    expect(toolLabel("browser", { actions: [{ type: "wait_for", text: "Order placed" }] })).toEqual({ verb: "Waiting for", detail: "“Order placed”" });
    expect(toolLabel("browser", { actions: [{ type: "new_tab", url: "https://www.ubereats.com/" }] })).toEqual({ verb: "Opening a tab", detail: "www.ubereats.com" });
    expect(toolLabel("browser", { actions: [{ type: "navigate", url: "https://www.ubereats.com/" }] })).toEqual({ verb: "Opening", detail: "www.ubereats.com" });
    expect(toolLabel("computer", { actions: [{ type: "key", key: "ctrl+s" }] })).toEqual({ verb: "Pressing", detail: "ctrl+s" });
    expect(toolLabel("computer", { actions: [{ type: "scroll", direction: "down" }] })).toEqual({ verb: "Scrolling", detail: "down" });
    expect(toolLabel("computer", { actions: [{ type: "wait", ms: 500 }] })?.verb).toBe("Waiting");
    expect(toolLabel("browser", {})).toEqual({ verb: "Using the browser", detail: null });
  });

  test("Anthropic's own computer action reads as the same step", () => {
    expect(fromNativeAction({ action: "double_click", coordinate: [3, 4] })).toEqual({ type: "click", x: 3, y: 4, button: "left", count: 2 });
    expect(fromNativeAction({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [5, 6] })).toEqual({ type: "drag", x: 1, y: 2, to_x: 5, to_y: 6 });
    expect(fromNativeAction({ action: "key", text: "Return" })).toEqual({ type: "key", key: "Return" });
    expect(fromNativeAction({ action: "scroll", coordinate: [1, 1], scroll_direction: "up", scroll_amount: 2 })).toEqual({ type: "scroll", x: 1, y: 1, direction: "up", amount: 2 });
    expect(fromNativeAction({ action: "wait", duration: 1.5 })).toEqual({ type: "wait", ms: 1500 });
    expect(fromNativeAction({ action: "type", text: "hi" })).toEqual({ type: "type", text: "hi" });
    expect(fromNativeAction({ action: "mouse_move", coordinate: [9, 9] })).toEqual({ type: "move", x: 9, y: 9 });
    expect(toolLabel("computer", { action: "left_click", coordinate: [1, 2] })).toEqual({ verb: "Clicking", detail: null });
    expect(toolLabel("browser", { actions: [{ type: "click", label: "Add to order" }] })).toEqual({ verb: "Clicking", detail: "“Add to order”" });
    expect(toolLabel("computer", { action: "cursor_position" })).toBeNull();
  });

  test("toolLabel names a connected app's action and an MCP server's tool", () => {
    expect(toolLabel("GMAIL_SEND_EMAIL", { to: "a@b.c" })).toEqual({ verb: "Gmail:", detail: "sending email" });
    expect(toolLabel("GOOGLECALENDAR_CREATE_EVENT", {})).toEqual({ verb: "Google Calendar:", detail: "creating event" });
    expect(toolLabel("SLACK_GET_CHANNEL_HISTORY", {})).toEqual({ verb: "Slack:", detail: "getting channel history" });
    expect(toolLabel("mcp__linear__create_issue", {}, { servers: [{ name: "Linear" }] })).toEqual({ verb: "Linear:", detail: "creating issue" });
    expect(toolLabel("mcp__linear__list_issues", {})).toEqual({ verb: "linear:", detail: "listing issues" });
    expect(toolLabel("mcp__notion__notion-search", {}, { servers: [{ name: "Notion" }] })).toEqual({ verb: "Notion:", detail: "searching" });
    expect(toolLabel("mcp__notion__notion-fetch", {})).toEqual({ verb: "notion:", detail: "fetching" });
    expect(approvalLine("mcp__notion__notion-create-pages", {}, { servers: [{ name: "Notion" }] })).toBe("Notion: create pages");
    expect(toolLine(toolLabel("GMAIL_SEND_EMAIL", {}))).toBe("Gmail: sending email");
    expect(toolLine(toolLabel("list_bots", {}))).toBe("Listing bots");
    expect(toolLine(null)).toBeNull();
    expect(gerund("run")).toBe("running");
    expect(gerund("reply")).toBe("replying");
    expect(gerund("delete")).toBe("deleting");
    expect(gerund("see")).toBe("seeing");
    expect(gerund("fetch")).toBe("fetching");
  });

  test("approvalLine is what the bot asks to do", () => {
    expect(approvalLine("Bash", { command: "rm -rf build" })).toBe("run `rm -rf build`");
    expect(approvalLine("Edit", { file_path: "/home/agent/site/a.html" }, { home: "/home/agent" })).toBe("change site/a.html");
    expect(approvalLine("Write", { file_path: "/a/b" })).toBe("write /a/b");
    expect(approvalLine("WebFetch", { url: "https://example.com/x" })).toBe("open example.com");
    expect(approvalLine("computer", { action: "left_click" })).toBe("use the computer");
    expect(approvalLine("ask_approval", { summary: "Send the invoice to Ada" })).toBe("Send the invoice to Ada");
    expect(approvalLine("GMAIL_SEND_EMAIL", {})).toBe("Gmail: send email");
    expect(approvalLine("mcp__linear__create_issue", {}, { servers: [{ name: "Linear" }] })).toBe("Linear: create issue");
    expect(approvalLine("mcp__gond__add_mcp_server", {})).toBe("use add_mcp_server");
  });

  test("ruleLabel says a saved rule in words", () => {
    expect(ruleLabel("Bash(git:*)")).toBe("git commands");
    expect(ruleLabel("Edit(site/**)")).toBe("changes under site/");
    expect(ruleLabel("Write(/home/agent/site/**)", { home: "/home/agent" })).toBe("changes under site/");
    expect(ruleLabel("Edit(./**)")).toBe("changes in its own folder");
    expect(ruleLabel("computer")).toBe("the computer");
    expect(ruleLabel("GMAIL_SEND_EMAIL")).toBe("Gmail: send email");
    expect(ruleLabel("mcp__linear__create_issue")).toBe("linear: create issue");
    expect(ruleLabel("SomethingElse")).toBe("SomethingElse");
  });

  test("isQuietTool is a memory write, by tool or by file", () => {
    expect(isQuietTool("memory_update", { content: "x" })).toBe(true);
    expect(isQuietTool("mcp__gond__team_memory_update", { content: "x" })).toBe(true);
    expect(isQuietTool("Edit", { file_path: "/home/agent/.bots/b1/MEMORY.md" })).toBe(true);
    expect(isQuietTool("Write", { file_path: "~/.team/u1/MEMORY.md" })).toBe(true);
    expect(isQuietTool("Read", { file_path: "/home/agent/.bots/b1/memory/people.md" })).toBe(true);
    expect(isQuietTool("Edit", { file_path: "/home/agent/site/memory/x.md" })).toBe(false);
    expect(isQuietTool("Edit", { file_path: "/home/agent/.bots/b1/notes.md" })).toBe(false);
    expect(isQuietTool("Bash", { command: "cat MEMORY.md" })).toBe(false);
    expect(toolLabel("Edit", { file_path: "/home/agent/.bots/b1/MEMORY.md" })).toBeNull();
  });
});

describe("quiet routine runs", () => {
  test("only the bare marker is quiet, however it's dressed", () => {
    for (const text of ["NOTHING_NEW", "nothing_new", " `NOTHING_NEW` ", "**NOTHING_NEW**.", "NOTHING_NEW\n"]) expect(isQuietReply(text)).toBe(true);
    expect(routineName("[Routine: Morning briefing] Use /brief. Brief me.")).toBe("Morning briefing");
    expect(routineName("Use /brief.")).toBeNull();
    for (const text of ["Nothing new today.", "NOTHING_NEW, but the build broke", "", "Here's the brief: NOTHING_NEW"]) expect(isQuietReply(text)).toBe(false);
  });
});

describe("stop requests", () => {
  test("a short stop, however it's said, is one", () => {
    for (const text of ["stop", "Stop.", "STOP!", "cancel that", "ok quit", "never mind", "nevermind", "nvm", "please stop", "wait, stop", "stop it now", "abort", "halt everything", "stop what you're doing", "cancel"]) expect(isStopRequest(text)).toBe(true);
  });
  test("anything with more to it goes to the bot", () => {
    for (const text of ["cancel the order", "stop using Chrome and use the API", "don't stop", "can you stop by the store", "quitting time soon?", "", "stopwatch"]) expect(isStopRequest(text)).toBe(false);
  });
});

describe("isClosing", () => {
  test("a thanks, an I will or a goodbye closes the exchange", () => {
    for (const text of ["Thank you!", "thanks", "ty", "I will!", "Will do", "perfect, thanks", "That will be all", "ok thanks!", "Goodnight", "👍", "❤️🙏", "got it, thank you"]) expect(isClosing(text)).toBe(true);
  });

  test("a question or a new ask is not one", () => {
    for (const text of ["thanks, can you also order fries?", "Thank you. Now book the table for 7 and send me the confirmation", "I will need the receipt", "yes", "done?", "", "what's next"]) expect(isClosing(text)).toBe(false);
  });
});

describe("pickVoiceProvider", () => {
  test("auto takes the cheapest key, a choice holds while its key does", () => {
    const has = (...kinds: string[]) => (kind: string) => kinds.includes(kind);
    expect(pickVoiceProvider("auto", has("openai", "xai"))).toBe("xai");
    expect(pickVoiceProvider("auto", has("openai"))).toBe("openai");
    expect(pickVoiceProvider("openai", has("openai", "xai"))).toBe("openai");
    expect(pickVoiceProvider("openai", has("xai"))).toBe("xai");
    expect(pickVoiceProvider("auto", has())).toBeNull();
  });

  test("an email card reads what a Gmail or Outlook action is about to send", () => {
    expect(emailDraftOf("GMAIL_SEND_EMAIL", { recipient_email: "dana@ruizdesign.co", extra_recipients: ["priya@ruizdesign.co"], cc: ["ops@ruizdesign.co"], bcc: ["me@gmail.com"], subject: "Launch plan", body: "Hi all,\n\nDates below.", attachment: "/home/agent/proofs-v4.pdf" })).toEqual({
      mode: "send",
      app: "Gmail",
      to: ["dana@ruizdesign.co", "priya@ruizdesign.co"],
      cc: ["ops@ruizdesign.co"],
      bcc: ["me@gmail.com"],
      subject: "Launch plan",
      body: "Hi all,\n\nDates below.",
      files: ["proofs-v4.pdf"],
    });
    const reply = emailDraftOf("GMAIL_REPLY_TO_THREAD", { thread_id: "t1", recipient_email: "marco@bellandco.com", message_body: "<p>Confirmed: $4,280.</p><p>Thanks,<br>Dawson</p>", is_html: true });
    expect(reply).toMatchObject({ mode: "reply", to: ["marco@bellandco.com"], subject: null, body: "Confirmed: $4,280.\n\nThanks,\nDawson" });
    expect(emailDraftOf("OUTLOOK_SEND_EMAIL", { to_email: "it@golem-labs.com", subject: "VPN", body: "Renew it?", cc_emails: "a@x.com; b@x.com" })).toMatchObject({ app: "Outlook", to: ["it@golem-labs.com"], cc: ["a@x.com", "b@x.com"] });
    expect(emailDraftOf("OUTLOOK_REPLY_EMAIL", { message_id: "m1", comment: "On it." })).toMatchObject({ mode: "reply", body: "On it." });
    expect(emailDraftOf("GMAIL_FORWARD_MESSAGE", { message_id: "m1", recipient_email: "leo@park.io", additional_text: "FYI" })).toMatchObject({ mode: "forward", body: "FYI" });
    expect(emailDraftOf("GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "a@b.co", subject: "Hi", body: "x" })?.mode).toBe("draft");
    expect(emailDraftOf("GMAIL_SEND_DRAFT", { draft_id: "d1" })).toBeNull();
    expect(emailDraftOf("GMAIL_DELETE_MESSAGE", { message_id: "m1" })).toBeNull();
    expect(emailDraftOf("SLACK_SEND_MESSAGE", { channel: "c", text: "hi" })).toBeNull();
    expect(emailDraftOf("OUTLOOK_SEND_EMAIL", { to_recipients: [{ emailAddress: { name: "Ann Lee", address: "ann@x.com" } }], subject: "s" })?.to).toEqual(["Ann Lee <ann@x.com>"]);
  });

  test("a draft reply is a draft, and only an app's own draft can be sent from its card", () => {
    expect(emailDraftOf("OUTLOOK_CREATE_DRAFT_REPLY", { message_id: "m1", comment: "On it." })?.mode).toBe("draft");
    expect(sendDraftAction("GMAIL_CREATE_EMAIL_DRAFT")).toEqual({ slug: "GMAIL_SEND_DRAFT", idKey: "draft_id" });
    expect(sendDraftAction("OUTLOOK_CREATE_DRAFT_REPLY")).toEqual({ slug: "OUTLOOK_SEND_DRAFT", idKey: "message_id" });
    expect(sendDraftAction("GMAIL_SEND_EMAIL")).toBeNull();
    expect(sendDraftAction("mcp__mail__GMAIL_CREATE_EMAIL_DRAFT")).toBeNull();
    expect(emailEditable("OUTLOOK_SEND_EMAIL")).toBe(true);
    expect(emailEditable("mcp__mail__GMAIL_SEND_EMAIL")).toBe(false);
    expect(emailEditable("SLACK_SEND_MESSAGE")).toBe(false);
  });

  test("a saved draft's id is read from what the app answered", () => {
    expect(draftIdOf({ id: "r-77", message: { id: "m1", threadId: "t1" } })).toBe("r-77");
    expect(draftIdOf({ response_data: { id: "r-9" } })).toBe("r-9");
    expect(draftIdOf({ data: JSON.stringify({ draft_id: "d-1" }) })).toBe("d-1");
    expect(draftIdOf({ ok: true })).toBeNull();
  });

  test("an edit goes back into the keys the letter came from, and nothing it didn't change moves", () => {
    const gmail = { recipient_email: "dana@ruizdesign.co", cc: ["ops@x.co"], subject: "VM", body: "<p>Hi Dana,</p>", is_html: true, thread_id: "t1" };
    const shown = emailDraftOf("GMAIL_CREATE_EMAIL_DRAFT", gmail)!;
    const unchanged = editedEmailInput("GMAIL_CREATE_EMAIL_DRAFT", gmail, { to: shown.to, cc: shown.cc, bcc: [], subject: shown.subject!, body: shown.body! });
    expect(unchanged).toEqual(gmail);
    const edited = editedEmailInput("GMAIL_CREATE_EMAIL_DRAFT", gmail, { to: ["Dana Ruiz <dana@ruizdesign.co>", "leo@park.io"], cc: shown.cc, bcc: [], subject: "VM ready", body: "Hey Dana,\nIt's <up>." });
    expect(edited).toEqual({ ...gmail, recipient_email: "dana@ruizdesign.co", extra_recipients: ["leo@park.io"], subject: "VM ready", body: "Hey Dana,<br>It's &lt;up&gt;." });
    const outlook = { to_recipients: [{ emailAddress: { address: "ann@x.com" } }], subject: "s", body: "b" };
    expect(editedEmailInput("OUTLOOK_CREATE_DRAFT", outlook, { to: ["bo@x.com"], cc: ["cy@x.com"], bcc: [], subject: "s", body: "b" })).toEqual({ ...outlook, to_recipients: [{ emailAddress: { address: "bo@x.com" } }], cc_recipients: ["cy@x.com"] });
    expect(editedEmailInput("OUTLOOK_SEND_EMAIL", { to: "a@x.com, b@x.com", subject: "s", body: "b" }, { to: ["a@x.com"], cc: [], bcc: [], subject: "s", body: "b" }).to).toBe("a@x.com");
  });

  test("a redraft marks the words it added and took out", () => {
    expect(wordDiff("Hi Dana, you can deploy from Monday.", "Hey Dana! you can deploy today.")).toEqual([
      { text: "Hi Dana, ", change: "removed" },
      { text: "Hey Dana! ", change: "added" },
      { text: "you can deploy ", change: "same" },
      { text: "from Monday.", change: "removed" },
      { text: "today.", change: "added" },
    ]);
    expect(wordDiff("Hi Dana,\n\nDeploy from Monday.\n\nThanks", "Hey Dana!\n\nDeploy today.\n\nThanks")).toEqual([
      { text: "Hi Dana,", change: "removed" },
      { text: "Hey Dana!", change: "added" },
      { text: "\n\nDeploy ", change: "same" },
      { text: "from Monday.", change: "removed" },
      { text: "today.", change: "added" },
      { text: "\n\nThanks", change: "same" },
    ]);
    expect(wordDiff("same", "same")).toEqual([{ text: "same", change: "same" }]);
  });

  test("a release is newer only by its numbers", () => {
    expect(newerVersion("0.2.47", "0.2.46")).toBe(true);
    expect(newerVersion("v0.10.0", "0.9.9")).toBe(true);
    expect(newerVersion("0.2.46", "0.2.46")).toBe(false);
    expect(newerVersion("0.2.47", "dev")).toBe(false);
    expect(newerVersion("1.0.0-rc1", "0.9.0")).toBe(false);
  });

  test("an email body is words, never markup", () => {
    expect(emailText("<script>alert(1)</script><b>Hi</b> &amp; bye<ul><li>one</li><li>two</li></ul>")).toBe("Hi & bye• one\n• two");
    expect(emailText("Plain <3 text")).toBe("Plain <3 text");
    expect(emailName("Dana Ruiz <dana@ruizdesign.co>")).toBe("Dana Ruiz");
    expect(emailName('"Ruiz, Dana" <dana@ruizdesign.co>')).toBe("Ruiz, Dana");
    expect(emailName("dana@ruizdesign.co")).toBe("dana@ruizdesign.co");
  });
});

describe("rooms", () => {
  const net = { id: "net", name: "Net", primary: false };
  const patch = { id: "patch", name: "Patch", primary: false };
  const members = [net, patch];
  const line = (author: string, body: string, kind = "message") => ({ author, kind, body });
  const ids = (list: { id: string }[]) => list.map((b) => b.id);

  test("the primary answers a room it is in, else the first bot", () => {
    expect(roomAnswerer(members)).toBe(net);
    expect(roomAnswerer([net, { ...patch, primary: true }])?.id).toBe("patch");
    expect(roomAnswerer([])).toBeNull();
  });

  test("a person names a bot with @, by its name in any case (voice types no @), or the room as a whole", () => {
    expect(ids(addressedIn("@patch how's it going", members))).toEqual(["patch"]);
    expect(ids(addressedIn("Patch, are you still working?", members))).toEqual(["patch"]);
    expect(ids(addressedIn("Net and Patch, check", members))).toEqual(["net", "patch"]);
    expect(ids(addressedIn("patch how are the servers", members))).toEqual(["patch"]);
    expect(ids(addressedIn("hey net, is the wifi ok", members))).toEqual(["net"]);
    expect(ids(addressedIn("dispatcher is down", members))).toEqual([]);
    expect(ids(addressedIn("can you both check?", members))).toEqual(["net", "patch"]);
    expect(ids(addressedIn("everyone, status please", members))).toEqual(["net", "patch"]);
    expect(ids(addressedIn("check both servers", [net, patch, { id: "doug", name: "Doug", primary: false }]))).toEqual([]);
  });

  test("an unaddressed line goes to whoever the person was talking with", () => {
    expect(ids(roomTargets("How are things on the IT side?", members, []))).toEqual(["net"]);
    const afterPatch = [line("you", "@patch are you still working?"), line("patch", "I'm idle. ::choices[Run a read-only sweep | Nothing now]")];
    expect(ids(roomTargets("Run a read-only sweep", members, afterPatch))).toEqual(["patch"]);
    const bothAnswered = [line("you", "status, both of you"), line("net", "Fine."), line("patch", "Fine too.")];
    expect(ids(roomTargets("ok, thanks", members, bothAnswered))).toEqual(["net", "patch"]);
    expect(ids(roomTargets("and the backups?", members, [line("you", "@patch check the nodes")]))).toEqual(["patch"]);
    expect(ids(roomTargets("@net you check too", members, afterPatch))).toEqual(["net"]);
    expect(ids(roomTargets("thanks", members, [...afterPatch, line("system", "Patch left.", "event")]))).toEqual(["patch"]);
  });
});
