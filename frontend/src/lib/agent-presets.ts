// Playful default agent identities for the create-agent dialog: one animal per letter A–Z, each a
// "<Name> the <Animal>" whose first name and animal both start with that letter. The handle is the
// lowercase-kebab of the name. On open the dialog picks a random preset whose handle isn't already
// taken in the workspace, so a user can spin up an agent in one click.

export interface AgentPreset {
  name: string;
  handle: string;
}

// Lowercase-kebab: "Andy the Armadillo" -> "andy-the-armadillo". Collapses any run of non
// alphanumeric chars to a single hyphen and trims leading/trailing hyphens.
export function toKebab(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function p(name: string): AgentPreset {
  return { name, handle: toKebab(name) };
}

// 26 presets, one per letter of the alphabet.
export const AGENT_PRESETS: AgentPreset[] = [
  p("Andy the Armadillo"),
  p("Benny the Beaver"),
  p("Chloe the Cheetah"),
  p("Daisy the Dolphin"),
  p("Echo the Elephant"),
  p("Finn the Fox"),
  p("Gus the Gorilla"),
  p("Hazel the Hedgehog"),
  p("Igor the Iguana"),
  p("Jasper the Jaguar"),
  p("Kiki the Koala"),
  p("Luna the Lion"),
  p("Milo the Moose"),
  p("Nico the Narwhal"),
  p("Olive the Otter"),
  p("Pip the Penguin"),
  p("Quincy the Quail"),
  p("Ruby the Rabbit"),
  p("Stella the Sloth"),
  p("Theo the Tiger"),
  p("Uma the Unicorn"),
  p("Vince the Vulture"),
  p("Willow the Walrus"),
  p("Xena the Xolo"),
  p("Yuri the Yak"),
  p("Zed the Zebra"),
];

// Pick a random preset whose handle isn't already taken. If every preset is taken (26+ animal
// agents in one workspace), fall back to a random preset as-is — the user can edit the handle.
export function randomFreePreset(takenHandles: Set<string>): AgentPreset {
  const free = AGENT_PRESETS.filter((x) => !takenHandles.has(x.handle));
  const pool = free.length ? free : AGENT_PRESETS;
  return pool[Math.floor(Math.random() * pool.length)];
}
