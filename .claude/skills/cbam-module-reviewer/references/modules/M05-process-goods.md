# M5 — Process and goods set-up
**Purpose:** Define processes, routes, CN codes, qualifying parameters. **Depends on:** M3, M4. **Screens:** Process builder.

## Parameters (spec 4.3)
Aggregated goods category; production route; CN codes (8-digit); activity level (t); quantity per CN code (t); quantity to EU vs other markets (t); quantity consumed internally as precursor (t); qualifying parameters by sector (clinker content, N content and form, alloy content, scrap share, hydrogen purity, etc.).

## Requirements
- M5-R1 Goods category and route chosen from M4 lists; route options filtered by category.
- M5-R2 CN code validated against the M4 CN list and must belong to the chosen category.
- M5-R3 One process can produce several CN codes; Σ quantity per CN + internal consumption reconciles with activity level (tolerance configurable) — else an M11 issue.
- M5-R4 Qualifying parameters required per sector as configured in M4.
- M5-R5 Changing category/route after data entry warns and lists affected records.
- M5-R6 Deleting a process with data linked (streams, precursors) is blocked or cascades only after explicit confirmation, logged.

## Acceptance tests
- AT1 Aluminium category + cement CN code → rejected.
- AT2 CN quantities 1,200 t vs activity level 1,000 t → issue raised.
- AT3 Fertiliser process without N content → cannot be marked complete.
