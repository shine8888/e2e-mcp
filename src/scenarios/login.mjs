// Makes a working session so a run is not blocked by one that simply died. The
// harness owns the flow (scripts/sign-in.mjs -> lib/firebase.cjs); this only
// starts it and waits:
//   - password: the web's own sign-in form with E2E_EMAIL / E2E_PASSWORD from
//     harness/<env file>, ~10 s, headless;
//   - local with E2E_UID: the fintary repo's custom-token / emulator sign-in scripts.
// The session is a storageState WITH IndexedDB (where Firebase keeps the user).
import { runInHarness } from '../ft-e2e.mjs'

export async function refreshLogin (env, { force = false } = {}) {
  const started = Date.now()
  const how = 'scripts/sign-in.mjs (the web\'s sign-in form with the env file\'s test user; E2E_UID on local uses the repo\'s custom-token scripts)'
  const res = await runInHarness('node', ['scripts/sign-in.mjs', '--env', env.harnessEnv, ...(force ? ['--force'] : [])], { timeoutMs: 4 * 60_000 })
  // The script prints a masked e-mail and never a token; keep only the last lines anyway.
  const tail = `${res.stdout}\n${res.stderr}`.trim().split('\n').slice(-6).join('\n')
  return {
    attempted: true,
    how,
    ok: res.code === 0 && !res.timedOut,
    timedOut: res.timedOut,
    seconds: Math.round((Date.now() - started) / 1000),
    detail: tail,
  }
}
