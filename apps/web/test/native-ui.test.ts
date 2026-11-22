import { describe, expect, test } from "bun:test";
import { filesFrom } from "../lib/native-ui";

describe("filesFrom", () => {
  test("decodes base64 payloads into File objects with names and types", async () => {
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
    const files = await filesFrom([
      { name: "Photo-20261122-001530.jpg", type: "image/jpeg", data: payload },
      { name: "notes.bin", type: "", data: Buffer.from("hello").toString("base64") },
    ]);

    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("Photo-20261122-001530.jpg");
    expect(files[0]!.type).toBe("image/jpeg");
    expect([...new Uint8Array(await files[0]!.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    expect(files[1]!.name).toBe("notes.bin");
    expect(files[1]!.type).toBe("application/octet-stream");
    expect(await files[1]!.text()).toBe("hello");
  });
});
