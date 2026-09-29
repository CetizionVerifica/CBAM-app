---
name: cbam-module-reviewer
description: Rigorous, spec-driven review of the modules (M1–M13) of the CBAM reporting web application — the multi-client tool that calculates specific embedded emissions (SEE) and fills the EU CBAM Communication Template for Installations. Use this skill whenever the user asks to review, audit, QA, test, check, or sign off any part of the CBAM app — a module, a PR, a screen, an API route, a database schema, the calculation engine, or the report export — even if they only say "review M6", "check the precursor code", "is the SEE engine right?", or paste code and ask whether it meets the spec.
---

# CBAM Module Reviewer

Reviews one module of the CBAM reporting app at a time against its written spec, and returns a findings report where every finding cites the spec clause it breaks. The goal is that a module passing this review can be handed to a client and a verifier without surprises.

## Files in this skill

| File | Read when |
|---|---|
| `references/spec-overview.md` | Always, first. Roles, entities, workflow, global rules every module must obey |
| `references/modules/Mxx-*.md` | The module under review. One file per module, with numbered requirements (e.g. `M6-R4`) and acceptance tests |
| `references/calculation-reference.md` | Reviewing M4, M6, M7, M8, M10 or M12, or any code that touches numbers |
| `references/review-report-template.md` | When writing the output |
| `references/cbam-ui-design-system.md` | Reviewing any screen or component: check tokens, states and the section 13 checklist |

If `docs/cbam-spec.md` exists in the repo, or the user has the living spec document (the "CBAM Reporting Web Application — Modular Build Plan" doc) open or linked, read it too. Where it differs from the bundled files, the living doc wins — note the difference in the report so the bundled files can be updated.

## Workflow

### 1. Pin the scope
Establish which module(s) and which artifact: code files, a repo branch or PR, a DB migration, UI screenshots, an API spec, or a running demo. If the user names a feature rather than a module, map it with the module table in `spec-overview.md`. Review one module per pass; for "review everything", go M1 → M13 in dependency order and produce one report per module plus a roll-up.

If no implementation is provided, say so and offer a **spec readiness review** instead (is the module spec complete, testable and consistent?) — never invent code to review.

### 2. Load the spec
Read `spec-overview.md`, then the module file, then the files of the modules it depends on (listed under "Depends on"), because most integration defects sit at those seams.

### 3. Collect evidence
Read the actual implementation. For code, trace each requirement to where it is implemented: route → validator → service → DB. Use the repo tools available (GitHub connector, uploaded files, the filesystem). Run tests or small scripts when you can — a calculation claim verified by execution beats one verified by reading.

### 4. Check every requirement
Go through the module file's requirements **one by one, in order**. For each, record a verdict:

- **Pass** — implemented and you saw the evidence (file and line, test, screenshot).
- **Fail** — missing or wrong. State expected vs actual.
- **Partial** — present but incomplete (e.g. validated in UI, not in API).
- **Not verifiable** — the evidence needed was not provided. Say what is needed.

Do not mark Pass on the strength of a function name, a comment or a TODO. Absence of evidence is "Not verifiable", not Pass.

### 5. Run the cross-cutting checks
Apply the global rules G1–G10 in `spec-overview.md` to this module (tenant isolation, audit log, units, decimals, locking, roles…). These are where most serious defects hide.

### 6. Run the acceptance tests
Walk through each acceptance test in the module file. Execute where possible; otherwise trace the path by reading and mark the result as "traced, not executed".

### 7. Hunt beyond the checklist
Spend a deliberate pass on what the spec doesn't enumerate: edge cases (zero, negative, null, very large, duplicate), concurrent edits, partial saves, bad imports, time zones and period boundaries, permission escalation via direct API calls, N+1 queries on large clients, and error messages that leak data. Log these as findings with category "Beyond spec".

### 8. Grade and report
Assign severity per finding:

| Severity | Meaning |
|---|---|
| Critical | Wrong SEE or emissions number, data visible across clients/tenants, locked data editable, lost audit trail |
| High | Spec requirement missing or broken in a way a user or verifier will hit |
| Medium | Requirement partly met, weak validation, poor error handling |
| Low | Usability, naming, minor inconsistency with the template |
| Info | Suggestion or spec gap |

Module verdict: **Ready** (no Critical/High), **Ready with conditions** (High findings with an agreed fix plan), **Not ready** (any Critical, or more than three High).

Write the report with `references/review-report-template.md`. Default output is a Markdown file; if the user wants it in the living spec doc or as a GitHub PR review, deliver it there instead.

## Rules for rigour

- Every finding cites a requirement ID (`M8-R3`, `G4`) or says "Beyond spec".
- Every finding has evidence: file path and line, request/response, screenshot, or the exact test run.
- Numbers are checked with numbers: recompute at least one worked example per calculation path using `calculation-reference.md`, with decimals, and show the working.
- Say what you did not review. A short honest scope beats an implied full pass.
- Flag spec defects too: an ambiguous, contradictory or untestable requirement is a finding (category "Spec gap").
- Regulatory rules in the spec come from general knowledge and must be confirmed against current EU CBAM implementing acts; flag any code that hard-codes a regulatory rule without a reference or a config switch.
