# Review report template

```markdown
# Review — M<n> <Module name>

**Date:** YYYY-MM-DD · **Reviewer:** Claude · **Artifact reviewed:** <repo@commit / PR # / files / screenshots>
**Verdict:** Ready | Ready with conditions | Not ready
**Counts:** Critical n · High n · Medium n · Low n · Info n

## Scope
What was reviewed, what was not, and why (missing access, not provided).

## Requirement coverage
| ID | Requirement (short) | Verdict | Evidence |
|---|---|---|---|
| M<n>-R1 | … | Pass / Fail / Partial / Not verifiable | path:line, test, screenshot |

## Global rules
| Rule | Verdict | Evidence |
|---|---|---|
| G1 Tenant isolation | … | … |
(G1–G10)

## Acceptance tests
| ID | Result | Executed or traced | Notes |
|---|---|---|---|

## Findings
### F1 — <title> (Critical)
- **Ref:** M<n>-R<k> / G<k> / Beyond spec / Spec gap
- **Evidence:** file:line or request/response
- **Expected:** …
- **Actual:** …
- **Fix:** concrete change
- **Retest:** how to confirm the fix

## Spec gaps
Ambiguous or missing requirements to add to the spec.

## Next steps
Ordered fix list; which findings block the next module.
```
