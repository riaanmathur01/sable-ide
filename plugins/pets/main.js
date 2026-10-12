// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/*
 * Pets: little pixel-art animals that live in a sidebar view (and, with
 * "Start Pet Coding Session", an editor tab). The plugin keeps the list of
 * pets and the settings; each page runs its own little simulation of them.
 *
 * All the art is original and drawn by this file: every sprite is a grid
 * of palette keys below, outlined and scaled up on a <canvas>.
 */

// ---------------------------------------------------------------------------
// Sprites
//
// Rows of palette keys, facing right. The page adds a 1-pixel outline
// around each sprite, so these are just the fills:
//   .  transparent        b  body          s  shade / markings
//   h  light (belly…)     e  eye           n  nose
//   p  pink               x  accent        y  accent 2 (beak, horns…)
//   w  white
// Eyes two pixels tall can blink (top pixel closes) and smile (bottom
// pixel closes). Every frame of a pet has the same size.
// ---------------------------------------------------------------------------

/** Replace some rows: `patch(rows, { 3: "…" })`. */
const patch = (rows, changes) => rows.map((row, index) => changes[index] ?? row);

/** Shift rows `from`..`to` (inclusive) sideways by dx, keeping the width. */
function shiftRows(rows, from, to, dx) {
  return rows.map((row, index) => {
    if (index < from || index > to) return row;
    return dx > 0 ? ".".repeat(dx) + row.slice(0, row.length - dx) : row.slice(-dx) + ".".repeat(-dx);
  });
}

/** Move rows `from`..`to` (inclusive) down by one; row `to` is drawn over the row below it. */
function lowerRows(rows, from, to) {
  const overlay = (top, under) => top.split("").map((key, x) => (key === "." ? under[x] : key)).join("");
  const out = [...rows];
  for (let y = to; y >= from; y--) out[y + 1] = y === to ? overlay(rows[y], rows[y + 1]) : rows[y];
  out[from] = ".".repeat(rows[0].length);
  return out;
}

// --- Dog -------------------------------------------------------------------
const dogStand = [
  "..........bbbbb...",
  ".........bbbbbbb..",
  "........ssbbbbebb.",
  ".b......ssbbbbebhn",
  ".b......ssbbbbbhhh",
  "..b......sbbbbhhp.",
  "..bbbbbbbbbxxbbb..",
  "..bbbbbbbbbbbhhb..",
  "..bbbbbbbbbbbhh...",
  "...bb.s....s.bb...",
  "...bb.s....s.bb...",
];
const dogSit = patch(dogStand, {
  3: "........ssbbbbebhn",
  4: "........ssbbbbbhhh",
  5: ".........sbbbbhhp.",
  6: ".........bbxxbbb..",
  7: "..b.....bbbbbhhb..",
  8: "..b...bbbbbbbhhb..",
  9: "...bbbbbbbbbbhh...",
  10: "...bbbbbbbb.bb....",
});
const dog = {
  stand: dogStand,
  stand2: patch(dogStand, { 3: "b.......ssbbbbebhn", 4: ".b......ssbbbbbhhh" }),
  walk1: patch(dogStand, { 9: "..bb..s....s..bb..", 10: ".bb....s..s....bb." }),
  walk2: patch(dogStand, { 9: "....bbs....sbb....", 10: "....bbs....sbb...." }),
  run1: patch(dogStand, { 3: "b.......ssbbbbebhn", 4: ".b......ssbbbbbhhh", 9: ".bbs.........sbb..", 10: "bb.............bb." }),
  run2: patch(dogStand, { 9: ".....bbsbbsbb.....", 10: ".....bbsbbsbb....." }),
  sit: dogSit,
  sit2: patch(dogSit, { 7: ".b......bbbbbhhb..", 8: "..b...bbbbbbbhhb.." }),
  sleep1: [
    "..................",
    "..................",
    "..................",
    "..................",
    "..................",
    "..........bbbb....",
    "....bbbbbbsbbbb...",
    "...bbbbbbbssbbebb.",
    "..bbbbbbbbbsbbbhhn",
    "bbbbbbbbbbbbbbbhh.",
    ".bbbbbbbbbbbbbbbb.",
  ],
  sleep2: null,
  jump: patch(dogStand, { 3: "b.......ssbbbbebhn", 4: ".b......ssbbbbbhhh", 9: "..bbs.......sbb...", 10: ".bb...........bb.." }),
};
dog.sleep2 = patch(dog.sleep1, { 5: ".....bb...bbbb....", 6: "...bbbbbbbsbbbb..." });

// --- Cat -------------------------------------------------------------------
const catStand = [
  ".........b.....b",
  ".........bpbbbpb",
  ".b.......bebbbeb",
  "b........bebbbeb",
  "b........bbbpbbb",
  ".b..bbbbbbbbbbb.",
  "..bbbbbsbbsbbb..",
  "...bbbbbbbbhhb..",
  "...bb.s...s.bb..",
  "...bb.s...s.bb..",
];
const catSit = [
  ".........b.....b",
  ".........bpbbbpb",
  ".........bebbbeb",
  ".........bebbbeb",
  ".........bbbpbbb",
  "........bbbbbbb.",
  ".......bsbbbhhb.",
  "......bbbsbbhhb.",
  ".bbb..bbbbbbbbb.",
  "..bbbbbbbbbb.bb.",
];
const cat = {
  stand: catStand,
  stand2: patch(catStand, { 2: "b........bebbbeb", 3: "b........bebbbeb", 4: ".b.......bbbpbbb", 5: "..b.bbbbbbbbbbb." }),
  walk1: patch(catStand, { 8: "..bb..s...s..bb.", 9: ".bb....s.s....bb" }),
  walk2: patch(catStand, { 8: "....bbs...sbb...", 9: "....bbs...sbb..." }),
  run1: patch(catStand, { 2: "bb.......bebbbeb", 3: "..b......bebbbeb", 4: "...b.....bbbpbbb", 5: "....bbbbbbbbbbb.", 8: ".bbs........sbb.", 9: "bb............bb" }),
  run2: patch(catStand, { 8: ".....bbsbsbb....", 9: ".....bbsbsbb...." }),
  sit: catSit,
  sit2: patch(catSit, { 8: "bb....bbbbbbbbb.", 9: ".bbbbbbbbbbb.bb." }),
  sleep1: [
    "................",
    "................",
    "................",
    "................",
    "................",
    ".........b.....b",
    "...bbbbbbbbbbbbb",
    "..bbbbbsbbsbbbbb",
    ".bbbbbsbbbbebbbe",
    "hbbbbbbbbbbbbpbb",
  ],
  sleep2: null,
  jump: patch(catStand, { 8: "..bbs......sbb..", 9: ".bb..........bb." }),
};
cat.sleep2 = patch(cat.sleep1, { 5: ".........b.....b", 6: "..bbbbbbbbbbbbbb", 7: ".bbbbbbsbbsbbbbb" });

// --- Fox -------------------------------------------------------------------
const foxStand = [
  "...........b.b....",
  "..........bbbbb...",
  "hh........bbbbeb..",
  "hbb.......bbbbebhn",
  ".bbb......hbbbhhh.",
  "..bbbbbbbbbhhhh...",
  "...bbbbbbbbbhh....",
  "...bbhhhhhbbbb....",
  "....s.s....s.s....",
  "....s.s....s.s....",
];
const foxSit = [
  "...........b.b....",
  "..........bbbbb...",
  "..........bbbbeb..",
  "..........bbbbebhn",
  "..........hbbbhhh.",
  ".........bbbhhh...",
  "........bbbbhhh...",
  "..hh...bbbbbhhh...",
  ".hbbbbbbbbbbhh....",
  "..bbbbbbbbb.s.s...",
];
const fox = {
  stand: foxStand,
  stand2: patch(foxStand, { 2: ".hh.......bbbbeb..", 3: "hbbb......bbbbebhn", 4: "..bbb.....hbbbhhh." }),
  walk1: patch(foxStand, { 8: "...s..s...s...s...", 9: "..s....s.s.....s.." }),
  walk2: patch(foxStand, { 8: ".....ss....ss.....", 9: ".....ss....ss....." }),
  run1: patch(foxStand, { 2: "..........bbbbeb..", 3: "hhbb......bbbbebhn", 4: ".hbbb.....hbbbhhh.", 8: "..s..........s....", 9: ".s.............s.." }),
  run2: patch(foxStand, { 8: ".....s.ss.s.......", 9: ".....s.ss.s......." }),
  sit: foxSit,
  sit2: patch(foxSit, { 7: ".hh....bbbbbhhh...", 8: "..bbbbbbbbbbhh...." }),
  sleep1: [
    "..................",
    "..................",
    "..................",
    "..................",
    "..................",
    "..........b.b.....",
    "....bbbbbbbbbb....",
    "..bbbbbbbbbbebhn..",
    ".hbbbbbbbbbbbhhh..",
    "hhhhhbbbbbbbbbbb..",
  ],
  sleep2: null,
  jump: patch(foxStand, { 8: "...s.........s....", 9: "..s...........s..." }),
};
fox.sleep2 = patch(fox.sleep1, { 5: "..........b.b.....", 6: "...bbbbbbbbbbb...." });

// --- Rubber duck -----------------------------------------------------------
const duckStand = [
  "......bbbb....",
  ".....bbbbbb...",
  ".....bbbbebb..",
  ".....bbbbebyy.",
  "......bbbbbyy.",
  "b......bbbb...",
  "bb...bbbbbbbb.",
  "bbbbbbbsssbbb.",
  "bbbbbbsssbbbb.",
  ".bbbbbbbbbbbb.",
  "..bbbbbbbbbb..",
];
const duck = {
  stand: duckStand,
  stand2: patch(duckStand, { 5: ".......bbbb...", 6: "bb...bbbbbbbb." }),
  walk1: shiftRows(duckStand, 0, 4, -1),
  walk2: shiftRows(duckStand, 0, 4, 1),
  run1: shiftRows(shiftRows(duckStand, 0, 4, -1), 7, 8, 0),
  run2: shiftRows(duckStand, 0, 6, 1),
  sit: duckStand,
  sit2: patch(duckStand, { 5: ".......bbbb...", 6: "bb...bbbbbbbb." }),
  sleep1: lowerRows(patch(duckStand, { 2: ".....bbbbbbb..", 3: ".....bbbbebyy." }), 0, 4),
  sleep2: patch(duckStand, { 2: ".....bbbbbbb..", 3: ".....bbbbebyy." }),
  jump: patch(duckStand, { 7: "bbbbbbbbsssbb.", 8: "bbbbbbbsssbbb." }),
};

// --- Crab ------------------------------------------------------------------
const crabStand = [
  "bb.b........b.bb",
  "bbbb..w..w..bbbb",
  ".bb...e..e...bb.",
  "..b..bbbbbb..b..",
  "..bbbbbbbbbbbb..",
  "..bbbpbbbbpbbb..",
  "...bbbbeebbbb...",
  "..s.sbbbbbbs.s..",
  ".s.s........s.s.",
];
const crabSit = [
  "................",
  "bb.b........b.bb",
  "bbbb..w..w..bbbb",
  ".bb...e..e...bb.",
  "..b..bbbbbb..b..",
  "..bbbbbbbbbbbb..",
  "..bbbpbbbbpbbb..",
  "...bbbbeebbbb...",
  ".ssssbbbbbbssss.",
];
const crab = {
  stand: crabStand,
  stand2: patch(crabStand, { 0: ".bbb........bbb." }),
  walk1: crabStand,
  walk2: patch(crabStand, { 0: ".bbb........bbb.", 7: "...ssbbbbbbss...", 8: "..s..s....s..s.." }),
  run1: patch(crabStand, { 7: "..s.sbbbbbbs.s..", 8: "s..s........s..s" }),
  run2: patch(crabStand, { 0: ".bbb........bbb.", 7: "...ssbbbbbbss...", 8: "...s.s....s.s..." }),
  sit: crabSit,
  sit2: patch(crabSit, { 1: ".bbb........bbb." }),
  sleep1: [
    "................",
    "................",
    "................",
    "................",
    "......s..s......",
    ".bb..bbbbbb..bb.",
    "bbbbbbbbbbbbbbbb",
    "bbbbbpbbbbpbbbbb",
    ".ssssbbbebbbsss.",
  ],
  sleep2: null,
  jump: patch(crabStand, { 0: "b..b........b..b", 1: "bbbb..w..w..bbbb", 6: "...bbbeeeebbb...", 7: "..s.sbbbbbbs.s..", 8: "..s.s......s.s.." }),
};
crab.sleep2 = patch(crab.sleep1, { 8: ".ssssbbbbbbbsss." });

// --- Snake (drawn from a sine wave) ----------------------------------------
/**
 * A slithering snake: a body that follows a sine wave (phase picks the
 * frame), with the head at the right. `lift` raises the head.
 */
function snakeFrame(phase, { tongue = false, lift = 0 } = {}) {
  const width = 22;
  const height = 10;
  const grid = Array.from({ length: height }, () => Array(width).fill("."));
  const set = (x, y, key) => {
    if (x >= 0 && x < width && y >= 0 && y < height) grid[y][x] = key;
  };
  const neck = 15;
  const centreAt = (x) => {
    const envelope = Math.min(1, (x + 1) / 4) * (1 - (x / neck) * 0.6);
    return 6.2 - lift * (x / neck) + 1.9 * envelope * Math.sin(x * 0.6 + phase);
  };
  for (let x = 0; x <= neck; x++) {
    const top = Math.round(centreAt(x) - 1);
    const thick = x < 2 ? 1 : x < 4 ? 2 : 3;
    // Diamond markings along the back, a pale belly underneath.
    set(x, top, thick === 3 && x % 4 === 2 ? "s" : "b");
    if (thick >= 2) set(x, top + 1, thick === 3 && (x % 4 === 1 || x % 4 === 3) ? "s" : "b");
    if (thick === 3) set(x, top + 2, "h");
    if (thick === 2) set(x, top + 1, "h");
  }
  const headTop = Math.max(0, 3 - lift);
  const head = [
    "..bbbb.",
    ".bbbbbb",
    "bbbbebb",
    "bbbbbbn",
    "hhhhhh.",
  ];
  head.forEach((row, y) => row.split("").forEach((key, x) => key !== "." && set(neck - 1 + x, headTop + y, key)));
  // Fill the neck so the head and the body join.
  const neckTop = Math.round(centreAt(neck) - 1);
  for (let y = Math.min(headTop + 2, neckTop); y <= Math.max(headTop + 4, neckTop + 2); y++) {
    const belly = y === Math.max(headTop + 4, neckTop + 2);
    set(neck - 1, y, belly ? "h" : "b");
    set(neck, y, belly ? "h" : "b");
  }
  if (tongue) {
    set(width - 1, headTop + 3, "p");
    set(width - 1, headTop + 4, "p");
  }
  return grid.map((row) => row.join(""));
}
const snakeCoil = [
  "......................",
  "......................",
  "......................",
  "......................",
  "......................",
  "..............bbbbb...",
  "......bbbbbb.bbbbebb..",
  "....bbsbbbsbbbbbbbbn..",
  "...bbbbbsbbbbsbbhhh...",
  "....hhhhhhhhhhhhh.....",
];
const snake = {
  stand: snakeFrame(0),
  stand2: snakeFrame(0, { tongue: true }),
  walk1: snakeFrame(0),
  walk2: snakeFrame(Math.PI / 2),
  run1: snakeFrame(Math.PI),
  run2: snakeFrame((Math.PI * 3) / 2, { tongue: true }),
  sit: snakeFrame(0.6, { lift: 2 }),
  sit2: snakeFrame(0.6, { lift: 2, tongue: true }),
  sleep1: snakeCoil,
  sleep2: patch(snakeCoil, { 5: ".......bbbb...bbbbb...", 6: ".....bbbbbbbb.bbbbebb." }),
  jump: snakeFrame(Math.PI / 2, { lift: 2, tongue: true }),
};

// --- Bunny -----------------------------------------------------------------
const bunnyStand = [
  "........bb.bb.",
  "........bp.pb.",
  "........bp.pb.",
  "........bp.pb.",
  ".......bbbbbbb",
  ".......bebbbeb",
  ".......bebbbeb",
  ".hh.bbbbbbpbbb",
  "hhhbbbbbbbbbb.",
  ".hbbbbbbbbhhb.",
  "..bbbbbbbbbbb.",
  "..hhhh...hh...",
];
const bunny = {
  stand: bunnyStand,
  stand2: patch(bunnyStand, { 0: "..............", 1: "........bb.bb.", 2: "........bp.pb.", 3: "........bp.pb." }),
  walk1: bunnyStand,
  walk2: patch(bunnyStand, { 0: ".......bb.bb..", 1: ".......bp.pb..", 10: ".bbbbbbbbbbbb.", 11: "hhh......hh..." }),
  run1: bunnyStand,
  run2: patch(bunnyStand, { 0: "......bb.bb...", 1: ".......bp.pb..", 10: ".bbbbbbbbbbbb.", 11: "hhh.......hh.." }),
  sit: bunnyStand,
  sit2: patch(bunnyStand, { 0: "........bb....", 1: "........bp....", 2: "........bp.bbb", 3: "........bp.ppb" }),
  sleep1: [
    "..............",
    "..............",
    "..............",
    "..............",
    "..............",
    "..............",
    "..............",
    "....bbbppbbb..",
    "..hbbbbbbbbbbb",
    ".hhbbbbbbebbeb",
    ".hbbbbbbbbbpbb",
    "..hhhhhhhhhhh.",
  ],
  sleep2: null,
  jump: patch(bunnyStand, { 0: ".......bb.bb..", 10: ".bbbbbbbbbbbb.", 11: "hhh.......hh.." }),
};
bunny.sleep2 = patch(bunny.sleep1, { 7: "...bbbbppbbb..", 8: ".hbbbbbbbbbbbb" });

// --- Dragon ----------------------------------------------------------------
const dragonStand = [
  "...........y..y...",
  "...........bbbbb..",
  ".....x....bbbbbebb",
  "....xxx...bbbbbebn",
  "...xxxxx..bbbbbhhh",
  "....xxxybbbbbhh...",
  "....ybbbbbbbbhh...",
  "y..bbbbbbbbbhhh...",
  ".bbbbbbbbbbbhh....",
  "..bb.bbhhhhhbb....",
  ".....bb...bb......",
  ".....bb...bb......",
];
const dragonWingDown = {
  2: "..........bbbbbebb",
  3: "..........bbbbbebn",
  4: "..........bbbbbhhh",
  5: "..xxxxxybbbbbhh...",
  6: "...xxxbbbbbbbhh...",
};
const dragonSit = [
  "...........y..y...",
  "...........bbbbb..",
  ".....x....bbbbbebb",
  "....xxx...bbbbbebn",
  "...xxxxx..bbbbbhhh",
  "....xxxybbbbbhh...",
  "....ybbbbbbbbhh...",
  "...bbbbbbbbbhhh...",
  "y..bbbbbbbbbhh....",
  ".bbbbbbbbbbbhh....",
  "..bbbbbbbbb.bb....",
  "..................",
];
const dragon = {
  stand: dragonStand,
  stand2: patch(dragonStand, dragonWingDown),
  walk1: patch(dragonStand, { 10: "....bb.....bb.....", 11: "...bb.......bb...." }),
  walk2: patch(dragonStand, { ...dragonWingDown, 10: "......bb.bb.......", 11: "......bb.bb......." }),
  run1: patch(dragonStand, { 10: "...bb.......bb....", 11: "..bb.........bb..." }),
  run2: patch(dragonStand, { ...dragonWingDown, 10: "......bbbb........", 11: "......bbbb........" }),
  sit: lowerRows(dragonSit, 0, 10),
  sit2: lowerRows(patch(dragonSit, dragonWingDown), 0, 10),
  sleep1: [
    "..................",
    "..................",
    "..................",
    "..................",
    "..................",
    "..................",
    ".........y..y.....",
    ".....xxx.bbbbb....",
    "....xxxxbbbbbbebb.",
    "y..bbbbbbbbbbbbbn.",
    ".bbbbbbbbbbbbhhhh.",
    "..bbhhhhhhhhbb....",
  ],
  sleep2: null,
  jump: patch(dragonStand, { 2: "..x.......bbbbbebb", 3: ".xxx......bbbbbebn", 4: "xxxxx.....bbbbbhhh", 10: "...bb.....bb......", 11: "..................", }),
};
dragon.sleep2 = patch(dragon.sleep1, { 7: "......xx.bbbbb...." });

// --- Panda -----------------------------------------------------------------
const pandaStand = [
  "........ss....ss",
  "........sbbbbbbs",
  ".......bbbbbbbbb",
  ".......bbsbbbsbb",
  ".......bsebbbesb",
  "..b....bbbbnbbbb",
  "..bbbbbbsssbbbb.",
  ".bbbbbbbsssbbbb.",
  ".bbbbbbbsssbbbb.",
  "..ss.s....ss.s..",
  "..ss.s....ss.s..",
];
const pandaSit = [
  "........ss....ss",
  "........sbbbbbbs",
  ".......bbbbbbbbb",
  ".......bbsbbbsbb",
  ".......bsebbbesb",
  ".......bbbbnbbbb",
  "......sssbbbsss.",
  ".....bssssbsssb.",
  "...bbbbbsssssbb.",
  "..ssbbbbbbbbbss.",
  "..sssbbbbbbbsss.",
];
const panda = {
  stand: pandaStand,
  stand2: patch(pandaStand, { 5: "..b....bbbbnbbbb" }),
  walk1: patch(pandaStand, { 9: ".ss...s..ss...s.", 10: "ss.....s.s....ss" }),
  walk2: patch(pandaStand, { 9: "...sss....sss...", 10: "...sss....sss..." }),
  run1: patch(pandaStand, { 9: ".sss.......sss..", 10: "ss...........ss." }),
  run2: patch(pandaStand, { 9: "....ssssssss....", 10: "....sss..sss...." }),
  sit: pandaSit,
  sit2: patch(pandaSit, { 6: "......sssbbbsss.", 7: ".....bssssbsssbs" }),
  sleep1: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "..........ss.ss.",
    "...bbbbbbbsbbbs.",
    "..bbbbbbsbbbbbbb",
    ".bbbbbbsssbsbbsb",
    ".bbbbbbsssbbbnbb",
    "..sssbbbsssssss.",
  ],
  sleep2: null,
  jump: patch(pandaStand, { 9: ".ss........ss...", 10: "ss..........ss.." }),
};
panda.sleep2 = patch(panda.sleep1, { 6: "..bbbbbbbbsbbbs.", 7: ".bbbbbbbsbbbbbbb" });

/**
 * Pet types: sprites, palettes (several colours each), how they move,
 * and what they say when clicked.
 * @type {Record<string, { label: string; sprites: Record<string, string[] | null>; colors: Record<string, Record<string, string>>; speed: number; hop?: boolean; noFlip?: boolean; mouth: [number, number]; sounds: string[]; names?: string[] }>}
 */
const TYPES = {
  dog: {
    label: "Dog",
    sprites: dog,
    speed: 30,
    mouth: [17, 5],
    sounds: ["Woof!", "Arf!", "*wag wag*", "Ball?!", "Good code!"],
    names: ["Biscuit", "Scout", "Rusty", "Pickles", "Bark Twain", "Sir Fetch"],
    colors: {
      brown: { b: "#c98a4b", s: "#8c5a2e", h: "#f6e1c0", x: "#e8475f", o: "#3d2412" },
      golden: { b: "#efbd5d", s: "#c88b32", h: "#fdf0cf", x: "#3f8ae0", o: "#4e3110" },
      black: { b: "#4d4c56", s: "#2e2d34", h: "#c9c2b6", x: "#f2c94c", e: "#e0a440", n: "#141318", o: "#111014" },
      white: { b: "#f7f2ea", s: "#c9b9a4", h: "#ffffff", x: "#e8475f", o: "#5e5146" },
      gray: { b: "#a1a8b3", s: "#6b7280", h: "#e6e9ee", x: "#8b5cf6", o: "#2d323a" },
    },
  },
  cat: {
    label: "Cat",
    sprites: cat,
    speed: 26,
    mouth: [13, 5],
    sounds: ["Meow", "Mrrp?", "*purr*", "...", "Feed me."],
    names: ["Mochi", "Miso", "Whiskers", "Luna", "Pixel", "Catnip"],
    colors: {
      orange: { b: "#f0a04b", s: "#c86f22", h: "#fde3c3", o: "#4a2508" },
      black: { b: "#3c3a44", s: "#24232a", h: "#5c5a66", e: "#f2d14b", p: "#e48aa8", o: "#0f0e12" },
      gray: { b: "#9aa1ad", s: "#6b7280", h: "#dfe3ea", o: "#2a2e36" },
      white: { b: "#f8f5ef", s: "#d8cfc3", h: "#ffffff", e: "#3e7bd6", o: "#5f5a52" },
      brown: { b: "#a7754d", s: "#6f4a2b", h: "#e8cdb0", e: "#2b2618", o: "#2e1c0d" },
    },
  },
  fox: {
    label: "Fox",
    sprites: fox,
    speed: 32,
    mouth: [17, 4],
    sounds: ["Yip!", "*sniff sniff*", "Ring-ding?", "Heh."],
    names: ["Ember", "Rusty", "Juniper", "Maple", "Firefox", "Fennec"],
    colors: {
      red: { b: "#ee7a34", s: "#3a2a25", h: "#fff4e6", o: "#4a1f05" },
      arctic: { b: "#eef3f7", s: "#8c99a8", h: "#ffffff", o: "#55606e" },
      silver: { b: "#7f8796", s: "#2b2d33", h: "#e9ecf1", o: "#1f2228" },
    },
  },
  duck: {
    label: "Rubber Duck",
    sprites: duck,
    speed: 18,
    mouth: [12, 4],
    sounds: ["Quack!", "Explain it to me.", "Quack?", "Have you tried logging it?"],
    names: ["Ducky", "Quackers", "Debug", "Sir Quacks", "Bob", "Rubber"],
    colors: {
      yellow: { b: "#ffd84a", s: "#f2b51f", y: "#ff8a2a", o: "#6b4a00" },
      pink: { b: "#ffb3cd", s: "#f285aa", y: "#ff8a2a", o: "#6b2440" },
      blue: { b: "#8fd0ff", s: "#55a8e8", y: "#ff9a3a", o: "#17456b" },
      white: { b: "#ffffff", s: "#d9dee6", y: "#ff8a2a", o: "#59606b" },
    },
  },
  crab: {
    label: "Crab",
    sprites: crab,
    speed: 20,
    noFlip: true,
    mouth: [8, 0],
    sounds: ["*snip snip*", "Clack!", "Rust is safe.", "Pinch?"],
    names: ["Ferris", "Pinchy", "Clawdia", "Sheldon", "Crabby", "Sideways"],
    colors: {
      red: { b: "#ec5a45", s: "#b93a2b", e: "#1d1a24", p: "#ffb0a0", o: "#4a120a" },
      orange: { b: "#f7944a", s: "#c96a22", e: "#1d1a24", p: "#ffd0a8", o: "#4d2306" },
      blue: { b: "#4f9fe8", s: "#2e6fb5", e: "#1d1a24", p: "#bfe0ff", o: "#0d2c4f" },
    },
  },
  snake: {
    label: "Snake",
    sprites: snake,
    speed: 16,
    mouth: [21, 4],
    sounds: ["Hsss~", "import this", "Sss!", "*blep*"],
    names: ["Monty", "Py", "Noodle", "Slinky", "Kaa-t", "Hissy"],
    colors: {
      green: { b: "#5cc46a", s: "#2f8a44", h: "#e8f5b0", p: "#ff4b6e", o: "#123d1d" },
      yellow: { b: "#f2d04b", s: "#3b6fd6", h: "#fff7c8", p: "#ff4b6e", o: "#4d3d06" },
      purple: { b: "#a77bea", s: "#6a43b8", h: "#f0e4ff", p: "#ff4b6e", o: "#2c1757" },
    },
  },
  bunny: {
    label: "Bunny",
    sprites: bunny,
    speed: 34,
    hop: true,
    mouth: [13, 7],
    sounds: ["*boop*", "*nose wiggle*", "Squeak!", "Carrot?"],
    names: ["Clover", "Thumper", "Bun Bun", "Hopscotch", "Cocoa", "Waffles"],
    colors: {
      white: { b: "#f8f6f2", s: "#d6cfc6", h: "#ffffff", p: "#ffa3bb", o: "#5d5650" },
      brown: { b: "#b98a62", s: "#8a603d", h: "#f3e4d2", p: "#ffa3bb", o: "#3a2414" },
      gray: { b: "#a3a8b2", s: "#767c88", h: "#eceef2", p: "#ffa3bb", o: "#2f333a" },
      black: { b: "#4a4851", s: "#2c2b31", h: "#e2ded8", p: "#ff8fab", e: "#ffd27a", o: "#0f0e12" },
    },
  },
  dragon: {
    label: "Dragon",
    sprites: dragon,
    speed: 28,
    mouth: [17, 4],
    sounds: ["Rawr!", "*puff*", "Fwoosh!", "Shiny!"],
    names: ["Ember", "Sparky", "Smol", "Toast", "Draco", "Cinder"],
    colors: {
      green: { b: "#5fc36a", s: "#3c8f4a", h: "#f8e38a", x: "#9ce0a4", y: "#fff2b8", o: "#123d1d" },
      purple: { b: "#9b7de8", s: "#6b4fc0", h: "#ffd9a0", x: "#d2c1ff", y: "#fff2d0", o: "#2a1a5c" },
      red: { b: "#e8574c", s: "#a8352d", h: "#ffd37a", x: "#ffb4a3", y: "#fff1c4", o: "#4c100b" },
    },
  },
  panda: {
    label: "Panda",
    sprites: panda,
    speed: 16,
    mouth: [15, 5],
    sounds: ["*munch*", "Bamboo?", "Mmf!", "*roll*"],
    names: ["Bao", "Dumpling", "Bamboo", "Mei", "Oreo", "Tofu"],
    colors: {
      classic: { b: "#f7f7f4", s: "#2d2d33", n: "#2d2d33", e: "#f7f7f4", o: "#1a1a1f" },
      brown: { b: "#f4ece0", s: "#7a5639", n: "#4a3322", e: "#f4ece0", o: "#33231a" },
    },
  },
};

/** Fill in the frames a type leaves out, so every type has them all. */
const FRAME_NAMES = ["stand", "stand2", "walk1", "walk2", "run1", "run2", "sit", "sit2", "sleep1", "sleep2", "jump"];
const FALLBACK = { stand2: "stand", walk1: "stand", walk2: "walk1", run1: "walk1", run2: "walk2", sit: "stand", sit2: "sit", sleep1: "sit", sleep2: "sleep1", jump: "run1" };
for (const type of Object.values(TYPES)) {
  for (const name of FRAME_NAMES) if (!type.sprites[name]) type.sprites[name] = type.sprites[FALLBACK[name]];
}

const COMMON_NAMES = [
  "Bean", "Noodle", "Mochi", "Waffles", "Pepper", "Sprocket", "Ziggy", "Clover", "Nugget", "Kernel",
  "Tofu", "Pancake", "Cosmo", "Gizmo", "Fig", "Olive", "Turbo", "Byte", "Cookie", "Momo", "Pudding",
  "Hazel", "Lambda", "Pixel", "Tux", "Sushi", "Biscotti", "Boba", "Patch", "Semicolon", "Null",
];

const SCENES = {
  none: "No scenery",
  forest: "Forest — grass, trees and hills",
  beach: "Beach — sand, sea and a palm tree",
  night: "Night — stars, moon and fireflies",
};
const SIZES = { small: "Small", medium: "Medium", large: "Large" };

// ---------------------------------------------------------------------------
// The page: runs in each webview. It's a function so it's syntax-checked
// with the rest of the file; it's sent as source and called with the data.
// ---------------------------------------------------------------------------

/* eslint-disable */
function petsPage(DATA) {
  "use strict";
  const types = DATA.types;
  const vscode = /** @type {any} */ (globalThis).acquireVsCodeApi();
  const stage = /** @type {HTMLCanvasElement} */ (document.getElementById("stage"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (stage.getContext("2d"));
  const emptyNote = /** @type {HTMLElement} */ (document.getElementById("empty"));
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motionQuery.matches;
  const PIXELS = { small: 2, medium: 3, large: 4 };
  const DEFAULT_KEYS = { e: "#1d1a24", w: "#ffffff", n: "#2b1d1a", p: "#ff8fa8", x: "#e8475f", y: "#f6a623", h: "#ffffff" };

  let W = 0, H = 0, dpr = 1, S = 3, groundY = 0;
  let scene = "none", size = "medium";
  /** @type {any[]} */ let pets = [];
  /** @type {any} */ let ball = null;
  /** @type {any[]} */ const particles = [];
  /** @type {any} */ let hover = null;
  /** @type {any} */ let pointer = null;
  const greeted = new Map();
  const spriteCache = new Map();
  let bg = /** @type {HTMLCanvasElement | null} */ (null);
  let bgDecor = /** @type {any} */ ({});
  let clock = 0;
  let saved = /** @type {any} */ (vscode.getState() || {});

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isDark = () => !document.body.classList.contains("vscode-light");
  const cssVar = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }

  // --- Sprites --------------------------------------------------------------

  /** A frame, palette-swapped and outlined, as a canvas (cached). */
  function sprite(typeId, color, frame, eyes, flip) {
    const key = typeId + "|" + color + "|" + frame + "|" + eyes + "|" + flip;
    let canvas = spriteCache.get(key);
    if (canvas) return canvas;
    const type = types[typeId];
    const palette = Object.assign({}, DEFAULT_KEYS, type.colors[color] || Object.values(type.colors)[0]);
    const outline = palette.o || mix(palette.s || palette.b, "#000000", 0.55);
    const rows = type.sprites[frame].map((row) => row.split(""));
    const h = rows.length, w = rows[0].length;
    if (eyes !== "open") {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (rows[y][x] !== "e") continue;
        if (eyes === "blink" && rows[y + 1] && rows[y + 1][x] === "e") rows[y][x] = "b";
        if (eyes === "happy" && rows[y - 1] && rows[y - 1][x] === "e") rows[y][x] = "b";
      }
    }
    canvas = document.createElement("canvas");
    canvas.width = w + 2;
    canvas.height = h + 2;
    const c = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    const img = c.createImageData(w + 2, h + 2);
    const put = (x, y, hex) => {
      const px = flip ? w + 1 - x : x;
      const i = (y * (w + 2) + px) * 4;
      const [r, g, b] = hexToRgb(hex);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    };
    const filled = (x, y) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] !== ".";
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
      if (filled(x, y)) put(x + 1, y + 1, palette[rows[y][x]] || palette.b);
      else if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) put(x + 1, y + 1, outline);
    }
    c.putImageData(img, 0, 0);
    spriteCache.set(key, canvas);
    return canvas;
  }

  /** Small icons (heart, z, ball, spark) as outlined sprites. */
  const ICONS = {
    heart: { rows: [".r.r.", "rrrrr", "rwrrr", ".rrr.", "..r.."], palette: { r: "#ff5a7a", w: "#ffc2cf" }, outline: "#6b1328" },
    z: { rows: ["zzzz", "...z", "..z.", ".z..", "zzzz"], palette: { z: "#cfd8ff" }, outline: "#2c3566" },
    ball: { rows: [".rrr.", "rwrrr", "rrrrr", "rrrrd", ".rdd."], palette: { r: "#ff5a4f", w: "#ffd2cc", d: "#c8322a" }, outline: "#4a0e0a" },
    spark: { rows: [".y.", "yyy", ".y."], palette: { y: "#ffe27a" }, outline: "#6b5200" },
    bang: { rows: ["y", "y", "y", ".", "y"], palette: { y: "#ffd23f" }, outline: "#5a3d00" },
  };
  const iconCache = new Map();
  function icon(name) {
    let canvas = iconCache.get(name);
    if (canvas) return canvas;
    const def = ICONS[name];
    const rows = def.rows, h = rows.length, w = rows[0].length;
    canvas = document.createElement("canvas");
    canvas.width = w + 2; canvas.height = h + 2;
    const c = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    const filled = (x, y) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] !== ".";
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
      if (filled(x, y)) { c.fillStyle = def.palette[rows[y][x]]; c.fillRect(x + 1, y + 1, 1, 1); }
      else if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) { c.fillStyle = def.outline; c.fillRect(x + 1, y + 1, 1, 1); }
    }
    iconCache.set(name, canvas);
    return canvas;
  }

  // --- Layout ---------------------------------------------------------------

  const GROUND = { none: 3, forest: 9, beach: 10, night: 9 };

  function petScale() {
    // Fit the pets in short panels: a pet should take at most ~45% of the height.
    const wanted = PIXELS[size] || 3;
    return Math.max(1, Math.min(wanted, Math.floor((H * 0.45) / 14)));
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, document.documentElement.clientWidth);
    H = Math.max(1, document.documentElement.clientHeight);
    stage.width = Math.round(W * dpr);
    stage.height = Math.round(H * dpr);
    stage.style.width = W + "px";
    stage.style.height = H + "px";
    S = petScale();
    groundY = H - GROUND[scene] * S;
    for (const p of pets) p.x = clampX(p, p.x);
    if (ball && !ball.heldBy) ball.x = clamp(ball.x, ball.r, Math.max(ball.r, W - ball.r));
    drawScene();
  }

  function dims(p) {
    const rows = types[p.type].sprites.stand;
    return { w: (rows[0].length + 2) * S, h: (rows.length + 2) * S };
  }
  function clampX(p, x) {
    const half = dims(p).w / 2;
    return W < half * 2 ? W / 2 : clamp(x, half, W - half);
  }
  const feetY = (p) => groundY + p.lane * S;

  // --- Scenery --------------------------------------------------------------

  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Draw the scenery once (per size/scene/theme) at one unit = S pixels. */
  function drawScene() {
    bgDecor = { stars: [], flies: [], waves: 0 };
    if (scene === "none") { bg = null; return; }
    const cols = Math.ceil(W / S), rowsN = Math.ceil(H / S);
    const top = rowsN - GROUND[scene];
    bg = document.createElement("canvas");
    bg.width = cols; bg.height = rowsN;
    const c = /** @type {CanvasRenderingContext2D} */ (bg.getContext("2d"));
    const rnd = seeded(scene.length * 977 + 13);
    const px = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); };
    const dim = (color) => (isDark() && scene !== "night" ? mix(color, "#1b2236", 0.18) : color);
    const sky = (from, to) => {
      const bands = 7;
      for (let i = 0; i < bands; i++) {
        const y0 = Math.floor((top * i) / bands), y1 = Math.floor((top * (i + 1)) / bands);
        px(0, y0, cols, y1 - y0, dim(mix(from, to, i / (bands - 1))));
      }
    };
    const cloud = (x, y, s) => {
      const white = dim("#ffffff"), shade = dim("#dcecf7");
      px(x + s, y, s * 3, s, white);
      px(x, y + s, s * 5, s, white);
      px(x + s * 0.5, y + s * 2 - 1, s * 4, 1, shade);
    };
    const hills = (base, amp, freq, phase, color) => {
      for (let x = 0; x < cols; x++) {
        const h = Math.round(base + amp * Math.sin(x * freq + phase) + amp * 0.5 * Math.sin(x * freq * 2.3 + phase * 1.7));
        px(x, top - h, 1, h, dim(color));
      }
    };

    if (scene === "forest") {
      sky("#7cc8f2", "#d9f2ff");
      const sunX = Math.round(cols * 0.82);
      for (let i = 0; i < Math.max(2, cols / 40); i++) cloud(Math.round(rnd() * (cols - 8)), 2 + Math.round(rnd() * Math.max(1, top * 0.25)), 2);
      px(sunX - 2, 3, 5, 5, dim("#fff3b0")); px(sunX - 1, 2, 3, 7, dim("#fff3b0")); px(sunX - 3, 4, 7, 3, dim("#fff3b0"));
      hills(Math.min(14, top * 0.45), 3, 0.06, rnd() * 6, "#9fd99a");
      // Trees: pines and round ones, behind the near hills.
      const trees = Math.max(2, Math.floor(cols / 14));
      for (let i = 0; i < trees; i++) {
        const x = Math.round(((i + rnd() * 0.8) * cols) / trees);
        const tall = Math.round(clamp(top * 0.5, 8, 18) + rnd() * 5);
        if (rnd() < 0.6) {
          const green = pick(["#2f8f4e", "#2a7f46", "#37995a"]);
          px(x, top - 3, 1, 3, dim("#6b4a2b"));
          for (let t = 0; t < tall - 2; t++) {
            const half = Math.floor((t % 4) + t / 3) / 1.6;
            px(x - half, top - tall + t, half * 2 + 1, 1, dim(t % 4 === 0 ? mix(green, "#ffffff", 0.15) : green));
          }
        } else {
          const r = Math.round(3 + rnd() * 2);
          const green = pick(["#4caf50", "#43a047", "#5cbf60"]);
          px(x, top - 5, 1, 5, dim("#7a5230"));
          for (let dy = -r; dy <= r; dy++) {
            const half = Math.round(Math.sqrt(r * r - dy * dy));
            px(x - half, top - 5 - r + dy, half * 2 + 1, 1, dim(dy < -r / 2 ? mix(green, "#ffffff", 0.18) : green));
          }
        }
      }
      hills(3, 1.5, 0.11, rnd() * 6, "#6cc070");
      // Grass.
      px(0, top, cols, rowsN - top, dim("#4caf50"));
      px(0, top, cols, 1, dim("#7fd36a"));
      for (let x = 0; x < cols; x++) {
        if (rnd() < 0.25) px(x, top - 1, 1, 1, dim("#7fd36a"));
        if (rnd() < 0.12) px(x, top + 2 + Math.floor(rnd() * (rowsN - top - 2)), 1, 1, dim("#3d9442"));
        if (rnd() < 0.04) {
          px(x, top - 2, 1, 1, dim(pick(["#ffef6b", "#ff8fb1", "#ffffff", "#b18cff"])));
          px(x, top - 1, 1, 1, dim("#2f8a3a"));
        }
      }
    } else if (scene === "beach") {
      sky("#6cc4f5", "#e6f8ff");
      const sunX = Math.round(cols * 0.2);
      px(sunX - 4, 2, 9, 9, dim("#fff1b3")); px(sunX - 5, 3, 11, 7, dim("#fff1b3"));
      px(sunX - 3, 3, 7, 7, dim("#ffd84d")); px(sunX - 4, 4, 9, 5, dim("#ffd84d"));
      for (let i = 0; i < Math.max(1, cols / 50); i++) cloud(Math.round(cols * 0.35 + rnd() * cols * 0.5), 3 + Math.round(rnd() * 4), 2);
      // The sea.
      const seaTop = top - Math.max(5, Math.min(12, Math.round(top * 0.3)));
      px(0, seaTop, cols, top - seaTop, dim("#2d8fd5"));
      px(0, seaTop, cols, 1, dim("#7fd0ff"));
      for (let y = seaTop + 2; y < top; y += 2) for (let x = 0; x < cols; x++) if (rnd() < 0.07) px(x, y, 2, 1, dim("#5ab0ea"));
      bgDecor.waves = seaTop;
      // Sand.
      px(0, top, cols, rowsN - top, dim("#f2d38c"));
      px(0, top, cols, 1, dim("#fbe6b0"));
      for (let x = 0; x < cols; x++) {
        if (rnd() < 0.18) px(x, top + 1 + Math.floor(rnd() * (rowsN - top - 1)), 1, 1, dim("#dcb66a"));
        if (rnd() < 0.02) { px(x, top + 3, 2, 1, dim("#ffffff")); px(x, top + 4, 2, 1, dim("#ffc2cf")); }
      }
      // A starfish.
      const sx = Math.round(cols * 0.6), sy = top + 4;
      if (sy + 2 < rowsN) { px(sx, sy - 1, 1, 3, dim("#ff8a5c")); px(sx - 1, sy, 3, 1, dim("#ff8a5c")); px(sx - 1, sy + 1, 1, 1, dim("#ff8a5c")); px(sx + 1, sy + 1, 1, 1, dim("#ff8a5c")); }
      // A palm tree.
      if (cols > 50) {
        const x0 = Math.round(cols * 0.86);
        const tall = clamp(Math.round(top * 0.7), 10, 30);
        for (let t = 0; t < tall; t++) {
          const x = x0 + Math.round(Math.sin((t / tall) * 1.4) * 3);
          px(x, top - t, 2, 1, dim(t % 3 === 0 ? "#7a5230" : "#a0703f"));
        }
        const tx = x0 + Math.round(Math.sin(1.4) * 3), ty = top - tall;
        for (const [dx, dy] of [[-1, 0], [1, 0], [-0.7, 0.45], [0.7, 0.45], [0, -0.2]]) {
          for (let i = 0; i < 8; i++) {
            const fx = tx + dx * i, fy = ty + dy * i + (i * i) / 14;
            px(fx, fy, 2, 1, dim(i < 4 ? "#3f9e4a" : "#4fb85a"));
          }
        }
        px(tx, ty + 1, 2, 2, dim("#6b4a2b"));
      }
    } else if (scene === "night") {
      sky("#0b1030", "#2b3170");
      for (let i = 0; i < cols * top * 0.012; i++) {
        bgDecor.stars.push({ x: Math.floor(rnd() * cols), y: Math.floor(rnd() * (top - 6)), phase: rnd() * 6.28, big: rnd() < 0.12 });
      }
      const mx = Math.round(cols * 0.78), my = 7, r = 4;
      for (let dy = -r; dy <= r; dy++) {
        const half = Math.round(Math.sqrt(r * r - dy * dy));
        px(mx - half, my + dy, half * 2 + 1, 1, "#fff2c2");
      }
      for (let dy = -r; dy <= r; dy++) {
        const half = Math.round(Math.sqrt(r * r - dy * dy));
        px(mx - half + 3, my + dy - 1, half * 2 + 1, 1, mix("#0b1030", "#2b3170", (my + dy - 1) / top));
      }
      hills(Math.min(12, top * 0.4), 3, 0.05, rnd() * 6, "#1b2350");
      hills(4, 2, 0.09, rnd() * 6, "#18223f");
      px(0, top, cols, rowsN - top, "#1c3b2e");
      px(0, top, cols, 1, "#2f5c43");
      for (let x = 0; x < cols; x++) {
        if (rnd() < 0.2) px(x, top - 1, 1, 1, "#2f5c43");
        if (rnd() < 0.1) px(x, top + 2 + Math.floor(rnd() * (rowsN - top - 2)), 1, 1, "#16301f");
      }
      for (let i = 0; i < Math.max(3, cols / 25); i++) bgDecor.flies.push({ x: rnd() * cols, y: top - 3 - rnd() * top * 0.4, phase: rnd() * 6.28, speed: rand(0.3, 0.8) });
    }
    bgDecor.top = top;
    bgDecor.rows = rowsN;
  }

  function drawSceneLayer() {
    if (!bg) {
      // A faint floor line so the pets have something to stand on.
      ctx.fillStyle = isDark() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";
      ctx.fillRect(0, groundY + S, W, H - groundY - S);
      return;
    }
    const offsetY = H - bg.height * S;
    ctx.drawImage(bg, 0, offsetY, bg.width * S, bg.height * S);
    const unit = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x) * S, offsetY + Math.round(y) * S, w * S, h * S); };
    if (scene === "night") {
      for (const star of bgDecor.stars) {
        const twinkle = reduced ? 0.8 : 0.55 + 0.45 * Math.sin(clock * 1.8 + star.phase);
        ctx.globalAlpha = twinkle;
        unit(star.x, star.y, 1, 1, "#fffbe6");
        if (star.big && twinkle > 0.8) { unit(star.x - 1, star.y, 3, 1, "#fffbe6"); unit(star.x, star.y - 1, 1, 3, "#fffbe6"); }
      }
      for (const fly of bgDecor.flies) {
        const t = reduced ? 0 : clock * fly.speed;
        const x = fly.x + Math.sin(t + fly.phase) * 6, y = fly.y + Math.sin(t * 1.7 + fly.phase) * 2;
        const glow = reduced ? 0.7 : 0.4 + 0.6 * Math.max(0, Math.sin(clock * 2.2 + fly.phase * 3));
        ctx.globalAlpha = glow * 0.25;
        unit(x - 1, y, 3, 1, "#e8ff8a");
        unit(x, y - 1, 1, 3, "#e8ff8a");
        ctx.globalAlpha = glow;
        unit(x, y, 1, 1, "#f6ffb8");
      }
      ctx.globalAlpha = 1;
    } else if (scene === "beach" && bgDecor.waves) {
      const shift = reduced ? 0 : Math.floor(clock * 4);
      ctx.globalAlpha = 0.85;
      for (let x = -12; x < bg.width + 12; x += 12) unit(x + (shift % 12), bgDecor.waves + 1, 4, 1, "#d8f3ff");
      for (let x = -16; x < bg.width + 16; x += 16) unit(x + 8 - ((shift >> 1) % 16), bgDecor.top - 1, 6, 1, "#ffffff");
      ctx.globalAlpha = 1;
    }
  }

  // --- Pets -----------------------------------------------------------------

  function makePet(info, index, fromAbove) {
    const pos = saved.pos && saved.pos[info.id];
    const p = {
      id: info.id, type: info.type, color: info.color, name: info.name,
      x: 0, y: 0, vy: 0, dir: Math.random() < 0.5 ? -1 : 1, lane: index % 3,
      state: "idle", t: rand(1, 3), anim: Math.random() * 10, blink: 0, nextBlink: rand(2, 5),
      label: 0, bubble: null, zTimer: 0, dustTimer: 0, target: 0, after: "idle", hopPhase: 0, carrying: false,
    };
    p.x = clampX(p, pos ? pos.x : rand(0, W));
    if (pos) p.dir = pos.dir;
    if (fromAbove) {
      p.y = Math.min(H * 0.7, 160);
      p.state = "fall";
    }
    return p;
  }

  function setState(p, state, time) {
    p.state = state;
    p.t = time !== undefined ? time : 0;
    p.anim = 0;
  }

  function say(p, text, time) {
    p.bubble = { text, t: time || 2 };
  }

  function emit(kind, x, y, extra) {
    if (reduced && (kind === "dust")) return;
    particles.push(Object.assign({ kind, x, y, vx: 0, vy: 0, life: 1, max: 1 }, extra || {}));
  }

  function hearts(x, y, count) {
    for (let i = 0; i < count; i++) emit("heart", x + rand(-4, 4) * S / 3, y, { vx: rand(-10, 10), vy: rand(-28, -18), life: 1.4 + i * 0.15, max: 1.4 + i * 0.15 });
  }
  function sparks(x, y, count) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      emit("spark", x, y, { vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 20, life: 0.6, max: 0.6 });
    }
  }

  function headPoint(p) {
    const d = dims(p);
    const mouth = types[p.type].mouth;
    const facing = types[p.type].noFlip ? 1 : p.dir;
    const mx = (mouth[0] + 1) * S - d.w / 2;
    return { x: p.x + mx * facing, y: feetY(p) - p.y - d.h + (mouth[1] + 1) * S };
  }

  function speedOf(p) {
    return types[p.type].speed * (S / 3) * (reduced ? 0.55 : 1);
  }

  function chooseNext(p) {
    const r = Math.random();
    const from = p.state;
    if (ball && !ball.heldBy && ball.resting > 3 && Math.random() < 0.15 && from !== "sleep") {
      setState(p, "nudge", 8);
      return;
    }
    if (from === "sleep") {
      if (r < 0.6) setState(p, "sit", rand(2, 4)); else setState(p, "idle", rand(1, 3));
    } else if (from === "walk") {
      if (r < 0.45) setState(p, "idle", rand(1.5, 4));
      else if (r < 0.7) setState(p, "sit", rand(3, 8));
      else { p.dir = -p.dir; setState(p, "walk", rand(2, 6)); }
    } else if (from === "sit") {
      if (r < 0.35) setState(p, "sleep", rand(10, 25));
      else if (r < 0.7) setState(p, "idle", rand(1, 3));
      else setState(p, "walk", rand(2, 6));
    } else {
      if (r < 0.55) { if (Math.random() < 0.5) p.dir = -p.dir; setState(p, "walk", rand(3, 8)); }
      else if (r < 0.75) setState(p, "sit", rand(3, 8));
      else if (r < 0.85) setState(p, "sleep", rand(8, 20));
      else if (r < 0.93 && !reduced) jump(p, "idle");
      else setState(p, "idle", rand(1.5, 3));
    }
  }

  function jump(p, after, power) {
    p.after = after || "idle";
    p.vy = (power || 1) * 210 * Math.sqrt(S / 3) * (reduced ? 0.6 : 1);
    p.y = Math.max(p.y, 0.01);
    setState(p, "jump", 0);
  }

  function walkTowards(p, x, speed, dt) {
    const dx = x - p.x;
    if (Math.abs(dx) < 1) return true;
    p.dir = dx > 0 ? 1 : -1;
    p.x = clampX(p, p.x + p.dir * Math.min(Math.abs(dx), speed * dt));
    return Math.abs(x - p.x) < 1.5 || clampX(p, x) === p.x;
  }

  function updatePet(p, dt) {
    p.anim += dt;
    if (p.label > 0) p.label -= dt;
    if (p.bubble && (p.bubble.t -= dt) <= 0) p.bubble = null;
    if (p.blink > 0) p.blink -= dt;
    else if ((p.nextBlink -= dt) <= 0) { p.blink = 0.14; p.nextBlink = rand(2, 6); }

    // Airborne: falling in, or a jump.
    if (p.state === "fall" || p.state === "jump" || p.y > 0) {
      p.vy -= 900 * Math.sqrt(S / 3) * dt;
      p.y += p.vy * dt;
      if (p.state === "jump" && p.vx) p.x = clampX(p, p.x + p.vx * dt);
      if (p.y <= 0) {
        p.y = 0; p.vy = 0; p.vx = 0;
        if (p.state === "fall") {
          sparks(p.x, feetY(p) - 2, 6);
          p.label = 2.5;
          hearts(headPoint(p).x, headPoint(p).y - 4 * S, 1);
          setState(p, "idle", rand(1, 2));
        } else if (p.state === "jump") {
          const after = p.after;
          if (after === "carry") setState(p, "carry", 10);
          else if (after === "chase") setState(p, "chase", 10);
          else setState(p, after, after === "sit" ? rand(3, 6) : rand(1, 3));
        }
      }
      if (p.state === "fall" || p.state === "jump") return;
    }

    const speed = speedOf(p);
    switch (p.state) {
      case "walk": {
        p.x += p.dir * speed * dt * (types[p.type].hop ? 1.2 : 1);
        const cx = clampX(p, p.x);
        if (cx !== p.x) { p.x = cx; p.dir = -p.dir; }
        break;
      }
      case "chase": {
        if (!ball || ball.heldBy) { setState(p, Math.random() < 0.5 ? "sit" : "idle", rand(2, 4)); break; }
        const reach = dims(p).w * 0.35;
        const mouthDx = headPoint(p).x - p.x;
        const target = ball.x - mouthDx;
        walkTowards(p, target, speed * 2.4, dt);
        if (!reduced && (p.dustTimer -= dt) <= 0) { p.dustTimer = 0.12; emit("dust", p.x - p.dir * dims(p).w * 0.35, feetY(p) - S, { vx: -p.dir * 15, vy: -8, life: 0.45, max: 0.45 }); }
        const low = ball.y > feetY(p) - dims(p).h * 0.9;
        if (Math.abs(ball.x - headPoint(p).x) < reach + ball.r && low) catchBall(p);
        if (p.t > 0 && (p.t -= dt) <= 0) setState(p, "idle", rand(1, 2));
        return;
      }
      case "carry": {
        if (!ball || ball.heldBy !== p) { setState(p, "idle", 1); break; }
        const home = clampX(p, ball.origin);
        if (walkTowards(p, home, speed * 1.3, dt)) {
          dropBall(p);
          setState(p, "sit", rand(3, 6));
          hearts(headPoint(p).x, headPoint(p).y - 3 * S, 2);
          say(p, pick(types[p.type].sounds), 1.6);
        }
        return;
      }
      case "nudge": {
        if (!ball || ball.heldBy) { setState(p, "idle", 1); break; }
        const behind = ball.x - p.dir * (dims(p).w * 0.3 + ball.r);
        const target = Math.abs(ball.x - p.x) < 2 ? ball.x - p.dir * 4 : behind;
        walkTowards(p, target, speed * 1.2, dt);
        if (Math.abs(headPoint(p).x - ball.x) < ball.r + S * 2) {
          p.dir = ball.x >= p.x ? 1 : -1;
          kickBall(p.dir * rand(120, 220) * Math.sqrt(S / 3), -rand(140, 260) * Math.sqrt(S / 3), p.x);
          jump(p, "chase", 0.6);
          for (const other of pets) if (other !== p && other.state !== "sleep" && Math.random() < 0.5) setState(other, "chase", 10);
          return;
        }
        if ((p.t -= dt) <= 0) setState(p, "idle", 1);
        return;
      }
      case "greet":
        break;
    }
    if (p.state === "sleep" && (p.zTimer -= dt) <= 0) {
      p.zTimer = reduced ? 2.4 : 1.3;
      const head = headPoint(p);
      emit("z", head.x, head.y - 4 * S, { vx: p.dir * 6 + rand(-2, 2), vy: -14, life: 2.6, max: 2.6 });
    }
    if ((p.t -= dt) <= 0) chooseNext(p);
  }

  function catchBall(p) {
    if (!ball || ball.heldBy) return;
    ball.heldBy = p;
    ball.resting = 0;
    const losers = pets.filter((other) => other !== p && other.state === "chase");
    for (const other of losers) setState(other, Math.random() < 0.6 ? "idle" : "sit", rand(1.5, 4));
    // One of the others is a bit put out.
    if (losers.length && Math.random() < 0.7) say(pick(losers), pick(["aww", "next time!", "no fair"]), 1.3);
    jump(p, "carry", 0.7);
  }

  function dropBall(p) {
    if (!ball) return;
    const head = headPoint(p);
    ball.heldBy = null;
    ball.x = clamp(head.x + p.dir * 2 * S, ball.r, W - ball.r);
    ball.y = head.y;
    ball.vx = p.dir * 40;
    ball.vy = -60;
    ball.resting = 0;
  }

  function kickBall(vx, vy, originX) {
    if (!ball) return;
    ball.heldBy = null;
    ball.vx = vx; ball.vy = vy; ball.resting = 0;
    ball.origin = originX;
  }

  function throwBall(x, y, vx, vy) {
    const r = 3.5 * S;
    ball = { x: clamp(x, r, W - r), y: Math.min(y, groundY - r), vx, vy, r, heldBy: null, resting: 0, origin: clamp(x, 0, W), spin: 0 };
    for (const p of pets) {
      if (p.state === "fall") continue;
      if (p.state === "sleep") {
        if (Math.random() < 0.45) { say(p, "!", 0.8); jump(p, "chase", 0.5); }
        continue;
      }
      setState(p, "chase", 10);
      if (Math.random() < 0.2) say(p, "!", 0.8);
    }
  }

  function throwFromSide() {
    if (!W) return;
    const fromLeft = Math.random() < 0.5;
    const speed = rand(220, 340) * Math.sqrt(S / 3);
    throwBall(fromLeft ? 8 : W - 8, Math.max(10, groundY - H * 0.6), (fromLeft ? 1 : -1) * speed, -rand(120, 260));
    ball.origin = W / 2;
  }

  function updateBall(dt) {
    if (!ball) return;
    if (ball.heldBy) {
      const p = ball.heldBy;
      if (!pets.includes(p)) { ball.heldBy = null; return; }
      const head = headPoint(p);
      ball.x = head.x + p.dir * S;
      ball.y = head.y + S;
      return;
    }
    if (pointer && pointer.dragBall) return;
    const floor = groundY + S - ball.r;
    ball.vy += 1100 * Math.sqrt(S / 3) * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.spin += ball.vx * dt / ball.r;
    if (ball.x < ball.r) { ball.x = ball.r; ball.vx = Math.abs(ball.vx) * 0.7; }
    if (ball.x > W - ball.r) { ball.x = W - ball.r; ball.vx = -Math.abs(ball.vx) * 0.7; }
    if (ball.y < ball.r) { ball.y = ball.r; ball.vy = Math.abs(ball.vy) * 0.5; }
    if (ball.y >= floor) {
      ball.y = floor;
      if (Math.abs(ball.vy) > 70) ball.vy = -ball.vy * 0.55;
      else ball.vy = 0;
      ball.vx *= Math.max(0, 1 - 2.2 * dt);
      if (Math.abs(ball.vx) < 4 && ball.vy === 0) { ball.vx = 0; ball.resting += dt; }
    }
  }

  function updateGreetings(dt) {
    for (let i = 0; i < pets.length; i++) for (let j = i + 1; j < pets.length; j++) {
      const a = pets[i], b = pets[j];
      if (!["walk", "idle"].includes(a.state) || !["walk", "idle"].includes(b.state)) continue;
      if (a.state === "idle" && b.state === "idle") continue;
      const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
      if ((greeted.get(key) || 0) > clock) continue;
      const near = (dims(a).w + dims(b).w) * 0.32;
      if (Math.abs(a.x - b.x) > near) continue;
      greeted.set(key, clock + rand(25, 45));
      a.dir = b.x >= a.x ? 1 : -1;
      b.dir = -a.dir;
      if (a.x === b.x) b.dir = -a.dir;
      setState(a, "greet", 1.8);
      setState(b, "greet", 1.8);
      const top = Math.min(headPoint(a).y, headPoint(b).y);
      hearts((a.x + b.x) / 2, top - 5 * S, 1);
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.life -= dt;
      if (q.life <= 0) { particles.splice(i, 1); continue; }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.kind === "spark") q.vy += 120 * dt;
      if (q.kind === "z") q.x += Math.sin(q.life * 3) * 4 * dt;
    }
  }

  // --- Drawing --------------------------------------------------------------

  function frameOf(p) {
    const a = p.anim;
    const flicker = (period) => (Math.floor(a / period) % 2 === 0 ? 1 : 2);
    switch (p.state) {
      case "walk": return { frame: "walk" + flicker(types[p.type].hop ? 0.22 : 0.18), eyes: p.blink > 0 ? "blink" : "open" };
      case "chase": {
        if (ball && !ball.heldBy && Math.abs(ball.x - p.x) < dims(p).w * 0.6 && ball.y < feetY(p) - dims(p).h) return { frame: "stand", eyes: "open" };
        return { frame: "run" + flicker(0.1), eyes: "open" };
      }
      case "nudge": return { frame: "walk" + flicker(0.14), eyes: "open" };
      case "carry": return { frame: "walk" + flicker(0.15), eyes: "happy" };
      case "sit": return { frame: "sit" + (flicker(1.1) === 1 ? "" : "2"), eyes: p.blink > 0 ? "blink" : "open" };
      case "sleep": return { frame: "sleep" + flicker(1.3), eyes: "open" };
      case "jump": case "fall": return { frame: "jump", eyes: "happy" };
      case "greet": return { frame: flicker(0.3) === 1 ? "stand" : "stand2", eyes: "happy" };
      default: return { frame: flicker(0.8) === 1 ? "stand" : "stand2", eyes: p.blink > 0 ? "blink" : "open" };
    }
  }

  function hopOffset(p) {
    if (!types[p.type].hop || (p.state !== "walk" && p.state !== "chase" && p.state !== "carry" && p.state !== "nudge")) return 0;
    const period = p.state === "chase" ? 0.36 : 0.44;
    const t = (p.anim % period) / period;
    return Math.sin(t * Math.PI) * 4 * S;
  }

  const snap = (v) => Math.round(v / S) * S;

  function drawPet(p) {
    const { frame, eyes } = frameOf(p);
    const flip = !types[p.type].noFlip && p.dir < 0;
    const img = sprite(p.type, p.color, frame, eyes, flip);
    const w = img.width * S, h = img.height * S;
    const lift = p.y + hopOffset(p);
    const left = snap(p.x - w / 2);
    const top = snap(feetY(p) - h - lift) + S;
    // Shadow.
    const shrink = clamp(1 - lift / (60 * S), 0.4, 1);
    ctx.fillStyle = scene === "night" || isDark() ? "rgba(0,0,0,0.32)" : "rgba(0,0,0,0.16)";
    const sw = Math.round((w * 0.62 * shrink) / S) * S;
    ctx.fillRect(snap(p.x - sw / 2), feetY(p), sw, S);
    ctx.drawImage(img, left, top, w, h);
    p.box = { x: left, y: top, w, h };
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  let font = "";
  /** A name tag or speech bubble; `placed` keeps them from covering each other. */
  function drawTag(text, cx, bottom, style, placed) {
    ctx.font = font;
    const pad = 5;
    const tw = Math.ceil(ctx.measureText(text).width);
    const w = tw + pad * 2, h = 17;
    const x = clamp(Math.round(cx - w / 2), 2, Math.max(2, W - w - 2));
    let y = Math.round(bottom - h);
    for (let tries = 0; tries < 6; tries++) {
      const hit = placed.find((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 3 && y + h + 3 > r.y);
      if (!hit) break;
      y = hit.y - h - 4;
    }
    y = Math.max(2, y);
    placed.push({ x, y, w, h });
    const dark = isDark();
    if (style === "bubble") {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#1d1a24";
    } else {
      ctx.fillStyle = dark ? "rgba(20,22,30,0.88)" : "rgba(255,255,255,0.94)";
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.2)";
    }
    ctx.lineWidth = 1;
    roundRect(x + 0.5, y + 0.5, w, h, 5);
    ctx.fill();
    ctx.stroke();
    if (style === "bubble") {
      const tx = clamp(Math.round(cx), x + 6, x + w - 6);
      ctx.beginPath();
      ctx.moveTo(tx - 4, y + h);
      ctx.lineTo(tx, y + h + 5);
      ctx.lineTo(tx + 3, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(tx - 4, y + h + 0.5);
      ctx.lineTo(tx, y + h + 5);
      ctx.lineTo(tx + 3, y + h + 0.5);
      ctx.stroke();
      ctx.fillStyle = "#1d1a24";
    } else {
      ctx.fillStyle = dark ? "#f2f2f5" : "#1d1d24";
    }
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + pad, y + h / 2 + 1);
  }

  function drawBall() {
    if (!ball) return;
    const img = icon("ball");
    const w = img.width * S, h = img.height * S;
    if (!ball.heldBy) {
      const height = groundY + S - (ball.y + ball.r);
      const shrink = clamp(1 - height / (80 * S), 0.3, 1);
      ctx.fillStyle = isDark() || scene === "night" ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.15)";
      const sw = Math.round((w * shrink) / S) * S;
      ctx.fillRect(snap(ball.x - sw / 2), groundY + S, sw, S);
    }
    ctx.drawImage(img, snap(ball.x - w / 2), snap(ball.y - h / 2), w, h);
  }

  function drawParticles() {
    for (const q of particles) {
      const fade = clamp(q.life / q.max, 0, 1);
      if (q.kind === "dust") {
        ctx.globalAlpha = fade * 0.6;
        ctx.fillStyle = scene === "beach" ? "#e6c47c" : isDark() ? "#9aa0ad" : "#c9c4ba";
        const s = Math.max(1, Math.round((1 + (1 - fade) * 1.5))) * S;
        ctx.fillRect(snap(q.x - s / 2), snap(q.y - s / 2), s, s);
      } else {
        const img = icon(q.kind);
        const grow = q.kind === "z" ? 0.6 + (1 - fade) * 0.6 : 1;
        const scale = Math.max(1, Math.round(S * grow * (q.kind === "spark" ? 0.67 : 0.8)));
        ctx.globalAlpha = q.kind === "z" ? Math.min(1, fade * 1.6) : Math.min(1, fade * 2);
        ctx.drawImage(img, Math.round(q.x - (img.width * scale) / 2), Math.round(q.y - (img.height * scale) / 2), img.width * scale, img.height * scale);
      }
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    drawSceneLayer();
    const order = [...pets].sort((a, b) => a.lane - b.lane);
    for (const p of order) drawPet(p);
    drawBall();
    drawParticles();
    const placed = [];
    // The hovered pet's tag first, so it's never pushed away.
    const tagged = [...pets].sort((a, b) => (b === hover ? 1 : 0) - (a === hover ? 1 : 0));
    for (const p of tagged) {
      if (!p.box) continue;
      if (p.bubble) drawTag(p.bubble.text, p.box.x + p.box.w / 2 + p.dir * p.box.w * 0.2, p.box.y - 6, "bubble", placed);
      else if (p === hover || p.label > 0) drawTag(p.name, p.box.x + p.box.w / 2, p.box.y - 3, "tag", placed);
    }
  }

  // --- Loop -----------------------------------------------------------------

  let raf = 0, last = 0, saveTimer = 0;
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    clock += dt;
    const sim = dt * (reduced ? 0.7 : 1);
    for (const p of pets) updatePet(p, sim);
    updateGreetings(sim);
    updateBall(sim);
    updateParticles(sim);
    draw();
    if ((saveTimer -= dt) <= 0) {
      saveTimer = 2;
      saved = { pos: Object.fromEntries(pets.map((p) => [p.id, { x: Math.round(p.x), dir: p.dir }])) };
      vscode.setState(saved);
    }
    schedule();
  }
  function schedule() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
    else { last = 0; schedule(); }
  });

  // --- Input ----------------------------------------------------------------

  function petAt(x, y) {
    for (let i = pets.length - 1; i >= 0; i--) {
      const b = pets[i].box;
      if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return pets[i];
    }
    return null;
  }
  function onBall(x, y) {
    return ball && !ball.heldBy && Math.hypot(x - ball.x, y - ball.y) < ball.r + 6;
  }

  stage.addEventListener("pointermove", (event) => {
    const x = event.offsetX, y = event.offsetY;
    if (pointer) {
      pointer.trail.push({ x, y, t: performance.now() });
      if (pointer.trail.length > 6) pointer.trail.shift();
      if (pointer.dragBall && ball) { ball.x = clamp(x, ball.r, W - ball.r); ball.y = clamp(y, ball.r, groundY + S - ball.r); ball.vx = 0; ball.vy = 0; }
    }
    hover = petAt(x, y);
    stage.style.cursor = hover || onBall(x, y) ? "pointer" : "default";
  });
  stage.addEventListener("pointerleave", () => { hover = null; });
  stage.addEventListener("pointerdown", (event) => {
    const x = event.offsetX, y = event.offsetY;
    stage.setPointerCapture(event.pointerId);
    const pet = petAt(x, y);
    pointer = { x, y, pet, dragBall: !pet && onBall(x, y), trail: [{ x, y, t: performance.now() }] };
  });
  stage.addEventListener("pointerup", (event) => {
    if (!pointer) return;
    const x = event.offsetX, y = event.offsetY;
    const start = pointer;
    pointer = null;
    const first = start.trail[0], lastPoint = start.trail[start.trail.length - 1];
    const span = Math.max(16, (lastPoint.t - first.t)) / 1000;
    const vx = clamp((lastPoint.x - first.x) / span, -900, 900);
    const vy = clamp((lastPoint.y - first.y) / span, -900, 900);
    if (start.dragBall && ball) {
      throwBall(ball.x, ball.y, vx, vy);
      return;
    }
    if (start.pet) {
      const p = start.pet;
      if (p.state === "sleep") { say(p, "!?", 1); p.blink = 0; }
      else if (Math.random() < 0.6) say(p, pick(types[p.type].sounds), 1.6);
      if (p.state !== "jump" && p.state !== "fall") jump(p, p.state === "chase" || p.state === "carry" ? p.state : "idle", reduced ? 0.6 : 1);
      hearts(headPoint(p).x, p.box ? p.box.y : headPoint(p).y, 2);
      p.label = 1.5;
      return;
    }
    const moved = Math.hypot(x - start.x, y - start.y);
    if (moved > 12) throwBall(start.x, start.y, vx, vy);
    else throwBall(x, y, rand(-1, 1) * 160 * Math.sqrt(S / 3), -rand(180, 320) * Math.sqrt(S / 3));
  });
  stage.addEventListener("dblclick", (event) => {
    const pet = petAt(event.offsetX, event.offsetY);
    if (pet) vscode.postMessage({ type: "rename", id: pet.id });
  });
  document.addEventListener("click", (event) => {
    const button = /** @type {HTMLElement | null} */ (event.target instanceof Element ? event.target.closest("[data-command]") : null);
    if (!button) return;
    const command = button.getAttribute("data-command");
    if (command === "throw") throwFromSide();
    else vscode.postMessage({ type: "command", command });
  });

  // --- Messages from the plugin ---------------------------------------------

  function applyState(state) {
    const sceneChanged = state.scene !== scene || state.size !== size;
    scene = SCENE_OK(state.scene) ? state.scene : "none";
    size = PIXELS[state.size] ? state.size : "medium";
    if (sceneChanged) { spriteCache.clear(); resize(); }
    const incoming = (state.pets || []).filter((info) => types[info.type]);
    const byId = new Map(pets.map((p) => [p.id, p]));
    const next = [];
    incoming.forEach((info, index) => {
      const existing = byId.get(info.id);
      if (existing) {
        if (existing.name !== info.name) { existing.name = info.name; existing.label = 2.5; hearts(headPoint(existing).x, existing.box ? existing.box.y : groundY - 40, 1); }
        existing.color = info.color;
        existing.lane = index % 3;
        next.push(existing);
      } else {
        next.push(makePet(info, index, initialised));
      }
    });
    for (const old of pets) if (!next.includes(old)) {
      sparks(old.x, feetY(old) - dims(old).h / 2, 10);
      if (ball && ball.heldBy === old) ball.heldBy = null;
    }
    pets = next;
    if (pets.length === 0) ball = null;
    initialised = true;
    emptyNote.hidden = pets.length > 0;
    document.body.classList.toggle("has-pets", pets.length > 0);
  }
  const SCENE_OK = (name) => name === "none" || name === "forest" || name === "beach" || name === "night";
  let initialised = false;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "state") applyState(message);
    else if (message.type === "throwBall") {
      // Ignore throws queued up while the page wasn't showing.
      if (!message.at || Date.now() - message.at < 5000) throwFromSide();
    }
  });

  window.addEventListener("resize", resize);
  motionQuery.addEventListener("change", (event) => { reduced = event.matches; });
  font = "600 11px " + (getComputedStyle(document.body).fontFamily || "system-ui, sans-serif");
  resize();
  schedule();
  vscode.postMessage({ type: "ready" });

  // For tests: a sheet of every sprite, and a way to poke the simulation.
  /** @type {any} */ (window).__pets = {
    get pets() { return pets; },
    get ball() { return ball; },
    throwBall: throwFromSide,
    sheet(scale, only, frames) {
      const out = document.createElement("canvas");
      const names = frames || ["stand", "stand2", "walk1", "walk2", "run1", "run2", "sit", "sit2", "sleep1", "sleep2", "jump"];
      const cell = 26, ids = Object.keys(types);
      const rowsOut = [];
      for (const id of ids) for (const color of Object.keys(types[id].colors)) if (!only || only.includes(id) || only.includes(id + ":" + color)) rowsOut.push([id, color]);
      out.width = (names.length + 2) * cell * scale; out.height = rowsOut.length * (cell - 8) * scale;
      const c = /** @type {CanvasRenderingContext2D} */ (out.getContext("2d"));
      c.imageSmoothingEnabled = false;
      c.fillStyle = "#3a3f4b"; c.fillRect(0, 0, out.width, out.height);
      rowsOut.forEach(([id, color], r) => {
        [...names, "stand", "stand"].forEach((name, i) => {
          const img = sprite(id, color, name, i === names.length ? "blink" : i === names.length + 1 ? "happy" : "open", false);
          c.drawImage(img, i * cell * scale, r * (cell - 8) * scale, img.width * scale, img.height * scale);
        });
      });
      return out.toDataURL();
    },
  };
}
/* eslint-enable */

/** The page's HTML, for a sidebar view ("view") or an editor tab ("panel"). */
function pageHtml(mode) {
  const data = {
    mode,
    types: Object.fromEntries(
      Object.entries(TYPES).map(([id, type]) => [id, { sprites: type.sprites, colors: type.colors, speed: type.speed, hop: !!type.hop, noFlip: !!type.noFlip, mouth: type.mouth, sounds: type.sounds }]),
    ),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const icons = {
    add: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z" fill="currentColor"/></svg>',
    ball: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/><path d="M3.5 5.5c3 1.5 6 1.5 9 0M3.5 10.5c3-1.5 6-1.5 9 0" stroke="var(--tb-bg)" stroke-width="1.3" fill="none"/></svg>',
    scene: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 13l4.5-7 3 4.5L10.5 8 15 13z" fill="currentColor"/><circle cx="11.5" cy="4" r="1.6" fill="currentColor"/></svg>',
  };
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { height: 100%; }
  body {
    margin: 0; padding: 0 !important; overflow: hidden; user-select: none; -webkit-user-select: none;
    background: ${mode === "view" ? "var(--vscode-sideBar-background, var(--vscode-editor-background))" : "var(--vscode-editor-background)"};
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }
  canvas { position: fixed; inset: 0; display: block; touch-action: none; }
  #toolbar {
    --tb-bg: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.25));
    position: fixed; top: 6px; right: 6px; display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s ease;
  }
  body:hover #toolbar, #toolbar:focus-within, body:not(.has-pets) #toolbar { opacity: 1; }
  #toolbar button {
    display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--vscode-widget-border, transparent);
    background: var(--tb-bg); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  #toolbar button:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #toolbar button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  #empty {
    position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    text-align: center; padding: 16px; color: var(--vscode-descriptionForeground); pointer-events: none;
  }
  #empty[hidden] { display: none; }
  #empty p { margin: 0; }
  #empty button {
    pointer-events: auto; cursor: pointer; padding: 5px 12px; border-radius: 4px; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit;
  }
  #empty button:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<div id="toolbar" role="toolbar" aria-label="Pets">
  <button data-command="add" title="Add a pet" aria-label="Add a pet">${icons.add}</button>
  <button data-command="throw" title="Throw the ball" aria-label="Throw the ball">${icons.ball}</button>
  <button data-command="scenery" title="Change the scenery" aria-label="Change the scenery">${icons.scene}</button>
</div>
<div id="empty" hidden>
  <p>No pets here yet.</p>
  <button data-command="add">Add a pet</button>
</div>
<script>(${petsPage.toString()})(${json});</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

const VIEW_ID = "pets.view";
const PANEL_ID = "pets.panel";

/** @typedef {{ id: string; type: string; color: string; name: string }} Pet */

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const randomFrom = (list) => list[Math.floor(Math.random() * list.length)];

/** A name no other pet has, if possible. */
function randomName(type, taken) {
  const pool = [...(TYPES[type]?.names ?? []), ...COMMON_NAMES];
  const free = pool.filter((name) => !taken.includes(name));
  return randomFrom(free.length ? free : pool);
}

const describe = (pet) => `${pet.color} ${TYPES[pet.type]?.label.toLowerCase() ?? pet.type}`;

/** @param {Sable} sable */
export async function activate(sable) {
  /** @type {{ pets: Pet[]; scene: string; size: string }} */
  const stored = (await sable.storage.get("state")) ?? null;
  let pets = (stored?.pets ?? []).filter((pet) => TYPES[pet.type] && TYPES[pet.type].colors[pet.color]);
  let scene = stored && SCENES[stored.scene] ? stored.scene : "none";
  let size = stored && SIZES[stored.size] ? stored.size : "medium";
  if (!stored) {
    // A first pet, so the view isn't empty the first time it opens.
    pets = [{ id: newId(), type: "dog", color: "brown", name: randomName("dog", []) }];
    await save();
  }

  /** Webviews showing the pets (the sidebar view and the tab). */
  const open = new Set();

  function newId() {
    return `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async function save() {
    await sable.storage.set("state", { pets, scene, size });
  }

  const stateMessage = () => ({ type: "state", pets, scene, size });

  async function broadcast(message) {
    await Promise.all([...open].map((id) => sable.webview.postMessage(id, message).catch(() => false)));
  }

  /** After a change: remember it and show it in every open page. */
  async function changed() {
    await save();
    await broadcast(stateMessage());
  }

  /** Make sure the pets are visible somewhere (for commands run from the palette). */
  async function ensureVisible() {
    if (open.has(PANEL_ID)) return;
    await sable.views.reveal(VIEW_ID);
  }

  /** @param {string} id */
  const listener = (id) => async (event) => {
    if (event.type === "dispose") {
      open.delete(id);
      return;
    }
    const message = /** @type {any} */ (event.message);
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      open.add(id);
      await sable.webview.postMessage(id, stateMessage());
    } else if (message.type === "command" && typeof message.command === "string" && actions[message.command]) {
      await actions[message.command]();
    } else if (message.type === "rename" && typeof message.id === "string") {
      await renamePet(message.id);
    }
  };

  async function showWebview(id, mode) {
    await sable.webview.create(id, { title: "Pets", enableScripts: true, view: mode === "view" }, listener(id));
    open.add(id);
    await sable.webview.setHtml(id, pageHtml(mode));
  }

  async function pickPet(placeholder) {
    if (pets.length === 0) {
      await sable.window.showMessage("You have no pets yet. Run Pets: Add Pet… to get one.");
      return null;
    }
    if (pets.length === 1) return pets[0];
    const items = pets.map((pet) => ({ label: pet.name, description: describe(pet), pet }));
    const choice = await sable.window.showQuickPick(items, { placeholder });
    return choice ? choice.pet : null;
  }

  async function addPet() {
    const typeItems = Object.entries(TYPES).map(([id, type]) => ({ label: type.label, description: Object.keys(type.colors).join(", "), id }));
    const typeChoice = await sable.window.showQuickPick(typeItems, { placeholder: "Which pet?" });
    if (!typeChoice) return;
    const type = TYPES[typeChoice.id];
    const colors = Object.keys(type.colors);
    let color = colors[0];
    if (colors.length > 1) {
      const colorChoice = await sable.window.showQuickPick(colors.map((name) => ({ label: capitalise(name), name })), { placeholder: `What colour of ${type.label.toLowerCase()}?` });
      if (!colorChoice) return;
      color = colorChoice.name;
    }
    const suggestion = randomName(typeChoice.id, pets.map((pet) => pet.name));
    const typed = await sable.window.showInputBox({ prompt: `Name your ${type.label.toLowerCase()}`, placeholder: suggestion, value: suggestion });
    if (typed === null) return;
    const name = typed.trim().slice(0, 40) || suggestion;
    pets = [...pets, { id: newId(), type: typeChoice.id, color, name }];
    await changed();
    await ensureVisible();
    await sable.window.showMessage(`${name} the ${type.label.toLowerCase()} joined your pets`);
  }

  async function removePet() {
    const pet = await pickPet("Which pet should go home?");
    if (!pet) return;
    pets = pets.filter((other) => other.id !== pet.id);
    await changed();
    await sable.window.showMessage(`${pet.name} went home. Bye, ${pet.name}!`);
  }

  async function removeAll() {
    if (pets.length === 0) return sable.window.showMessage("There are no pets to remove");
    const yes = `Remove all ${pets.length} pet${pets.length === 1 ? "" : "s"}`;
    const choice = await sable.window.showQuickPick([yes, "Cancel"], { placeholder: "Send every pet home?" });
    if (choice !== yes) return;
    pets = [];
    await changed();
    await sable.window.showMessage("All your pets went home");
  }

  async function renamePet(id) {
    const pet = id ? pets.find((candidate) => candidate.id === id) : await pickPet("Which pet should get a new name?");
    if (!pet) return;
    const typed = await sable.window.showInputBox({ prompt: `A new name for ${pet.name} (${describe(pet)})`, value: pet.name });
    if (typed === null || !typed.trim() || typed.trim() === pet.name) return;
    const name = typed.trim().slice(0, 40);
    pets = pets.map((other) => (other.id === pet.id ? { ...other, name } : other));
    await changed();
  }

  async function throwBall() {
    if (pets.length === 0) return sable.window.showMessage("There's no one to play with. Run Pets: Add Pet… first.");
    await ensureVisible();
    await broadcast({ type: "throwBall", at: Date.now() });
  }

  async function chooseScenery() {
    const items = Object.entries(SCENES).map(([id, label]) => ({ label: label.split(" — ")[0], description: (id === scene ? "current · " : "") + (label.split(" — ")[1] ?? ""), id }));
    const choice = await sable.window.showQuickPick(items, { placeholder: "Scenery for your pets" });
    if (!choice) return;
    scene = choice.id;
    await changed();
  }

  async function chooseSize() {
    const items = Object.entries(SIZES).map(([id, label]) => ({ label, description: id === size ? "current" : "", id }));
    const choice = await sable.window.showQuickPick(items, { placeholder: "How big should your pets be?" });
    if (!choice) return;
    size = choice.id;
    await changed();
  }

  async function startSession() {
    if (open.has(PANEL_ID)) return sable.webview.reveal(PANEL_ID);
    await showWebview(PANEL_ID, "panel");
  }

  /** @type {Record<string, () => Promise<unknown>>} */
  const actions = {
    add: addPet,
    remove: removePet,
    removeAll,
    throw: throwBall,
    rename: () => renamePet(""),
    scenery: chooseScenery,
    size: chooseSize,
    session: startSession,
    show: () => sable.views.reveal(VIEW_ID),
  };

  await sable.views.declare([{ id: VIEW_ID, name: "Pets", kind: "webview" }], async (request) => {
    if (request.op === "resolve" && request.viewId === VIEW_ID) await showWebview(VIEW_ID, "view");
    return [];
  });

  sable.commands.register("add", "Add Pet…", addPet);
  sable.commands.register("remove", "Remove Pet…", removePet);
  sable.commands.register("removeAll", "Remove All Pets", removeAll);
  sable.commands.register("throw", "Throw Ball", throwBall);
  sable.commands.register("rename", "Rename Pet…", actions.rename);
  sable.commands.register("scenery", "Change Scenery…", chooseScenery);
  sable.commands.register("size", "Pet Size…", chooseSize);
  sable.commands.register("session", "Start Pet Coding Session", startSession);
  sable.commands.register("show", "Show Pets", actions.show);
}

export function deactivate() {}

// For tests (not part of the plugin API).
export const _internals = { TYPES, SCENES, SIZES, pageHtml };
