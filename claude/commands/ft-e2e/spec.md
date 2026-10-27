---
description: "ft-e2e · Write or update a ticket's Playwright spec from SCENARIOS.md, then try it on one screen"
argument-hint: "<TICKET> [dev|uat|local] [TC-01,TC-03]"
---

Write the spec for the ticket in `$ARGUMENTS` (environment: `uat` or `local` if that word is there, else `dev`;
optional comma list of scenario IDs to limit it to). The harness is `__FT_E2E_HOME__/harness` (`H`).

1. **Scenarios first.** Read `H/tests/<TICKET>/SCENARIOS.md`. If it is missing, run the `/ft-e2e:scenarios` flow
   (`~/.claude/commands/ft-e2e/scenarios.md`) first, show it, and stop for the user's review.
2. **Data.** For scenarios whose preconditions are missing on the environment, list exactly what you would create
   and how (prefer the repo's seed endpoints `POST /api/scripts/e2e/<domain>/e2e-seed-<domain>-{read,edit}` with
   `{ action: "seed" }`: dev and local only, Fintary-admin token, "E2E Test account…" accounts, `E2E_` data) and
   **ask before any write**. Record it in `SCENARIOS.md` under *Test data to clean up* (the seed's `teardown`).
   Never preview or prod: they share the production database. Never flip a feature flag whose slug does not start
   with `E2E_` (a global change on dev reaches every dev user).
3. **Selectors.** `inspect_page` for each route the scenarios touch, on this environment. Use roles, labels,
   input ids (`#emailAddress`), DataGrid column headers and the few `data-testid`s it reports; never guess a selector.
4. **Write `H/tests/<TICKET>/<slug>.spec.ts`**, in the style of the existing specs (read `H/tests/_app-smoke/`
   and `H/tests/_web-smoke/`, and the header of `H/fixtures/index.ts`):
   - `import { test, appTest, expect } from '../../fixtures'`: signed-in pages use `appTest` + `app.url('/policies')`
     (it opens on `E2E_ACCOUNT_ID` when set); public pages use `test`. API checks use `api` (signed in, sends
     `authentication: Bearer <ID token>` and `accountid`) or `publicApi`.
   - A header comment: what the ticket changed, the setup data and account, READ-ONLY or what it writes, and the
     `run_e2e { ... }` line to run it.
   - One `test(...)` per scenario, titled `<TICKET> TC-0N <title>`, top-level `test.step`s in plain English (they
     become the narrated captions). Tag a case that creates, changes or deletes data with `@writes` in its title:
     it is left out unless the run asks for writes.
   - Assert what `Expected` says, measured (text, numbers, grid cells, box positions), with a message that names the value seen.
   - `evidence.snap(label, { mark | boxes, note })` at every point the scenario's `Evidence` column names;
     `boxes` with `tone: 'ok' | 'bad'` ring each checked value; the note says what was checked and the result.
     Report the totals with `test.info().annotations.push({ type: 'verified', description: JSON.stringify({ tab, what, count, wrong, expected }) })`
     and the account / role with `{ type: 'context', description }`.
   - `demo.circle(locator, label)` on the element under test.
   - Dates relative to today (never a fixed date that will pass); ids as named constants with a comment.
   - Read the account actually on screen (localStorage `selectedAccount`), not only the config.
5. **Try it**: `run_e2e` with the ticket on ONE screen that shows the change (e.g. `devices: ["desktop"]`).
   If a test fails, decide from the evidence whether it is the **spec** (selector, timing, wrong assumption → fix the
   spec, rerun, at most 3 rounds) or the **product** (the app does not do what `Expected` says → keep the test
   failing, and report it as a finding with its screenshot). Never weaken an assertion to make it pass.
6. **Reply**: the tests written (scenario → test), the one-screen result with numbers, any product failures, the
   test data created, and Next steps with the real values filled in:
   ```
   /ft-e2e <TICKET> devices <env> full --demo           # every scenario on 7 screens, narrated, with the layout audit
   /ft-e2e <TICKET> browsers <env> safari iphones        # Safari engine on 5 iPhones
   /ft-e2e <TICKET> evidence <env>                       # results, screenshots, failures of the last run
   ```
