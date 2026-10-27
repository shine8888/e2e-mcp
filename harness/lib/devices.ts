// The screens a multi-device run can cover. Every entry comes from a Playwright
// 1.60 device profile (viewport, pixel ratio, touch, isMobile, user agent);
// nothing here is a hand-made guess at a phone. A newer phone that has no
// profile in this Playwright is left out rather than approximated.
//
// The MCP server parses this file (src/scenarios/devices.mjs) by regex, so keep
// every entry on one line in the form  from('<name>', '<label>', '<descriptor>'[, { width: W, height: H }])
// and keep labels free of quotes.
//
// Everything runs in Chromium unless the run also names browsers: the iPad and
// iPhone entries are Apple viewports + user agents in Chrome's engine, so a
// WebKit-only bug needs `browsers: safari`.
import { devices } from '@playwright/test'

export type Screen = {
  name: string
  label: string
  descriptor: string
  kind: 'desktop' | 'tablet' | 'phone'
  use: Record<string, unknown>
}

function from (name: string, label: string, descriptor: string, viewport?: { width: number, height: number }): Screen {
  const base = devices[descriptor]
  if (!base) throw new Error(`Playwright has no device profile "${descriptor}" (lib/devices.ts: ${name})`)
  const { defaultBrowserType: _ignored, ...use } = base as any
  const vp = viewport ?? base.viewport
  const kind = !base.isMobile ? 'desktop' : (Math.min(vp.width, vp.height) >= 600 ? 'tablet' : 'phone')
  return { name, label, descriptor, kind, use: { ...use, viewport: vp, ...(viewport && !base.isMobile ? { screen: viewport } : {}) } }
}

export const SCREENS: Screen[] = [
  // Desktop
  from('desktop', 'Desktop 1440x900', 'Desktop Chrome', { width: 1440, height: 900 }),
  from('laptop', 'Laptop 1280x800', 'Desktop Chrome', { width: 1280, height: 800 }),
  // Tablet
  from('tablet', 'iPad 10.2in portrait 810x1080', 'iPad (gen 7)'),
  from('tablet-landscape', 'iPad 10.2in landscape 1080x810', 'iPad (gen 7) landscape'),
  from('ipad-mini', 'iPad Mini 768x1024', 'iPad Mini'),
  from('ipad-pro-11', 'iPad Pro 11 834x1194', 'iPad Pro 11'),
  from('galaxy-tab-s9', 'Galaxy Tab S9 640x1024', 'Galaxy Tab S9'),
  // iPhone
  from('iphone-se', 'iPhone SE 3rd gen 375x667', 'iPhone SE (3rd gen)'),
  from('iphone-14', 'iPhone 14 390x664', 'iPhone 14'),
  from('iphone-14-plus', 'iPhone 14 Plus 428x746', 'iPhone 14 Plus'),
  from('iphone-14-pro', 'iPhone 14 Pro 393x660', 'iPhone 14 Pro'),
  from('iphone-14-pro-max', 'iPhone 14 Pro Max 430x740', 'iPhone 14 Pro Max'),
  from('iphone-15', 'iPhone 15 393x659', 'iPhone 15'),
  from('iphone-15-plus', 'iPhone 15 Plus 430x739', 'iPhone 15 Plus'),
  from('iphone-15-pro', 'iPhone 15 Pro 393x659', 'iPhone 15 Pro'),
  from('iphone-15-pro-max', 'iPhone 15 Pro Max 430x739', 'iPhone 15 Pro Max'),
  // Android
  from('mobile', 'Pixel 7 412x839', 'Pixel 7'),
  from('pixel-5', 'Pixel 5 393x727', 'Pixel 5'),
  from('galaxy-s24', 'Galaxy S24 360x780', 'Galaxy S24'),
  from('galaxy-a55', 'Galaxy A55 480x1040', 'Galaxy A55'),
  from('galaxy-s9-plus', 'Galaxy S9+ 320x658', 'Galaxy S9+'),
  from('small', 'Small phone 320x568', 'iPhone SE', { width: 320, height: 568 }),
]

export const DEFAULT_DEVICES = ['desktop', 'tablet', 'mobile']

/** Named sets. Groups list distinct viewports; same-size profiles are left to be named explicitly. */
export const DEVICE_GROUPS: Record<string, string[]> = {
  iphones: ['iphone-se', 'iphone-14', 'iphone-15', 'iphone-14-plus', 'iphone-15-pro-max'],
  android: ['galaxy-s24', 'mobile', 'pixel-5', 'galaxy-a55', 'galaxy-s9-plus'],
  phones: ['iphone-se', 'iphone-15', 'iphone-15-pro-max', 'mobile', 'galaxy-s24', 'small'],
  tablets: ['tablet', 'tablet-landscape', 'ipad-mini', 'ipad-pro-11', 'galaxy-tab-s9'],
  desktops: ['desktop', 'laptop'],
  full: ['desktop', 'laptop', 'tablet', 'tablet-landscape', 'iphone-15', 'mobile', 'small'],
}

/** Names and group names -> screens, in registry order, de-duplicated. */
export function expandDevices (list: string[]): Screen[] {
  const names = new Set<string>()
  for (const item of list) {
    if (item === 'all') SCREENS.forEach(s => names.add(s.name))
    else if (item === 'default') DEFAULT_DEVICES.forEach(n => names.add(n))
    else if (DEVICE_GROUPS[item]) DEVICE_GROUPS[item].forEach(n => names.add(n))
    else if (SCREENS.some(s => s.name === item)) names.add(item)
    else throw new Error(`Unknown device "${item}". Screens: ${SCREENS.map(s => s.name).join(', ')}. Groups: ${Object.keys(DEVICE_GROUPS).join(', ')}, all.`)
  }
  return SCREENS.filter(s => names.has(s.name))
}
