import {
  fromB64,
  randomB64,
  signedPush,
  signedUsage,
  toB64,
  type PushPlatform,
  type PushRequest,
  type UsageReport,
} from "./protocol.ts";

export type Identity = { key: string; secret: string };

export async function createIdentity(): Promise<Identity> {
  const signing = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  return {
    key: toB64(await crypto.subtle.exportKey("raw", signing.publicKey)),
    secret: toB64(await crypto.subtle.exportKey("pkcs8", signing.privateKey)),
  };
}

async function sign(identity: Identity, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", fromB64(identity.secret), { name: "Ed25519" }, false, ["sign"]);
  return toB64(await crypto.subtle.sign({ name: "Ed25519" }, key, message as Uint8Array<ArrayBuffer>));
}

export async function usageReport(identity: Identity, input: { epoch: string; tokens: number; at?: number }): Promise<UsageReport> {
  const unsigned: Omit<UsageReport, "sig"> = { v: 1, from: identity.key, at: input.at ?? Date.now(), epoch: input.epoch, tokens: Math.max(0, Math.floor(input.tokens)) };
  return { ...unsigned, sig: await sign(identity, signedUsage(unsigned)) };
}

export async function pushRequest(identity: Identity, input: { token: string; data: string; collapse: string | null; platform?: PushPlatform; quiet?: boolean; at?: number }): Promise<PushRequest> {
  const unsigned: Omit<PushRequest, "sig"> = {
    v: 1,
    from: identity.key,
    at: input.at ?? Date.now(),
    id: randomB64(12),
    platform: input.platform ?? "android",
    token: input.token,
    data: input.data,
    collapse: input.collapse,
    ...(input.quiet ? { quiet: true as const } : {}),
  };
  return { ...unsigned, sig: await sign(identity, signedPush(unsigned)) };
}
