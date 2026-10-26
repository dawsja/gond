// Seeds the throwaway Gond the iPhone screenshot job runs against (.github/workflows/ios-screens.yml):
// three bots and a conversation with a picture in it, for the account the job registered. Prints the
// conversation's id. Run from the repository root with the API's GOND_DATA_DIR.
import { deflateSync } from "node:zlib";
import { botInputSchema } from "../../../packages/shared/src/index.ts";
import { createBot } from "../../api/src/data/bots.ts";
import { updateSettings } from "../../api/src/data/settings.ts";
import { createRoom, postMessage, setReaction, storeAttachment } from "../../api/src/data/threads.ts";
import { ensureDatabase } from "../../api/src/db/init.ts";

const user = (ensureDatabase().query("SELECT id FROM user LIMIT 1").get() as { id: string } | null)?.id;
if (!user) throw new Error("Register the account first");

updateSettings({ onboarding: { done: true, templates: [] } });
const make = (name: string, title: string, color: string) => createBot(botInputSchema.parse({ name, title, color }), user);
const patch = make("Patch", "Systems Administrator", "#2F6FD6");
const net = make("Net", "Network Administrator", "#1F9E8F");
const sentry = make("Sentry", "Security Engineer", "#D2483C");

const say = (author: string, body: string, attachments = [] as ReturnType<typeof storeAttachment>[]) => postMessage({ threadId: patch.threadId, author, body, attachments, answered: true });
say("you", "Can you check if the backups ran last night?");
const answer = say(patch.id, "They did. All three finished by 2:14 AM, 41 GB in total. The photo library took longest at 26 minutes.");
say("you", "Nice. And the old ones?");
say(patch.id, "Anything older than 30 days is gone, so 112 GB is free on the NAS again.");
say("you", "Show me the backyard camera");
say(patch.id, "Here it is, a minute ago.", [storeAttachment({ name: "backyard.png", mediaType: "image/png", data: backyard() })]);
setReaction(answer, "you", "👍");

const room = createRoom("Homelab", [patch.id, net.id, sentry.id], user);
postMessage({ threadId: room.id, author: "you", body: "Morning all, anything I should know about?", answered: true });
postMessage({ threadId: room.id, author: sentry.id, body: "Two failed sign-ins on the NAS overnight, both blocked. Nothing else.", answered: true });

// The conversation, then the room, as the job reads them.
console.log(`${patch.threadId} ${room.id}`);

/** A 1200 by 800 picture of a sunny backyard, so Quick Look has something to show. */
function backyard(): Uint8Array {
  const width = 1200;
  const height = 800;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const sun = Math.max(0, 1 - Math.hypot(x - 820, y - 220) / 260);
      const sky = y < 430;
      const t = sky ? y / 430 : (y - 430) / 370;
      const base = sky ? [120 + 80 * t, 170 + 50 * t, 230 + 10 * t] : [110 - 50 * t, 150 - 60 * t, 80 - 40 * t];
      const pixel = base.map((value, i) => Math.min(255, value + sun * [255, 220, 150][i]! * 0.55));
      rows.set(pixel.map(Math.round), row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
