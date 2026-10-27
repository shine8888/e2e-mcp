---
description: "ft-e2e · Generate test scenarios for a ticket from its Linear issue + code change → SCENARIOS.md (review before any spec is written)"
argument-hint: "<TICKET> [dev|uat|local]"
---

Write the test scenarios for the ticket in `$ARGUMENTS` (environment: `uat` or `local` if that word is there, else `dev`).
The harness is `__FT_E2E_HOME__/harness` (call it `H`); the fintary repo is the `FINTARY_DIR` that `preflight`
uses (call it `R`). Write ONLY `H/tests/<TICKET>/SCENARIOS.md`. Do not write a spec, do not run tests, do not
change any data, do not post to Linear.

1. **Read the issue.** With the Linear MCP if this session has it (`get_issue`, plus its comments): title,
   description, acceptance criteria, comments, attachment titles, linked issues. Without it, use the Linear
   GraphQL API with the key in the Keychain (`security find-generic-password -s ft-e2e-linear -w`, used only
   inside the curl call, never printed): `query { issue(id: "<TICKET>") { title description url comments { nodes { body } } } }`.
   If neither works, ask the user to paste the issue text and stop.
2. **Read the change.** In `R`, find the ticket's commits (the repo writes `[<TICKET>] type(scope): …`, and
   branch names carry the key): `git log --all --oneline -i --grep '<TICKET>'`, then `git show --stat` and the diff
   of each. Say which services (`services/web`, `services/api`, …) and behaviours changed. If nothing is found,
   say so; scenarios then come from the issue only.
3. **The repo's own test knowledge.** Read what already exists for that area, and reuse its accounts, flags and
   wording rather than inventing new ones:
   - `R/docs/<domain>/testing/` (`e2e-requirements.md`, `cases/*.case.md`) for the domain the change touches
     (policies, commissions, comp-grids, companies, settings, admin, …), and `R/docs/e2e-tests/e2e-guidelines.md`;
   - the seed scripts `R/services/api/pages/api/scripts/e2e/` (accounts named "E2E Test account…", `E2E_` data);
   - feature flags the change reads (slug, default per environment) — a scenario may need one on or off.
4. **Existing coverage.** If `H/tests/<TICKET>/` has specs, list each `test(...)` and map it to the scenarios
   below. Read the ticket's runs (`list_runs`) for the last result.
5. **Write `SCENARIOS.md`** with:
   - *What changed* (3 to 6 lines, from the issue and the diff), and *where it shows* (route such as `/policies`,
     which tab / dialog / grid, which roles: Fintary admin, Account Admin, a plain user).
   - A table, one row per scenario: `ID` (TC-01…), `Title`, `Type` (UI / API / layout), `Preconditions & data`
     (account — prefer an existing "E2E Test account…" —, role, feature flags, records it needs, and whether that
     data already exists on the environment), `Steps`, `Expected` (observable and measurable: text, value, grid
     column, request/response), `Evidence` (what to snap and what to ring), `Screens` (a group or names),
     `Writes?` (read-only, or `@writes` — say what it creates/changes/deletes), `Covered by` (existing test, or `—`).
   - A **control** scenario for every change (where the change must NOT apply: another role, another account,
     the flag off), and the regressions the diff could cause nearby.
   - *Out of scope*, and *Open questions* where the expected behaviour isn't written down (never guess an expected
     result and present it as fact — mark it `ASSUMED:` and list it here).
6. **Reply** with the scenario table in short form (ID, title, type, writes?, covered by), the open questions, and
   the data that is missing on the environment. End with Next steps:
   ```
   /ft-e2e:spec <TICKET> <env>                 # write or update the spec from SCENARIOS.md, try it on one screen
   /ft-e2e:inspect <route> <env>               # live selectors for the page, if you want to look first
   ```
   plus, when a spec already covers every scenario, `/ft-e2e <TICKET> devices <env> full --demo`.
