import { accessSync, constants, existsSync } from "node:fs";
import { hostname } from "node:os";
import { env } from "./config.ts";

export function dockerSocket(): string {
  return env("DOCKER_SOCK") || "/var/run/docker.sock";
}

export function dockerAvailability(): { available: boolean; reason: string | null } {
  const sock = dockerSocket();
  if (!existsSync(sock)) return { available: false, reason: `No Docker socket at ${sock}. Mount /var/run/docker.sock on the API to pull new box images.` };
  try {
    accessSync(sock, constants.R_OK | constants.W_OK);
  } catch {
    return { available: false, reason: `The API may not use ${sock}. Restart the API container: it joins the socket's group as it starts.` };
  }
  return { available: true, reason: null };
}

export class DockerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

type Init = RequestInit & { unix?: string };

async function request(method: string, route: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
  const init: Init = {
    method,
    unix: dockerSocket(),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  };
  let res: Response;
  try {
    res = await fetch(`http://docker${route}`, init);
  } catch (error) {
    throw new DockerError(`Docker didn't answer on ${dockerSocket()}: ${error instanceof Error ? error.message : "unknown error"}`, 0);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new DockerError(data.message ?? `Docker request failed (${res.status})`, res.status);
  }
  return res;
}

async function json<T>(method: string, route: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await request(method, route, body, timeoutMs);
  return (await res.json()) as T;
}

export type ContainerInfo = {
  Id: string;
  Name: string;
  Image: string;
  Config: { Image: string; Labels?: Record<string, string>; [key: string]: unknown };
  HostConfig: Record<string, unknown>;
  NetworkSettings: { Networks?: Record<string, Record<string, unknown>> };
  State: { Running: boolean; Status: string };
};

export function inspectContainer(idOrName: string): Promise<ContainerInfo> {
  return json<ContainerInfo>("GET", `/containers/${encodeURIComponent(idOrName)}/json`);
}

export async function findBoxContainer(): Promise<ContainerInfo> {
  const named = (env("BOX_CONTAINER") ?? "").trim();
  if (named) return inspectContainer(named);
  let project: string | null = null;
  try {
    const self = await inspectContainer(hostname());
    project = self.Config.Labels?.["com.docker.compose.project"] ?? null;
  } catch {
    /* not in a container we can see; fall back to any box service */
  }
  const filters = { label: ["com.docker.compose.service=box", ...(project ? [`com.docker.compose.project=${project}`] : [])] };
  const list = await json<{ Id: string }[]>("GET", `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify(filters))}`);
  if (list.length === 0) throw new DockerError("No box container found. Set GOND_BOX_CONTAINER to its name if it isn't the Compose `box` service.", 404);
  if (list.length > 1 && !project) throw new DockerError("Several box containers found; set GOND_BOX_CONTAINER to the one to update.", 409);
  return inspectContainer(list[0]!.Id);
}

export async function imageId(ref: string): Promise<string | null> {
  try {
    return (await json<{ Id: string }>("GET", `/images/${encodeURIComponent(ref)}/json`)).Id;
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return null;
    throw error;
  }
}

export function splitImageRef(ref: string): { image: string; tag: string } {
  const at = ref.indexOf("@");
  if (at !== -1) return { image: ref.slice(0, at), tag: ref.slice(at + 1) };
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) return { image: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { image: ref, tag: "latest" };
}

export async function pullImage(ref: string, onProgress: (line: string) => void): Promise<void> {
  const { image, tag } = splitImageRef(ref);
  const res = await request("POST", `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`, undefined, 30 * 60 * 1000);
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let last = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end = pending.indexOf("\n");
    while (end !== -1) {
      const raw = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
      if (!raw) continue;
      let event: { status?: string; id?: string; error?: string; errorDetail?: { message?: string } };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        continue;
      }
      if (event.error) throw new DockerError(event.errorDetail?.message ?? event.error, 502);
      const line = event.id && event.status ? `${event.status} ${event.id}` : (event.status ?? "");

      if (line && line !== last && !/Downloading|Extracting/.test(line)) {
        onProgress(line);
        last = line;
      }
    }
  }
}

export async function recreateContainer(info: ContainerInfo, image: string, onLog: (line: string) => void): Promise<string> {
  const name = info.Name.replace(/^\//, "");
  const newImageId = await imageId(image);
  const labels = { ...(info.Config.Labels ?? {}) };
  if (newImageId && labels["com.docker.compose.image"]) labels["com.docker.compose.image"] = newImageId;
  const endpoints: Record<string, unknown> = {};
  for (const [network, settings] of Object.entries(info.NetworkSettings.Networks ?? {})) {
    const { Aliases, IPAMConfig, Links, DriverOpts } = settings as { Aliases?: unknown; IPAMConfig?: unknown; Links?: unknown; DriverOpts?: unknown };

    const aliases = Array.isArray(Aliases) ? Aliases.filter((a) => typeof a === "string" && !info.Id.startsWith(a)) : undefined;
    endpoints[network] = { ...(aliases ? { Aliases: aliases } : {}), ...(IPAMConfig ? { IPAMConfig } : {}), ...(Links ? { Links } : {}), ...(DriverOpts ? { DriverOpts } : {}) };
  }
  const { Hostname: _hostname, ...config } = info.Config as { Hostname?: string; [key: string]: unknown };
  void _hostname;
  const body = { ...config, Image: image, Labels: labels, HostConfig: info.HostConfig, NetworkingConfig: { EndpointsConfig: endpoints } };

  onLog(`Stopping ${name}…`);
  if (info.State.Running) await request("POST", `/containers/${info.Id}/stop?t=30`, undefined, 90_000);
  onLog(`Removing the old container…`);
  await request("DELETE", `/containers/${info.Id}?v=false`, undefined, 60_000);
  onLog(`Creating ${name} from ${image}…`);
  const created = await json<{ Id: string; Warnings?: string[] }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, body);
  for (const warning of created.Warnings ?? []) onLog(`Docker: ${warning}`);
  onLog("Starting it…");
  await request("POST", `/containers/${created.Id}/start`, undefined, 60_000);
  return created.Id;
}
