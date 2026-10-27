// Linear publishing: prepare locally (preview + digest), then post exactly that.
import { z } from 'zod'
import { DEFAULT_ENV, ENV_NAMES } from '../env.mjs'
import { credentialStatus, preparePublish, publishToLinear } from '../scenarios/publish.mjs'

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: true })

export function registerPublishTools (server) {
  server.registerTool('prepare_linear_publish', {
    title: 'Prepare a run for posting to its Linear issue (local only)',
    description: 'Builds, in <run>/publish/, everything a Linear post of this run would contain: the test '
      + 'report as an A4 PDF, up to maxImages annotated evidence images (defect evidence first, else the '
      + 'last figure of each passing case), the narrated reel converted to MP4, and the comment in Markdown '
      + '(verdict, one line per case with its screens, defects, links to the PDF and video, images inline). '
      + 'Sends NOTHING to Linear. Returns the comment text, file list with sizes, whether the API key is set, '
      + 'whether this run was already posted, and a digest. Show the user the comment and files -- and say to '
      + 'look at every image (shareable data only) -- and get an explicit yes before calling publish_to_linear '
      + 'with that digest.',
    inputSchema: {
      ticket: z.string().describe('The Linear issue identifier, e.g. "PLT-1234".'),
      env: z.enum(ENV_NAMES).default(DEFAULT_ENV),
      run: z.string().optional().describe('Run id from list_runs. Omit for the newest run.'),
      video: z.boolean().default(true).describe('Attach the narrated reel as MP4 when the run has one.'),
      maxImages: z.number().int().min(0).max(12).default(6),
      scopeNote: z.string().optional().describe('Cases deliberately not run, one per line with the reason (e.g. "TC-6: @writes, deletes a policy; left out"). Shown in the comment and the PDF scope.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async (args) => {
    const res = await preparePublish(args)
    return res.ok ? json(res) : fail(res)
  })

  server.registerTool('publish_to_linear', {
    title: 'Post a prepared run to its Linear issue',
    description: 'WRITES TO LINEAR: uploads the files prepared by prepare_linear_publish (fileUpload, then a '
      + 'PUT to the signed URL), adds each as an attachment on the issue, then adds one comment that embeds '
      + 'them. Only call after the user has seen the prepared comment and files and said yes. Requires the '
      + 'digest from that prepare call: if anything changed since, it refuses. Refuses a run that was already '
      + 'posted unless force:true. Stops before commenting if any upload fails. Never changes the issue\'s '
      + 'status, labels or assignee, and never touches another issue. Uses the personal API key in the macOS '
      + 'Keychain (service ft-e2e-linear) or LINEAR_API_KEY.',
    inputSchema: {
      ticket: z.string(),
      env: z.enum(ENV_NAMES).default(DEFAULT_ENV),
      run: z.string().optional(),
      digest: z.string().describe('The digest prepare_linear_publish returned for the payload the user approved.'),
      force: z.boolean().default(false).describe('Post again even though this run was already posted.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    const res = await publishToLinear(args)
    return res.ok ? json(res) : fail(res)
  })

  server.registerTool('linear_publish_status', {
    title: 'Check Linear publishing credentials',
    description: 'Whether a Linear API key is available (macOS Keychain service ft-e2e-linear, or LINEAR_API_KEY) '
      + 'and the command to add one. Never returns the key.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => json(credentialStatus()))
}
