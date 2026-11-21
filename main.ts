// Push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121 bounty.
//
// Strategy
// --------
// Scoring is a cliff: a level solved in the push-optimal count P* earns 1000
// points; a single extra push drops it below 500. So the solver must minimise
// *pushes*, not moves. That means searching in push space, not move space:
//
//   * A state is the boxes' squares plus the player's reachable region
//     (named by its lowest square). A step that only walks costs nothing;
//     only a push advances the search by one.
//   * The search is breadth-first over pushes, so the first solved state
//     found is push-optimal. No clock is read anywhere: the only budget is
//     a count of states, so two runs are byte-identical.
//   * Two prunings that never cut a solvable state:
//       - a box on a "dead" square (no sequence of pushes, ignoring other
//         boxes, can bring it to a goal) is discarded;
//       - a box pushed into a frozen 2x2 block of walls/boxes with a box
//         off its goal is discarded.
//   * Levels are solved room by room. The generator's levels are a hallway
//     with 1-4 rooms off it; a box pushed out of a room can never come back,
//     so each room is independent and the level optimum is the sum of the
//     rooms' optima. The rooms are found by cutting the hallway's dead
//     squares out of the floor and taking the connected components that
//     hold boxes. Solving rooms separately turns a hopeless product of
//     state spaces into a few small searches (3-4 boxes each).
//
// Local run:
//   mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input \
//     MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Node 22 runs this file as-is (erasable TypeScript only, no imports beyond
// node built-ins, nothing installed, no network, no clock, no randomness).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Most states one push search keeps before it gives up (work, never time). */
const MAX_STATES = 250_000;
/** Second-chance budget for a room the first pass could not solve. */
const MAX_STATES_RETRY = 1_000_000;

/** [dx, dy, walk letter]. Fixed order everywhere, so ties break the same way. */
const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  /** 1 = wall. Short rows and the outer frame count as walls. */
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Squares from which a box alone can be pushed onto some goal: start at the
 * goals and pull backwards. A square y is live when pushing a box from y to
 * a live square x is possible, i.e. y and the player's stand y-d are open.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const behind = y - d;
      if (behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares reachable from `from` with `occupied` in the way.
 * Marks them in `seen` with `stamp` and returns the lowest such square,
 * which names the whole region: two player positions in one region are the
 * same state for push purposes.
 */
function reachable(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** A box just pushed to `t` is frozen if it sits in a 2x2 block of walls and
 *  boxes that holds a box off its goal: no push can ever move such a block. */
function frozenBlock(
  level: Level,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= wall.length) continue;
    const cells = [a, a + 1, a + w, a + w + 1];
    let solid = true;
    let bad = false;
    for (const c of cells) {
      if (!(wall[c] || occupied[c])) {
        solid = false;
        break;
      }
      if (occupied[c] && !goal[c]) bad = true;
    }
    if (solid && bad) return true;
  }
  return false;
}

/**
 * Push-optimal solution for one (sub-)level: {pushes, moves} with moves in
 * lower-case LURD, or null when the state budget runs out or it is unsolvable.
 * Breadth-first over pushes, so the first solved state is optimal.
 */
function solvePushOptimal(
  level: Level,
  maxStates: number,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // Numeric state keys are exact while size ** (boxes + 1) < 2 ** 53, which
  // holds for rooms (at most 4 boxes); fall back to strings for big levels.
  const numericKey = level.boxes.length <= 4;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKey) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const boxesList: number[][] = [level.boxes];
  const playerList: number[] = [level.player];
  const parent: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reachable(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow), 0);

  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < boxesList.length; head++) {
    const boxes = boxesList[head]!;
    for (const b of boxes) occupied[b] = 1;
    reachable(level, occupied, playerList[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        const from = b - d;
        if (t < 0 || t >= size || from < 0 || from >= size) continue;
        if (seen[from] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reachable(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || index.has(key)) continue;
        if (boxesList.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, boxesList.length);
        boxesList.push(next);
        playerList.push(b); // after the push the player stands on b's old square
        parent.push(head);
        if (solved(next)) {
          found = boxesList.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: for each push in the path, walk to the pushing square
  // (shortest walk, boxes as obstacles), then take the push step.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = boxesList[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS.find(([dx, dy]) => dy * w + dx === d)![2];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes (lower LURD). */
function walkTo(
  level: Level,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player ends on after `moves` (case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the hallway row's dead squares (a box there can
 * reach no goal) out of the floor; each remaining component that holds a box
 * is a room. Null when the level does not split cleanly (a box in the
 * hallway, a goal outside any component, or a component whose boxes and
 * goals do not match) — then the caller falls back to a whole-level search.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve a level room by room: each room's boxes are solved with the other
 * rooms' boxes standing as walls (on their goals once done), the player
 * walking on from where the last room left it. A box never leaves its room,
 * so the rooms' optima add up to the level's. Falls back to a whole-level
 * search when the level does not split into rooms.
 */
function solveLevel(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, MAX_STATES);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = solvePushOptimal(sub, MAX_STATES);
    if (solved === null) solved = solvePushOptimal(sub, MAX_STATES_RETRY);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

for (const id of readdirSync(I).sort()) {
  const text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  const solved = solveLevel(parseLevel(text));
  const moves = solved === null ? '' : solved.moves;
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
