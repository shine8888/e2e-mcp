// MCP surface for recordings. Same functions as `bin/ft-e2e-run.mjs videos` /
// `demo-video`, so the CLI and the MCP server cannot disagree.
import { z } from 'zod'
import { DEFAULT_ENV, ENV_NAMES } from '../env.mjs'
import { buildDemoVideo, listVideos } from '../scenarios/video.mjs'

const envEnum = z.enum(ENV_NAMES)
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: true })

export function registerVideoTools (server) {
  server.registerTool('list_videos', {
    title: 'List a run\'s recordings',
    description: 'Every test in a ticket\'s latest run with its video.webm (path, resolution, '
      + 'duration), whether it was recorded in demo mode (captions + action highlights), and '
      + 'the stitched report.webm if one has been built. Read-only.',
    inputSchema: {
      ticket: z.string().describe('Ticket folder, e.g. "PLT-1234".'),
      env: envEnum.default(DEFAULT_ENV),
      run: z.string().optional().describe('A run id from list_runs. Omit for the newest run.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    try {
      const res = listVideos(args)
      return res.ok ? json(res) : fail(res)
    } catch (err) {
      return fail({ ok: false, error: err.message })
    }
  })

  server.registerTool('build_demo_video', {
    title: 'Stitch a demo video',
    description: 'Joins a ticket\'s latest run into ONE shareable test-report video (report.webm): a title card (ticket, '
      + 'environment, the commits actually tested), each test\'s recording, and a PASS/FAIL '
      + 'summary card -- with a WebM chapter per test so a player can jump between them. '
      + 'Recordings made with run_e2e demo:true already carry numbered step captions, action '
      + 'highlights and their own chapter card; older plain recordings get a "Test N of M" '
      + 'card in front instead (interstitials: "auto"). Runs nothing -- it only re-encodes '
      + 'what the last run recorded. A run recorded with voice also gets a spoken Opus track: the cards are '
      + 'read aloud and each recording carries its own timed lines. Output: tickets/<ticket>/<evidence dir>/runs/<run>/report.webm.',
    inputSchema: {
      ticket: z.string(),
      env: envEnum.default(DEFAULT_ENV),
      run: z.string().optional().describe('A run id from list_runs. Omit for the newest run; the reel is written into that run\'s folder.'),
      interstitials: z.enum(['auto', 'always', 'never']).default('auto')
        .describe('"auto" adds a per-test card only where the recording has no chapter card of its own.'),
      voice: z.boolean().default(true).describe('Keep the spoken track when the run was recorded with voice. false = a silent reel.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async (args) => {
    try {
      const res = await buildDemoVideo(args)
      return res.ok ? json(res) : fail(res)
    } catch (err) {
      return fail({ ok: false, error: err.message })
    }
  })
}
