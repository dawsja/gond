// Run by `replaceSelf` in a helper container from the new API image: replaces the old API container
// with one on the new image, then the helper removes itself.
import { inspectContainer, recreateContainer } from "./docker.ts";

const id = process.argv[2];
if (!id) throw new Error("Which container to replace?");
// The old API is still answering the request that started this.
await Bun.sleep(2_000);
const info = await inspectContainer(id);
await recreateContainer(info, info.Config.Image, (line) => console.info(`[gond-update] ${line}`));
console.info("[gond-update] The API is on the new image.");
