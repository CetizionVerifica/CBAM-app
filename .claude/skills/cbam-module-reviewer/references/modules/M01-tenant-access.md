# M1 — Tenant and access
**Purpose:** Users, roles, client assignment, login. **Depends on:** — **Screens:** Users, roles, invitations.

## Requirements
- M1-R1 Five roles exist: platform admin, consultant, data contributor, reviewer/verifier, report recipient.
- M1-R2 Users belong to one tenant; a user can be assigned to specific clients and, for contributors, specific installations.
- M1-R3 Every API route enforces role + assignment server-side (G2); a contributor calling another installation's ID gets 403/404.
- M1-R4 Invitation flow: email invite, expiring token, set password; tokens single-use.
- M1-R5 2FA mandatory for platform admin and consultant.
- M1-R6 Passwords hashed with a modern algorithm (bcrypt/argon2); lockout or rate limit on failed logins.
- M1-R7 Deactivating a user revokes sessions immediately; their audit history remains.
- M1-R8 Role and assignment changes are audit-logged (G3).

## Acceptance tests
- AT1 Contributor A (installation X) requests installation Y's data by direct URL → denied.
- AT2 Recipient tries to POST data → denied.
- AT3 Consultant without 2FA cannot reach client data.
- AT4 Reused invite token → rejected.
