# Sokoban solver

Push-optimal Sokoban solver, built for make.fun's
"Build the best Sokoban solver, 21 November 2026" bounty.

`main.ts` (Node 22, no dependencies) reads every level in `/input/<id>/level.txt`
and writes its push-optimal move list to `/output/<id>/solution.txt`.

How it works: breadth-first search over pushes (a state is the boxes plus the
player's reachable region), pruned by dead squares and frozen 2x2 blocks, with
each level split into its rooms — a box never leaves its room, so the rooms'
optima add up to the level's. Deterministic: the only budget is a count of
states, never the clock.
