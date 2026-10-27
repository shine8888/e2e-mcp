// Shared config + process-spawning helpers for talking to the ft-e2e harness.
// Every tool in this server calls into the harness's OWN scripts/config rather
// than re-implementing any of its logic -- this is a thin MCP wrapper, not a fork.
//
// The harness ships inside this package (./harness); FT_E2E_DIR points the
// server at another checkout of it. FINTARY_DIR is the Fintary monorepo under
// test (git stamps, the local stack, its sign-in scripts).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const FT_E2E_DIR = process.env.FT_E2E_DIR || path.join(MCP_DIR, 'harness')

// install.sh sets FINTARY_DIR; otherwise a checkout next to this package, then the usual workspace path.
const isFintary = d => fs.existsSync(path.join(d, 'pnpm-workspace.yaml')) && fs.existsSync(path.join(d, 'services', 'web', 'package.json'))
export const FINTARY_DIR = process.env.FINTARY_DIR
  || [path.resolve(MCP_DIR, '..', 'fintary'), path.join(os.homedir(), 'Documents/WorkSpaces/FINTARY/fintary')].find(isFintary)
  || path.resolve(MCP_DIR, '..', 'fintary')

export function assertHarnessDir () {
  if (!fs.existsSync(path.join(FT_E2E_DIR, 'playwright.config.ts'))) {
    throw new Error(
      `FT_E2E_DIR (${FT_E2E_DIR}) does not look like an ft-e2e harness `
      + '(no playwright.config.ts found). Set FT_E2E_DIR to the real path.',
    )
  }
}

/**
 * Runs a command inside the harness and collects its output.
 * Never throws on a non-zero exit -- callers decide what a failing exit code
 * means for their tool (a failed test run is a normal, reportable outcome, not
 * a wrapper-level error).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, extraEnv?: Record<string, string> }} [opts]
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runInHarness (cmd, args, opts = {}) {
  assertHarnessDir()
  const { timeoutMs = 60_000, extraEnv = {} } = opts
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: FT_E2E_DIR,
      env: { ...process.env, PATH: childPath(), FINTARY_DIR, ...extraEnv },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => { stderr += err.message })
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

/**
 * PATH with this server's own node first. Claude Code can start the server
 * without nvm's shims on PATH ("Executable not found in $PATH: node"), and then
 * every `npx playwright` it spawns fails the same way. Running under an
 * absolute node path fixes the server; this makes its children find the same
 * node, plus Homebrew (ffmpeg, ffprobe).
 */
export function childPath () {
  const nodeDir = path.dirname(process.execPath)
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter(p => p && p !== nodeDir)
  return [nodeDir, ...rest, '/opt/homebrew/bin', '/usr/local/bin'].join(path.delimiter)
}

export function textResult (text) {
  return { content: [{ type: 'text', text }] }
}

export function errorResult (text) {
  return { content: [{ type: 'text', text }], isError: true }
}

export function jsonResult (value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}
