# M2 — Client and installation registry
**Purpose:** Onboard operators, installations, EU importers. **Depends on:** M1. **Screens:** Client list, installation profile.

## Parameters (spec 4.1)
Operator legal name, address, country; contact person, email, phone; installation name and address; country (ISO 3166); UN/LOCODE; latitude/longitude; installation ID/permit number; main economic activity; authorised representative (optional); EU importers served + EORI.

## Requirements
- M2-R1 One client has many installations; one client serves many EU importers.
- M2-R2 All 4.1 fields captured, mapped one-to-one to template sheet A fields (document the mapping).
- M2-R3 Country stored as ISO 3166 code; drives grid factor and carbon price defaults.
- M2-R4 Validation: coordinates in range, UN/LOCODE format, EORI format, email format.
- M2-R5 Duplicate detection on client legal name + country and installation name + client.
- M2-R6 Delete is soft; a client/installation with reporting periods cannot be hard-deleted.
- M2-R7 tenant_id/client_id on every row (G1); changes audit-logged (G3).

## Acceptance tests
- AT1 Create client with two installations in different countries → each gets its own country defaults.
- AT2 Latitude 95 → rejected by API.
- AT3 Delete installation with a period → blocked with clear message.
- AT4 Exported template sheet A matches entered values exactly.
