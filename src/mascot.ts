type RGB = readonly [number, number, number];

const PALETTE: Record<string, RGB> = {
  O: [0x1e, 0x3a, 0x8a], // outline
  B: [0x3b, 0x82, 0xf6], // body
  L: [0x60, 0xa5, 0xfa], // highlight
  S: [0x47, 0x55, 0x69], // whisker dots
  M: [0xcb, 0xd5, 0xe1], // muzzle
  N: [0x02, 0x06, 0x17], // nose
  E: [0x02, 0x06, 0x17], // eye
  W: [0xf8, 0xfa, 0xfc], // eye glint
  T: [0xf8, 0xfa, 0xfc], // tusk
};

export const WALRUS = `
....OOOOOO....
..OOBBBBBBOO..
.OBLLBBBBBBBO.
.OBEWBBBBEWBO.
OBBEEBBBBEEBBO
OBBBBBBBBBBBBO
OBMMMMNNMMMMBO
OMMSMSMMSMSMMO
OMMMMMMMMMMMMO
.OOTTOOOOTTOO.
...TT....TT...
...TT....TT...
`;

export type Mood = "idle" | "blink" | "look" | "sleepy";

const EYES: Record<Mood, string> = {
  idle: ".OBEBBBBEBO.",
  blink: ".OBOBBBBOBO.",
  look: ".OBBEBBBBEO.",
  sleepy: ".OBSBBBBSBO.",
};

// 12x6 pixels -> 3 text rows; only the eye row changes with mood.
export function tinyWalrus(mood: Mood): string {
  return ["..OOOOOOOO..", EYES[mood], "OBMMMNNMMMBO", "OMSMSMMSMSMO", ".OOTOOOOTOO.", "...T....T..."].join("\n");
}

const fg = ([r, g, b]: RGB) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: RGB) => `\x1b[48;2;${r};${g};${b}m`;
const RESET = "\x1b[0m";

// Two pixel rows per text row: upper half-block takes fg for top pixel, bg for bottom.
export function renderPixels(art: string): string[] {
  const rows = art.trim().split("\n");
  const width = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => r.padEnd(width, "."));
  if (grid.length % 2) grid.push(".".repeat(width));
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = PALETTE[grid[y]![x]!];
      const bot = PALETTE[grid[y + 1]![x]!];
      if (top && bot) line += `${fg(top)}${bg(bot)}▀${RESET}`;
      else if (top) line += `${fg(top)}▀${RESET}`;
      else if (bot) line += `${fg(bot)}▄${RESET}`;
      else line += " ";
    }
    lines.push(line);
  }
  return lines;
}
