import { spawnSync } from "node:child_process";

const result = spawnSync("cargo", process.argv.slice(2), { stdio: "inherit", cwd: new URL("..", import.meta.url) });
if (result.error?.code === "ENOENT") {
  if (process.env.GOND_REQUIRE_CARGO === "1") {
    console.error("desktop: cargo not found");
    process.exit(1);
  }
  console.log("desktop: cargo not found, skipped");
  process.exit(0);
}
if (result.error) {
  console.error(`desktop: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
