# M11 — Validation and review
**Purpose:** Completeness checks, plausibility flags, review findings, sign-off. **Depends on:** M10. **Screens:** Issues list, review queue.

## Requirements
- M11-R1 Rule catalogue: completeness per method, ranges, balances (CN quantities vs AL, energy exports vs generation, allocation = 100 %), unresolved precursors, SEE outside benchmark band, share of default values.
- M11-R2 Each issue has severity (critical/warning/info), linked record, message, status (open/justified/resolved).
- M11-R3 Warnings can be justified with text; critical issues must be resolved.
- M11-R4 Reviewer findings attach to any record, have threaded replies, and are closed only by the reviewer.
- M11-R5 Sign-off by consultant (and verifier if used) captured with user and time; required for M3 approval.
- M11-R6 Rules are data-driven/configurable, each with an ID shown in the UI.
- M11-R7 Re-running validation after data change updates issues without losing justifications on unchanged records.

## Acceptance tests
- AT1 Period with a critical issue → approval blocked.
- AT2 Justified warning survives an unrelated edit.
- AT3 Contributor cannot close a reviewer finding.
