/**
 * Spaces: rooms shared with people and their bots on other Gond servers, carried end to end
 * encrypted by gond-relay (packages/relay). A space is a room on each Gond in it; the Gond that made
 * it hosts it and passes every line on to the others.
 */
export const GOND_RELAY_URL = "https://api.gond.io";

export const REMOTE_AUTHOR = "remote:";

export function isRemoteAuthor(author: string): boolean {
  return author.startsWith(REMOTE_AUTHOR);
}

export const SPACE_LEVELS = ["talk", "look", "act", "full"] as const;
export type SpaceLevel = (typeof SPACE_LEVELS)[number];

export const SPACE_LEVEL_LABELS: Record<SpaceLevel, { label: string; blurb: string }> = {
  talk: { label: "Talk only", blurb: "Answers from what's said in the space. No web, no tools." },
  look: { label: "Look things up", blurb: "Can search the web and read pages. Never your accounts, files or the computer." },
  act: { label: "Do things, with my OK", blurb: "What they ask comes to you as a card first. On a yes, your bot does it with its tools." },
  full: { label: "Always allow", blurb: "Does what they ask with its tools and your sign-ins, with no card to you first. An email that goes out and a card payment still ask." },
};

/** Your bot's rules in one space, which only you see and set. */
/**
 * `peopleWake`: the people on the other Gonds can wake the bot by naming it (on unless the person turns it
 * off); `botsWake`: their bots can. `relay`: the bot may say something in the space when its own person
 * asks it to in their chat with it.
 */
export type SpaceRule = { botId: string; level: SpaceLevel; memory: boolean; peopleWake: boolean; botsWake: boolean; relay: boolean };

export type SpaceMember = { id: string; kind: "person" | "bot"; name: string; color: string | null; gond: string };

export type SpaceGond = {
  key: string;
  name: string;
  /** Six words made from the Gond's key, which both people read out to check nobody swapped it. */
  words: string[];
  verified: boolean;
  host: boolean;
};

export const SPACE_STATUSES = ["joining", "active", "left", "closed"] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];

export type ThreadSpace = { id: string; host: boolean; status: SpaceStatus; gonds: SpaceGond[]; members: SpaceMember[] };

export type Space = ThreadSpace & { threadId: string; rules: SpaceRule[] };

export type FederationState = "off" | "connecting" | "ready" | "closed" | "replaced";

export type Federation = {
  enabled: boolean;
  name: string;
  relay: "gond" | "own";
  relayUrl: string;
  invites: "everyone" | "admin";
  state: FederationState;
  words: string[] | null;
  /** Whether the person asking may make invites and join spaces now. */
  canInvite: boolean;
};

export type FederationPeer = { key: string; name: string; words: string[]; verified: boolean; blocked: boolean; lastSeen: string | null; spaces: number };

/** Each person's defaults for their bots in spaces. `bots` lists who may join (none until picked); null means every bot, new ones too. */
export type SpaceDefaults = { level: SpaceLevel; bots: string[] | null };

export type SpaceInvitePreview = {
  name: string;
  host: { key: string; name: string; words: string[] };
  members: { name: string; kind: "person" | "bot"; color: string | null }[];
  expires: string;
};
