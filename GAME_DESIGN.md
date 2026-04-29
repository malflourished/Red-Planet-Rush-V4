# Red Planet Rush Design Notes

## Core Promise

Red Planet Rush is a sci-fi Oregon Trail 2 style survival run. The player starts on Earth in a damaged ship and must reach Mars before the mission window closes, while life support leaks, ship systems break down, crew members deteriorate, and scarce credits must be spent carefully.

## Primary Questions

- Can the ship reach Mars before day 300?
- Is the next stop worth the life support, travel time, and landing risk?
- Should credits go toward repairs, medical care, supplies, upgrades, rumors, or deadline relief?
- Can scanned information turn a dangerous asteroid into a calculated opportunity?
- Will the crew become a set of useful specialists or another pressure system?

## Core Loop

1. Read the map and pick a destination.
2. Travel while days and life support drain.
3. Scan or deep scan to reduce uncertainty.
4. Land on stations, outposts, ships, or asteroids.
5. Trade, repair, heal, buy rumors, extract resources, or recover artifacts.
6. Return to the map with altered ship, crew, inventory, and deadline pressure.
7. Reach Mars or fail from time, life support, or ship integrity.

## System Roles

- **Map:** Strategic layer for route pressure, scan targets, rumors, and timing.
- **Ship:** Central survival machine: integrity, subsystems, scanner, engine, and landing assist.
- **Asteroids:** Main risk/reward content: resources, artifacts, inhabitants, traders, hazards, and false leads.
- **Stations/Outposts:** Relief valves and economic choices: repairs, supplies, upgrades, clinic care, rumors, admin services.
- **Crew:** Small modifiers plus degradation pressure; backgrounds should matter without dominating the run.
- **Artifacts:** High-value cargo with risk hooks that can destabilize a run.

## Current Build Priorities

1. Keep Mars victory and failure states visible and easy to test.
2. Balance life support drain, subsystem leaks, and repair pricing.
3. Make deep scan results reliable enough to support player planning.
4. Keep rumors as gambles: some true, some false, all expensive enough to matter.
5. Expand content only after the full run loop feels tense and legible.

## Tuning Notes

- A 300-day route is the campaign frame, but moment-to-moment life support is much tighter.
- Early stops should feel survivable but costly.
- Mid-run should force choices between upgrades and recovery.
- Late-run should reward preparation: engine upgrades, scanner upgrades, repaired life support, and good rumor choices.
