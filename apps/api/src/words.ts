import { createHash } from "node:crypto";

// 256 short, plain words, one per byte, so six of them carry 48 bits of a key's hash: too many for
// anyone to make a key of their own that reads the same, few enough to read out loud.
const WORDS = [
  "acorn", "actor", "agent", "album", "alley", "amber", "anchor", "angle", "ankle", "apple", "apron", "arrow",
  "atlas", "attic", "badge", "bagel", "baker", "bamboo", "banjo", "barn", "basin", "beach", "beacon", "beard",
  "bench", "berry", "bison", "blade", "blanket", "bloom", "board", "bonnet", "bottle", "branch", "brave", "bread",
  "brick", "bridge", "brook", "broom", "bubble", "bucket", "butter", "cabin", "cable", "cactus", "camel", "candle",
  "canoe", "canyon", "carpet", "carrot", "castle", "cedar", "chalk", "cherry", "chess", "chimney", "cider", "circle",
  "citrus", "clay", "cliff", "clock", "cloud", "clover", "coast", "cobalt", "comet", "copper", "coral", "cotton",
  "cougar", "crane", "crayon", "creek", "cricket", "crown", "crystal", "cuckoo", "daisy", "dawn", "delta", "desert",
  "dew", "dingo", "dolphin", "donkey", "dragon", "drift", "drum", "dune", "eagle", "easel", "ember", "engine",
  "fable", "falcon", "feather", "fern", "fiddle", "field", "finch", "flame", "flute", "forest", "fossil", "fox",
  "frost", "garden", "garlic", "gecko", "geyser", "ginger", "glacier", "glove", "goose", "granite", "grape", "gravel",
  "guitar", "harbor", "harvest", "hazel", "heron", "hickory", "hill", "honey", "horizon", "husky", "iceberg", "igloo",
  "indigo", "iris", "island", "ivory", "jacket", "jade", "jaguar", "jasmine", "jelly", "jungle", "kayak", "kettle",
  "kiwi", "koala", "ladder", "lagoon", "lantern", "lark", "lava", "lemon", "lily", "linen", "lizard", "llama",
  "lobster", "locket", "lotus", "lunar", "magnet", "mango", "maple", "marble", "meadow", "melon", "meteor", "mint",
  "mirror", "mitten", "moose", "moss", "mountain", "muffin", "nectar", "nest", "nickel", "noodle", "nutmeg", "oak",
  "oasis", "ocean", "olive", "onyx", "orbit", "orchid", "otter", "owl", "paddle", "panda", "paper", "parrot",
  "pebble", "pecan", "pepper", "piano", "pickle", "pigeon", "pillow", "pine", "planet", "plum", "pocket", "pony",
  "poppy", "prism", "pumpkin", "puzzle", "quail", "quartz", "quill", "rabbit", "radish", "rain", "raven", "reef",
  "ribbon", "river", "robin", "rocket", "rose", "saddle", "saffron", "salmon", "sapphire", "satin", "scarf", "shell",
  "silver", "sky", "sled", "slate", "snail", "sparrow", "spruce", "squash", "star", "stone", "storm", "sugar",
  "summit", "swan", "tablet", "tango", "teapot", "thistle", "thunder", "tiger", "timber", "toast", "tulip", "tundra",
  "turtle", "velvet", "violin", "walnut",
];

if (WORDS.length !== 256 || new Set(WORDS).size !== 256) throw new Error("The key word list must hold 256 different words");

/** Six words for a Gond's key, the same on every Gond that knows it. */
export function keyWords(key: string): string[] {
  const hash = createHash("sha256").update(`gond-space-words\n${key}`).digest();
  return [...hash.subarray(0, 6)].map((byte) => WORDS[byte]!);
}
