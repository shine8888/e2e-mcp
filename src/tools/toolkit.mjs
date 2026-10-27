// Toolkit doctor: what is missing for each feature, and installing the safe parts.
import { z } from 'zod'
import { FEATURE_NAMES, checkToolkit, installToolkit } from '../scenarios/toolkit.mjs'

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: true })

export function registerToolkitTools (server) {
  server.registerTool('check_toolkit', {
    title: 'Check what this machine needs for each e2e feature',
    description: 'Read-only doctor. For each feature (core, dev, uat, local, demo, devices, browsers, publish) '
      + 'reports ready / not ready, and for every missing piece: what it is, why it is needed, and the fix: '
      + 'kind "auto" (install_toolkit can do it: npm install, Playwright browser downloads, Homebrew ffmpeg) '
      + 'or "manual" (an admin password such as Edge, a secret such as the Linear API key or a test user, '
      + 'Docker Desktop, or the repo\'s first-time scripts/agent/setup.sh). Checks Node, harness and MCP '
      + 'dependencies, Playwright Chromium / Firefox / WebKit / ffmpeg at the revision this Playwright expects, '
      + 'Chrome and Edge (optional), the local stack (fintary checkout with scripts/agent, the repo\'s Node under '
      + 'nvm, pnpm, Docker), system ffmpeg with VP8 and H.264, ffprobe, the per-environment test-user files and '
      + 'the Linear API key (never their values). Call it when a user asks what to install, before a first run, '
      + 'or when a run reports a missing tool.',
    inputSchema: {
      features: z.array(z.enum(FEATURE_NAMES)).optional().describe('Only these features (core is always included). Omit for all.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => json(await checkToolkit(args)))

  server.registerTool('install_toolkit', {
    title: 'Install the missing toolkit pieces that are safe to install',
    description: 'Runs the "auto" fixes from check_toolkit: npm install in the harness / ft-e2e-mcp, '
      + '`npx playwright install chromium|firefox|webkit|ffmpeg` into the Playwright cache, `brew install '
      + 'ffmpeg`. Downloads can take minutes. Never runs a "manual" fix (admin password, secret, Docker, repo setup): those '
      + 'come back with their command for the user. Only call when the user asked to install; list the '
      + 'items you will install and their commands first. Re-checks afterwards.',
    inputSchema: {
      items: z.array(z.string()).optional().describe('Requirement ids from check_toolkit, e.g. ["pw-firefox","pw-webkit"]. Omit for every missing auto item.'),
      features: z.array(z.enum(FEATURE_NAMES)).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    const res = await installToolkit(args)
    return res.ok ? json(res) : fail(res)
  })
}
