// Multi-device surface: the screen registry and the case × screen report.
import { z } from 'zod'
import { DEFAULT_ENV, ENV_NAMES } from '../env.mjs'
import { buildDeviceReport, listBrowsers, listDeviceGroups, listDevices } from '../scenarios/devices.mjs'

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: true })

export function registerDeviceTools (server) {
  server.registerTool('list_devices', {
    title: 'List the screens a multi-device run can cover',
    description: 'The device registry from harness/lib/devices.ts: name, label (viewport) and the '
      + 'Playwright 1.60 descriptor its emulation comes from. `default: true` marks the set used when '
      + 'the caller just says "multi-device" (desktop, tablet, mobile). Everything runs in Playwright\'s '
      + 'Chromium with device emulation unless browsers says otherwise; iPad/iPhone entries are Apple viewports '
      + 'and user agents in Chromium, not Safari (browsers:["safari"] for WebKit). Groups name sets with distinct '
      + 'viewports: iphones (SE/14/15/14 Plus/15 Pro Max), android (Galaxy S24, Pixel 7, Pixel 5, Galaxy A55, '
      + 'Galaxy S9+), phones, tablets, desktops, full, all.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => json({ screens: listDevices(), groups: listDeviceGroups(), browsers: listBrowsers(),
    notAvailable: 'iPhone 16/17 and Galaxy S25 have no device profile in the harness\'s Playwright (1.60); they are not emulated rather than guessed.' }))

  server.registerTool('build_device_report', {
    title: 'Build the case × screen report for a multi-device run',
    description: 'For a run made with run_e2e devices:[...], writes DEVICES.md (matrix, what broke, '
      + 'per-step screenshots side by side per screen, video links), devices.html (the same with '
      + 'thumbnails), devices.json and TEAM-UPDATE.md (paste-ready text for the Linear issue or '
      + 'Slack) into the run folder, and returns the verdict, matrix and issues. Layout checks: '
      + 'break = the page scrolls sideways on that screen (lists the elements sticking out); '
      + 'warning = touch targets under 24x24px or text under 12px on phones. Records selectors and '
      + 'sizes only, never page text. run_e2e already calls this for device runs; call it again '
      + 'after build_demo_video so the report links the reel.',
    inputSchema: {
      ticket: z.string(),
      env: z.enum(ENV_NAMES).default(DEFAULT_ENV),
      run: z.string().optional().describe('Run id from list_runs. Omit for the newest run.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async (args) => {
    const res = await buildDeviceReport(args)
    return res.ok ? json(res) : fail(res)
  })
}
