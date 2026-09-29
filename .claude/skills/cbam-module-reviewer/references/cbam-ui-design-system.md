# CBAM Reporting App — UI Design System and Screen Spec

Version 1.0, 29 Sep 2026. Companion to the "CBAM Reporting Web Application — Modular Build Plan". Module IDs (M1–M13) refer to that plan.

---

## 1. Design intent

The app is a working instrument for consultants and plant staff, not a marketing site. People spend hours entering tonnes, calorific values and emission factors, then defend the result to a verifier. The UI has three jobs:

1. **Make data entry fast and hard to get wrong.** Units, provenance and validation sit next to every number, not in a help page.
2. **Make every result explainable.** Any SEE figure opens to the inputs and formula steps behind it in one click.
3. **Always show where you are.** Client, installation, period and period status are visible on every screen.

### Direction: "the plant ledger"

The look borrows from engineering drawings and plant control rooms: a cool, quiet canvas, precise type with tabular numerals, thin rules that carry structure, and colour reserved for meaning (emission type, status, sector). Nothing is decorative.

**One signature element: the emissions trail.** On the results screen, a flow diagram shows emissions moving from source streams, energy and precursors through each production process into SEE per CN code. It is the one bold, memorable part of the product. Everything around it stays calm.

### Principles

| Principle | What it means in practice |
|---|---|
| Context always visible | A persistent context bar shows client, installation, period and status |
| Numbers first | Tabular numerals, right-aligned, unit always shown, never more than the template's decimals |
| Provenance next to value | Every input shows whether it is measured, estimated or a default |
| Workflow as navigation | The side navigation follows the reporting workflow in order, with completion per step |
| Colour means something | Colour encodes emission type, status or sector — never decoration |
| Calm by default, clear on problems | Most screens are neutral; issues and locked states are unmistakable |
| Explain, don't hide | Every calculated value opens a calculation trace |

---

## 2. Users and their main jobs

| User | Device | Main jobs | Design priority |
|---|---|---|---|
| Consultant | Laptop, 1440–1920 px | Set up clients, configure processes, review, issue reports | Density, speed, overview across clients |
| Data contributor (plant staff) | Laptop, sometimes tablet | Enter monthly or annual data, upload evidence, answer queries | Guidance, clear required fields, forgiving input |
| Reviewer / verifier | Laptop, large monitor | Trace numbers, raise findings, sign off | Traceability, read-only clarity, comments |
| Report recipient | Laptop or phone | Download approved outputs | Simplicity |
| Platform admin | Laptop | Users, factor library, template versions | Control, audit |

---

## 3. Design tokens

All tokens are CSS custom properties, mirrored in `tailwind.config` so React components never use raw hex values.

### 3.1 Colour — base (light)

| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#F3F6F7` | App background (cool mist) |
| `--surface` | `#FFFFFF` | Panels, tables, forms |
| `--surface-sunken` | `#EAEFF1` | Table headers, read-only fields, code of a formula |
| `--ink` | `#16232B` | Primary text (graphite blue) |
| `--ink-muted` | `#56666F` | Secondary text, units, helper text |
| `--rule` | `#D5DDE1` | Borders, table rules |
| `--rule-strong` | `#9FAEB6` | Focused group outlines, drawing lines |
| `--action` | `#1C5D8C` | Primary buttons, links, focus ring ("kiln blue") |
| `--action-hover` | `#154A71` | Hover / pressed |
| `--action-tint` | `#E3EEF6` | Selected row, active nav item |

### 3.2 Colour — meaning

Emission types (used in charts, the emissions trail, and the small type markers on inputs):

| Token | Hex | Meaning |
|---|---|---|
| `--em-direct` | `#34408F` | Direct emissions (indigo) |
| `--em-indirect` | `#1D8A8A` | Indirect emissions / electricity (teal) |
| `--em-precursor` | `#A0741B` | Embedded in precursors (ochre) |
| `--em-heat` | `#7A4E9C` | Heat and waste gases (violet) |

Status:

| Token | Hex | Meaning |
|---|---|---|
| `--ok` | `#2E7D4F` | Complete, passed, approved |
| `--warn` | `#B26B00` | Warning, needs justification, default value used |
| `--critical` | `#B42318` | Blocking issue, failed check |
| `--info` | `#1C5D8C` | Neutral information (same as action) |
| `--locked` | `#56666F` | Approved or issued, read-only |

Each status colour has a `-tint` variant at about 10 % strength for row and badge backgrounds (e.g. `--warn-tint: #FBF1E0`). Text on tints always uses `--ink`, never the status colour, for contrast.

Sectors (used only as small swatches on process and goods labels, never as large fills):

| Sector | Hex |
|---|---|
| Iron and steel | `#4B5C6B` |
| Aluminium | `#8395A3` |
| Cement | `#9A8B78` |
| Fertilisers | `#5E8C3A` |
| Hydrogen | `#3A7CA5` |
| Electricity | `#C69B1E` |

### 3.3 Colour — dark mode

| Token | Hex |
|---|---|
| `--canvas` | `#0F171C` |
| `--surface` | `#16212A` |
| `--surface-sunken` | `#1C2A34` |
| `--ink` | `#E6EDF1` |
| `--ink-muted` | `#9AAAB4` |
| `--rule` | `#2A3A45` |
| `--action` | `#6FA8D6` |

Meaning colours lighten by one step in dark mode; check each against WCAG AA (4.5:1 for text, 3:1 for graphics).

### 3.4 Typography

**Typeface:** IBM Plex Sans for all interface text, with IBM Plex Sans Condensed for dense data grids. Plex comes from an engineering heritage, has excellent tabular numerals, and the condensed width lets a source-stream grid show 10 columns without horizontal scrolling. Both are free (Google Fonts) with a system fallback: `"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif`.

All numbers use `font-variant-numeric: tabular-nums;` so columns align.

| Style | Size / line height | Weight | Use |
|---|---|---|---|
| Display | 28 / 36 | 600 | Page title on dashboards only |
| Heading 1 | 22 / 30 | 600 | Screen title |
| Heading 2 | 18 / 26 | 600 | Section title |
| Heading 3 | 15 / 22 | 600 | Panel and group title |
| Body | 14 / 22 | 400 | Default text, form values |
| Body strong | 14 / 22 | 600 | Emphasis, key values |
| Small | 13 / 20 | 400 | Helper text, table cells (condensed) |
| Caption | 12 / 16 | 500 | Units, badges, timestamps |
| Key figure | 32 / 40 | 600 | SEE values on results screen |

Rules:
- Sentence case everywhere: buttons, headings, labels, table headers. No all-caps labels.
- Line length for prose (help text, report text): at most 72 characters.
- Units follow values in `--ink-muted`: **1,496.4** tCO₂e. Use proper subscripts (CO₂, N₂O).
- Number format follows the user's locale for separators, but the decimals follow the EU template for each field.

### 3.5 Spacing, grid and shape

- Base unit 4 px. Scale: 4, 8, 12, 16, 24, 32, 48, 64.
- Form field height 36 px; compact grid row 32 px; comfortable row 40 px (user toggle).
- App layout: 240 px side navigation (collapsible to 64 px), fluid content, optional 360 px right drawer.
- Content max width for forms: 880 px. Tables and the emissions trail use the full width.
- Radius has hierarchy, not one value for everything: 4 px inputs and badges, 6 px buttons, 8 px panels and drawers, 0 px table cells.
- Elevation: panels use a 1 px `--rule` border, no shadow. Only floating layers (menus, drawers, modals, toasts) get a shadow: `0 8px 24px rgba(22,35,43,.14)`.

### 3.6 Motion

- Duration: 120 ms for hover/press, 200 ms for drawers and expanding rows, 320 ms for the emissions trail's initial draw.
- Easing: `cubic-bezier(.2,.0,.0,1)` for entering, `cubic-bezier(.4,0,1,1)` for leaving.
- Motion only answers a user action or shows a change: a recalculated value briefly highlights in `--action-tint` for 600 ms; a drawer slides in; a row expands.
- The one orchestrated moment: the emissions trail draws its flows left to right on first load of the results screen.
- `prefers-reduced-motion`: all transitions become instant; highlight uses a static border instead.

### 3.7 Iconography

Lucide icons, 1.5 px stroke, 16 px in tables and inputs, 20 px in navigation. Icons always paired with text except in dense toolbars, where they carry a tooltip and `aria-label`.

| Concept | Icon |
|---|---|
| Measured | `gauge` |
| Estimated | `calculator` |
| Default value | `book-open` |
| Evidence attached | `paperclip` |
| Locked | `lock` |
| Issue | `alert-triangle` |
| Calculation trace | `sigma` |
| Comment / finding | `message-square` |

---

## 4. App shell and navigation

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [logo]  Search clients, installations, CN codes…        [?] [bell 3] [SS ▾]   │ top bar 56 px
├──────────────┬────────────────────────────────────────────────────────────────┤
│ Portfolio    │ Aurum Metals Ltd  ›  Jamnagar smelter  ›  2026 ▾   ● In review  │ context bar 48 px
│              ├────────────────────────────────────────────────────────────────┤
│ This period  │                                                                │
│ ✓ Set-up     │   Screen title                               [Secondary] [Primary]
│ ✓ Processes  │   One line on what this screen is for.                         │
│ ◐ Emissions  │                                                                │
│ ◐ Energy     │   ┌──────────────────────────────────────────────────────┐     │
│ ○ Precursors │   │ content                                              │     │
│ ○ Carbon     │   │                                                      │     │
│   price      │   └──────────────────────────────────────────────────────┘     │
│ ○ Results    │                                                                │
│ ○ Review  4  │                                                                │
│ ○ Reports    │                                                                │
│              │                                                                │
│ Evidence     │                                                                │
│ Audit trail  │                                                                │
│              │                                                                │
│ Library      │                                                                │
│ Settings     │                                                                │
└──────────────┴────────────────────────────────────────────────────────────────┘
```

- **Context bar** is persistent inside a client. Each crumb is a switcher (click to change client, installation or period). The status badge shows Draft, In review, Approved or Issued; Approved and Issued show a lock icon, and the whole content area gets a thin `--locked` top border plus a banner: "This period is approved and read-only. Create a new version to make changes."
- **Side navigation** follows the reporting workflow. Each step shows completion: ✓ complete, ◐ in progress, ○ not started, plus a red count of blocking issues. Contributors only see the steps they are assigned to.
- **Global search** (⌘K / Ctrl+K) finds clients, installations, processes, CN codes, source streams and issues, and runs commands ("Open 2026 period for Jamnagar", "Generate draft report").
- **Top bar right:** help, notifications (review comments, assignments, report ready), user menu with theme toggle and density toggle.

---

## 5. Core components

Build on Radix primitives (via shadcn/ui) styled with the tokens above. Every component has default, hover, focus, disabled, error and read-only states.

### 5.1 Buttons

| Variant | Use | Style |
|---|---|---|
| Primary | One per screen area: the main action | `--action` fill, white text |
| Secondary | Other actions | `--surface`, `--rule-strong` border |
| Quiet | Row and toolbar actions | Text only, tint on hover |
| Destructive | Delete, discard | `--critical` text; fill only in the confirm dialog |

Labels say what happens: "Save source stream", "Run calculation", "Approve period", "Generate report". The resulting toast uses the same verb: "Period approved".

### 5.2 Numeric input with unit and provenance

The most-used component. Every numeric parameter from spec section 4 uses it.

```
Net calorific value                                        [gauge] Measured ▾
┌────────────────────────────────────┬──────────┐
│                            48.000  │ GJ/t   ▾ │   [paperclip 2]
└────────────────────────────────────┴──────────┘
Default for natural gas: 48.0 GJ/t (library v2026.2)          Use default
```

- Value right-aligned, tabular numerals.
- Unit selector converts on entry and stores both original and normalised value (spec rule G5).
- Provenance selector: Measured, Estimated, Default. Choosing Default fills the library value and locks the field; overriding a default asks for a source.
- Evidence counter opens the evidence drawer for this field.
- Helper line shows the library default and its version, with a one-click "Use default".
- Validation inline, on blur: "Oxidation factor must be between 0 and 1." Never only on submit.
- Out-of-band values (plausibility, from M4) show an amber outline and "Higher than the usual range for this fuel (44–50 GJ/t). Check the lab report or add a note."

### 5.3 Data grid (source streams, energy flows, precursors)

- TanStack Table (or AG Grid if licensing allows) with Plex Sans Condensed, 32 px rows.
- Spreadsheet behaviour: arrow keys, Enter to edit, Tab to next cell, paste a block from Excel, fill-down.
- Frozen first column (name) and sticky header.
- Columns shown depend on the calculation method of each row; irrelevant cells are sunken and empty, not "n/a".
- Row status in the leftmost gutter: complete, warning, blocking.
- Row actions on hover and via keyboard: open trace, attach evidence, comment, duplicate, delete.
- Footer row shows totals in tCO₂e by emission type.
- Changed-but-unsaved cells show a 2 px `--action` left border; autosave clears it.

### 5.4 Badges and chips

- **Status badge:** tinted background, 12 px caption, icon plus word ("Needs review", "Approved").
- **Provenance chip:** icon only in grids (with tooltip), icon plus word in forms.
- **Emission type marker:** 8 px square in the emission colour before the label, used consistently in grids, charts and the trail.
- **Sector swatch:** 8 px circle before process and goods names.

### 5.5 Calculation trace drawer

Opens from any calculated value (sigma icon or click on the number). Right-side drawer, 480 px.

```
SEE direct — Primary aluminium, CN 7601 10 00                         [×]
1.4964 tCO₂e/t

Formula
  SEE_dir = (AttrEm_dir + Σ M_p × SEE_dir,p) / AL

Inputs                                          Value        Source
  Attributed direct emissions                   2,692.8 t    Step 2 ▸
  Precursor: carbon anodes, 200 t × 1.5         300.0 t      Supplier file ▸
  Activity level                                2,000 t      Process set-up ▸

Result                                          1.4964 tCO₂e/t
Library v2026.2 · Template v2026-Q2 · Engine 1.3.0
```

Each input links to the record it came from; nested steps expand in place. This drawer is what verifiers use most, so it must never lag or truncate.

### 5.6 Stepper and progress

The workflow progress in the side nav is the main stepper. Inside long forms (process builder), a vertical in-page step list on the left shows sections and completion. Avoid wizards that hide later steps.

### 5.7 Empty, loading and error states

| State | Pattern | Example copy |
|---|---|---|
| Empty | Plain explanation and the one action that fills it | "No source streams yet. Add the fuels and materials this process uses." [Add source stream] [Import from Excel] |
| Loading | Skeleton rows matching the final layout; no spinners over 300 ms | — |
| Error | What happened, why, what to do | "Couldn't save 3 rows. Oxidation factor is above 1 in rows 4, 7 and 9. Fix them and save again." |
| Blocked | State the rule | "You can't approve this period while 2 blocking issues are open." [View issues] |

Errors don't apologise and are never vague.

### 5.8 Feedback

- **Toasts:** bottom-right, 4 s, action verb in past tense, optional Undo for 10 s on deletes.
- **Autosave indicator** in the screen header: "Saved 12:04" / "Saving…" / "Couldn't save — retry".
- **Recalculation:** after a save, affected results briefly highlight; a small "Results updated" note appears in the results nav item.

### 5.9 Evidence drop zone

Drag files onto any record, the evidence drawer, or the evidence library. Shows file type, size, uploader, linked records. Accepts PDF, images, XLSX, CSV. Rejected files explain why ("Files over 25 MB aren't accepted. Split or compress the file.").

### 5.10 Comments and review findings

Inline comment markers on fields and grid rows (small speech-bubble icon in the margin). Clicking opens a thread in the right drawer. Findings have severity and status; only the reviewer can close them (spec M11-R4).

---

## 6. Key screens

### 6.1 Portfolio (consultant home) — M1, M2, M3

Purpose: see all clients and what needs attention today.

```
Portfolio                                                        [Add client]

Needs attention
  6 periods in review · 3 with blocking issues · 2 reports ready to issue

┌ Filter: [All sectors ▾] [All statuses ▾] [Period 2026 ▾]   Search ________ ┐
│ Client            Installations  Sector      Period  Status       Issues  Due │
│ Aurum Metals      2              Aluminium   2026    In review    4 ●    Oct 30│
│ Deccan Cement     1              Cement      2026    Draft        —      Nov 15│
│ Kaveri Fertilisers 3             Fertilisers 2026    Approved 🔒   —      —    │
└──────────────────────────────────────────────────────────────────────────────┘
```

A table, not a wall of cards: consultants scan and sort. Row click opens the client.

### 6.2 Client and installation profile — M2

Two-column form (max 880 px), grouped: operator details, installation location, identifiers, EU importers served. A small map preview confirms the coordinates. Importers appear as a sub-table with EORI and the CN codes each receives.

### 6.3 Period overview — M3

The landing page inside a period.

```
2026 reporting period    Jan 1 – Dec 31, 2026    ● In review    Version 1

Progress                                   Blocking issues
Set-up          ██████████ 100%            ● Activity level missing — Anode baking
Processes       ██████████ 100%            ● Allocation totals 90% — Natural gas
Emissions       ███████░░░  70%            [View all 4 issues]
Energy          █████░░░░░  50%
Precursors      ░░░░░░░░░░   0%            Team
Carbon price    ░░░░░░░░░░   0%            R. Mehta (contributor) — last active 2 h ago
                                           S. Sharma (consultant)
[Submit for review]     [Clone to 2027]
```

### 6.4 Process builder — M5

Left: list of processes with sector swatch and completion. Right: the selected process in sections — goods category and route, CN codes produced (editable sub-table with quantities), qualifying parameters (fields change by sector), links summary (streams, energy, precursors). A live reconciliation bar shows "CN quantities 1,980 t of 2,000 t activity level" and turns amber outside tolerance.

### 6.5 Direct emissions — M6

Tabs across the top: Calculation-based, Measurement-based, PFC, N₂O (only tabs relevant to the installation's routes appear). The main area is the data grid (5.3). A toolbar offers Add source stream, Import from Excel, Download import template, Show defaults. Selecting a row opens its detail form in the right drawer for fields that don't fit the grid (allocation across processes, notes, evidence).

### 6.6 Energy balance — M7

A balance table per installation: rows are processes, columns are electricity consumed, electricity exported, heat imported, heat exported, waste gases. A balance check row at the bottom turns red if exports exceed generation or internal heat flows don't net to zero. The grid factor used is shown above the table with its source and a switch to PPA / own-plant factor.

### 6.7 Precursor map — M8

A node diagram: processes as nodes, own-precursor links as arrows between them, purchased precursors entering from the left edge with the supplier name. Unresolved links show as dashed red arrows. A list view toggle shows the same data as a table for keyboard users and for bulk editing. Adding a link that would form a cycle is prevented with an inline message.

### 6.8 Results and the emissions trail — M10 (signature screen)

```
Results — 2026, version 1                                   [Export ▾] [Compare versions]

Primary aluminium, CN 7601 10 00
┌────────────────┬────────────────┬────────────────┐
│ SEE direct     │ SEE indirect   │ SEE total      │
│ 1.4964         │ 1.7900         │ 1.4964*        │
│ tCO₂e/t        │ tCO₂e/t        │ tCO₂e/t        │
└────────────────┴────────────────┴────────────────┘
* Indirect emissions reported but not included in SEE for this goods category.

Emissions trail
 Source streams ─┐
  Natural gas  ██████╲
  Anodes       ███╲    ╲
 Electricity  ████████╲ ╲         ┌──────────────┐        ┌───────────────────┐
 Precursors ─────────────────────▶│ Electrolysis │──────▶ │ CN 7601 10 00     │
  Carbon anodes ███╱              └──────────────┘        │ 2,000 t · 1.4964  │
                                                          └───────────────────┘
 Filter: [Direct ✓] [Indirect ✓] [Precursors ✓]   Unit: [tCO₂e ▾ | tCO₂e/t]
```

- The trail is a Sankey-style flow (visx or d3-sankey): left column sources (coloured by emission type), middle column processes, right column goods (CN codes). Band width is proportional to tCO₂e.
- Hover a band: exact value and share. Click a band or node: opens the calculation trace drawer.
- Toggles filter emission types; the key figures above update with them.
- Below the trail: a sortable table of the same data per process and per good, for exact reading and export. The chart and the table never disagree; both read from the same result set.
- "Compare versions" shows a side-by-side of key figures with differences highlighted.

### 6.9 Issues and review — M11

Split view: issues list on the left (filter by severity, module, status, assignee), issue detail on the right with the affected record inline-editable, so a contributor fixes the problem without leaving the page. Warnings have a "Justify" action with a required note. Reviewer findings appear in the same list with a distinct marker. A sign-off panel at the top shows who has signed and what is outstanding.

### 6.10 Reports — M12

```
Reports — 2026, version 1

Status: Approved 🔒   Template v2026-Q2   Library v2026.2

Output                                   Format   Last generated     
EU Communication Template                .xlsx    Sep 28, 14:02      [Download] [Regenerate]
CBAM emissions report                    PDF      Sep 28, 14:03      [Download] [Preview]
Importer summary — Hansa Handel GmbH     PDF      —                  [Generate]
Calculation workbook                     .xlsx    Sep 28, 14:02      [Download]

Version history ▸
```

Draft periods show the same list with a "Draft — watermarked" note and generate watermarked files. A PDF preview opens in a full-width modal. Generation shows progress in place; when it's done the row updates and a notification is sent.

### 6.11 Evidence library and audit trail — M13

- **Evidence:** a table of files with type, linked records (chips), uploader and date, plus a preview pane. Filters by record type and period.
- **Audit trail:** a reverse-chronological table: time, user, record, field, old value, new value. Filters by user, module, record and date range. Old and new values show side by side with the change highlighted. Export to CSV.

### 6.12 Reference library — M4 (admin)

Tabs for Emission factors, NCVs, Grid factors, GWPs, Default values, CN codes, Templates. Each table shows the active version; a version selector shows history. Publishing a new version shows a diff (added, changed, removed) and the periods that will use it; issued periods are listed as unaffected.

---

## 7. Interaction patterns

| Pattern | Rule |
|---|---|
| Autosave | Forms and grids save on blur and every 5 s of inactivity; no "Save" button except for explicit commits (submit, approve, generate) |
| Inline validation | On blur, with the rule in plain words; blocking errors prevent "complete", not typing |
| Undo | Delete and bulk edits offer Undo for 10 s; everything else is traceable in the audit trail |
| Bulk import | Upload → column mapping → row-by-row preview with errors highlighted → import only valid rows or fix first |
| Keyboard | ⌘K search, `N` new row in grids, `E` edit, `T` open trace, `?` shortcut list |
| Locked state | Read-only fields render as plain text on `--surface-sunken`, not greyed-out inputs, so they stay readable |
| Assignment | Contributors see "Assigned to you" filters by default |
| Confirmation | Only for irreversible or wide-impact actions: approve, issue, delete a process with data, publish a library version. Dialog states the consequence ("Approving locks all data in this period. Changes will need a new version.") |
| Onboarding | A period's first visit shows a short checklist in the overview, not a modal tour |

---

## 8. Data visualisation rules

- Emission colours from 3.2 everywhere; the same type always has the same colour.
- Bar charts start at zero; units in axis titles; values labelled directly where there is room instead of a legend.
- Every chart has a table view toggle for accessibility and exact reading.
- No pie charts for more than three parts; use horizontal bars.
- Period comparisons use side-by-side bars or a slope chart, with the change as a signed value (+4.2 %).
- Chart library: visx or Recharts for standard charts; d3-sankey for the emissions trail.

---

## 9. Content and voice

- Plain, precise, sentence case. Write for plant engineers and consultants, not lawyers.
- Use CBAM terms consistently and explain them once with a tooltip: SEE, activity level, precursor, source stream, CN code.
- Name actions by outcome: "Approve period", not "Submit". The same verb carries through button, toast and audit entry.
- Numbers in copy include units: "Allocation totals 90 %; it must total 100 %."

### Glossary for UI labels

| Use | Not |
|---|---|
| Source stream | Fuel entry, material row |
| Activity level | Production total, output |
| Specific embedded emissions (SEE) | Carbon intensity, footprint |
| Default value | Standard value, fallback |
| Reporting period | Year, cycle |
| Approve period | Finalise, submit |
| Evidence | Attachments, docs |
| Finding | Comment (for reviewer items) |

---

## 10. Accessibility

- WCAG 2.2 AA minimum. Text contrast 4.5:1; UI graphics and focus rings 3:1.
- Visible focus ring: 2 px `--action` outline with 2 px offset on every interactive element.
- Colour is never the only signal: status badges have icons and words; chart series have labels or patterns.
- Grids are fully keyboard-operable and announce cell position and validation state to screen readers.
- Minimum target size 24 × 24 px (32 px on touch).
- Charts, the emissions trail and the precursor map each have an equivalent table.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`; user can override theme and density.

---

## 11. Responsive behaviour

| Width | Behaviour |
|---|---|
| ≥ 1440 px | Full layout, right drawer docks beside content |
| 1024–1439 px | Side nav collapses to icons; drawer overlays content |
| 768–1023 px (tablet) | Nav becomes a sheet; grids switch to card-per-row for entry; trail scrolls horizontally |
| < 768 px (phone) | Read and approve only: portfolio, period overview, issues, reports download. Data entry shows a notice suggesting a larger screen |

---

## 12. Implementation notes (React)

- **Tokens:** one `tokens.css` with light and dark variables; Tailwind reads them (`colors: { ink: 'var(--ink)' … }`). No hex values in components.
- **Components:** shadcn/ui (Radix) for dialogs, menus, popovers, tabs, tooltips; custom `NumericField`, `ProvenanceSelect`, `UnitSelect`, `DataGrid`, `TraceDrawer`, `EmissionsTrail`, `StatusBadge`, `ContextBar`.
- **Grid:** TanStack Table with virtualisation (TanStack Virtual) for large imports.
- **Forms:** React Hook Form + Zod, sharing the same Zod schemas as the Express API so validation messages match (spec rule G8).
- **Numbers:** format through one `formatQuantity(value, unit, fieldId)` helper that applies template decimals and locale; never `toFixed` in components.
- **State:** TanStack Query for server data, with optimistic updates for grid edits and rollback on error.
- **Storybook:** every component with all states, plus visual regression tests; accessibility checks with axe in CI.
- **Brand alignment:** if CETIZION / PlanetPulse brand colours must appear, map the brand primary to `--action` and check contrast; keep emission and status colours unchanged.

---

## 13. Design review checklist

Use before any screen ships.

- [ ] Context bar shows client, installation, period and status
- [ ] Every numeric input shows unit and provenance
- [ ] Every calculated value opens a calculation trace
- [ ] Numbers are tabular, right-aligned, with template decimals
- [ ] Colour used only for emission type, status or sector
- [ ] Empty, loading, error and locked states designed
- [ ] Validation inline and in plain words, matching API messages
- [ ] Keyboard path through the whole screen works
- [ ] Charts have a table view
- [ ] Contrast and focus pass AA in light and dark mode
- [ ] Button labels, toasts and audit entries use the same verb
- [ ] Works at 1024 px without horizontal page scroll
