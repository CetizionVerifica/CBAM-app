# M13 — Evidence and audit
**Purpose:** File uploads linked to records, change log. **Depends on:** all. **Screens:** Document library, audit trail.

## Parameters (spec 4.10)
Supporting documents (file, type, linked record); verifier name and accreditation; site visit date; verification opinion and findings; approval by consultant and client.

## Requirements
- M13-R1 Any data record can have evidence attached; one file can support many records.
- M13-R2 Files stored in object storage, access via short-lived signed URLs, respecting G1/G2.
- M13-R3 File type and size limits; malware scanning or at least content-type verification.
- M13-R4 Evidence on an Issued period cannot be deleted.
- M13-R5 Audit log is append-only (no update/delete permission for the app role), covers every module (G3), filterable by record, user and date.
- M13-R6 Audit entries store old and new values, not just "changed".
- M13-R7 Verifier details and opinion stored per period.

## Acceptance tests
- AT1 Signed URL reused after expiry → denied.
- AT2 App DB role attempts UPDATE on audit table → fails.
- AT3 Edit an NCV → audit shows old and new value and user.
