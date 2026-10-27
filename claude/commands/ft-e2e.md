---
description: "Fintary e2e tests via the ft-e2e MCP — scenarios, spec, preflight, run, narrated demo, devices, browsers, evidence, Linear publish"
argument-hint: "<TICKET> [scenarios|spec|preflight|run|demo|api|devices|browsers|evidence|runs|video|publish] [dev|uat|local] [screens] [browsers] [--demo] [--writes] [RUN]"
---

You drive the **ft-e2e MCP** (tools `mcp__ft-e2e__*`). Arguments: `$ARGUMENTS`

The same flows are also installed one per command, as `/ft-e2e:<command>` (files in
`~/.claude/commands/ft-e2e/`), so typing `/ft-e2e` lists every next step with its own hint.

## Parse the arguments (any order)

- **Command**: any word that is one of the commands below, wherever it appears. `/ft-e2e PLT-1234 evidence dev` and `/ft-e2e evidence PLT-1234` are the same. No command word and a ticket → the **ticket only** flow.
- **Ticket**: the word matching `[A-Z][A-Z0-9]*-\d+` (Linear: `PLT-1234`, `APP-316`, `E2E-10`), or starting with `_` (smoke tickets).
- **Environment**: `dev` (default), `uat`, or `local`. `preview` and `prod` are refused for runs: preview shares the PRODUCTION database. Say so if asked; preflight may still probe them read-only.
- **Screens** (for `devices`, and `browsers` when given): a comma list of names or groups: `desktop`, `laptop`, `tablet`, `mobile`, `iphones`, `android`, `phones`, `tablets`, `desktops`, `full`, `all`, or any name from `list_devices`. Default for `devices`: `desktop,tablet,mobile`.
- **Browsers** (for `browsers`): `chromium`, `chrome`, `edge`, `firefox`, `safari`, `all`. Default `chromium,safari`.
- **Run**: a word like `2026-10-26_15-44-31` (for `evidence`, `video`, `publish`). Default: the newest run.
- `--demo` anywhere: also narrate the recording, with the steps and results read aloud (macOS voice).
- `--silent` anywhere: a narrated run without the voice (`voice: false` on `run_e2e` and `build_demo_video`).
- `--writes` anywhere: also run the cases tagged `@writes` (they create, change or delete data). Only on dev / uat / local, and only when the spec works on an "E2E Test account…" with `E2E_`-prefixed data. Say that before running.
- Smoke tickets: `_web-smoke` (sign-in page + API health, no login), `_app-smoke` (signed in: app, Policies grid, API), `_demo-smoke`, `_api-smoke`, `_device-smoke` (no app at all: pass `skipPreflight: true`). `DEMO-101` is the bundled demo app (Northstar Claims, a local HTML file): run it with `env: local` and `skipPreflight: true`.

If there are no arguments at all, show the **Commands** table below (as `/ft-e2e <TICKET> <command>` examples) and stop.

## Ticket only: `/ft-e2e PLT-1234 [dev|uat|local]`

1. `preflight` for that ticket and environment. Report `canRun`, any blocker, and what is live there (the `stamps`: API image commit, web build time) in two or three lines.
2. `list_runs` for the ticket. If there are runs, give the newest one's result in one line, with its run folder name.
3. If `harness/tests/<TICKET>/` does not exist, say there is no spec yet and offer `scenarios` as the first step. If it has specs but no `SCENARIOS.md`, offer `scenarios` to check the coverage against the issue.
4. End with **Next steps** (below).

## Commands

| Command | Do this |
|---|---|
| `scenarios TICKET` | Follow `~/.claude/commands/ft-e2e/scenarios.md`: Linear issue + its commits + the repo's own test docs → `tests/<TICKET>/SCENARIOS.md`, then stop for review. |
| `spec TICKET [TC-ids]` | Follow `~/.claude/commands/ft-e2e/spec.md`: write or update the spec from `SCENARIOS.md`, try it on one screen. |
| `doctor` | `check_toolkit`. List what is missing per feature (core, dev, uat, local, demo, browsers, publish), with the exact fix, and whether it is automatic or manual. |
| `setup` | `check_toolkit`, show the automatic items you would install and their commands, **ask the user to confirm**, then `install_toolkit` with exactly those items. Never a manual item. |
| `preflight [TICKET]` | `preflight`. Changes nothing. |
| `run TICKET` | `run_e2e` with the ticket and env (`writes: true` only with `--writes`). |
| `demo TICKET` | `run_e2e` with `demo: true` (voice on unless `--silent`), then `build_demo_video` for that run. Give the path of `report.webm`, and say whether it has a voice track (`voice` in the result). |
| `api TICKET` | `run_e2e` with `apiOnly: true`, then `get_api_calls` (summary rows). |
| `devices TICKET [screens] [--demo]` | `run_e2e` with `devices`. Summarise the per-screen result and the findings (ID, severity, title, screens). |
| `browsers TICKET [browsers] [screens] [--demo]` | `run_e2e` with `browsers` (and `devices` if screens are given). Report skipped browsers as skipped, never as passed. |
| `evidence TICKET [RUN]` | `get_evidence` (and `get_api_calls` if the run has API calls). Runs nothing. |
| `runs TICKET` | `list_runs`. |
| `video TICKET [RUN]` | `build_demo_video`, then `build_device_report` so the report links the reel. |
| `publish TICKET [RUN]` | `prepare_linear_publish`. Show the comment, the file list and sizes, and the digest, and tell the user to look at every image first (shareable data only). **Stop and ask** before `publish_to_linear`; call it only after an explicit yes, with that digest. Never change the issue's status, labels or assignee. |
| `report` | `build_report`. |
| `tickets` | `list_tickets`. |
| `stack [status\|up\|down]` | `dev_stack_status` (default), `dev_stack_up` (the repo's scripts/agent/up.sh), or `dev_stack_down`. |
| `inspect ROUTE [env]` | `inspect_page` with a web path such as `/policies` or `/agents/list` (signed in by default; `/sign-in` and other public routes without a session). |

Size `timeoutMs` for cases times screens (about 25 s per screen plain, about 50 s narrated).

## How to report a result

- Lead with the verdict and the numbers from the tool result (cases, screens, passed / failed / skipped, values verified). Never call a run with skips "passed".
- Say what was tested against: the live API image commit and web build time on dev / uat, the branch @ commit on local.
- Name each failure with its first error line, and each finding with ID, severity, title and screen count. A finding seen only in `safari` is Playwright's WebKit: say "in WebKit", not "in Safari", unless someone checked Safari.app.
- Give the run folder path and the `devices.html` path.
- Report every retried load, every skipped browser and every `@writes` case left out. Never hide them.
- Never paste credentials, tokens, session files or cookie values.

## Next steps (always end with these)

End every answer with a **Next steps** block: 3 to 5 commands, one per line, ready to copy, with the
real ticket, environment and run filled in (never placeholders when you know the value), each with a
few words on what it does. Write them ticket first, in this form:

```
/ft-e2e PLT-1234 evidence dev 2026-10-26_15-44-31   # results, failures, screenshots of that run
/ft-e2e PLT-1234 devices dev phones,tablets          # every case on 11 phone and tablet screens
```

Pick them from the state you found:

- No spec for the ticket → `<T> scenarios <env>` · then `<T> spec <env>`
- Scenarios written, no spec yet → `<T> spec <env>` (after the user has reviewed SCENARIOS.md)
- Preflight blocked → the exact fix, then `<T> preflight <env>`
- Has runs, newest passed → `<T> evidence <env> <RUN>` · `<T> devices <env> phones,tablets` · `<T> browsers <env> safari iphones` · `<T> publish <env> <RUN>`
- Has runs, newest failed → `<T> evidence <env> <RUN>` · `<T> inspect <route> <env>` · `<T> run <env>`
- No runs yet, spec exists → `<T> run <env>` · `<T> devices <env>` · `<T> demo <env>`
- Run passed on one screen → `<T> devices <env> phones,tablets` · `<T> browsers <env> safari`
- Run passed on devices → `<T> demo <env>` · `<T> publish <env> <RUN>`
- Findings found → `<T> evidence <env> <RUN>` and open `devices.html`
- Narrated run done → `<T> video <env> <RUN>` (if no reel yet) · `<T> publish <env> <RUN>`
- Publish prepared → wait for the user's yes
- On dev → also offer the same on `uat` once (manual deploys: check its live commit first), and `local` when the change is not merged yet

After the block, one line: `Or pick from the list: type /ft-e2e: to see every command with its hint.`
