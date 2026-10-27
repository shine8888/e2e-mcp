#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerDevStackTools } from './tools/dev-stack.mjs'
import { registerInspectTool } from './tools/inspect.mjs'
import { registerEvidenceTools } from './tools/evidence.mjs'
import { registerScenarioTools } from './tools/scenarios.mjs'
import { registerVideoTools } from './tools/video.mjs'
import { registerDeviceTools } from './tools/devices.mjs'
import { registerPublishTools } from './tools/publish.mjs'
import { registerToolkitTools } from './tools/toolkit.mjs'

const server = new McpServer({ name: 'ft-e2e-mcp', version: '0.1.0' })

registerScenarioTools(server)   // list_environments, preflight, prepare, run_e2e, build_report
registerDevStackTools(server)   // dev_stack_status / up / down (local Fintary stack, scripts/agent)
registerInspectTool(server)     // inspect_page
registerEvidenceTools(server)   // get_evidence, get_api_calls, list_tickets
registerVideoTools(server)      // list_videos, build_demo_video
registerDeviceTools(server)     // list_devices, build_device_report
registerPublishTools(server)    // prepare_linear_publish, publish_to_linear, linear_publish_status
registerToolkitTools(server)    // check_toolkit, install_toolkit

await server.connect(new StdioServerTransport())
