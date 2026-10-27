// Browser engines a cross-browser run can use. `chromium` is the default for
// every run: Playwright's own Chromium build, already in the Playwright cache, no
// admin password needed. The others are opt-in.
export type BrowserDef = { name: string, label: string, use: Record<string, unknown>, mobileEmulation: boolean }

export const BROWSERS: Record<string, BrowserDef> = {
  chromium: { name: 'chromium', label: 'Chromium', use: { browserName: 'chromium' }, mobileEmulation: true },
  chrome: { name: 'chrome', label: 'Chrome', use: { browserName: 'chromium', channel: 'chrome' }, mobileEmulation: true },
  edge: { name: 'edge', label: 'Edge', use: { browserName: 'chromium', channel: 'msedge' }, mobileEmulation: true },
  // Firefox cannot emulate isMobile: phones get viewport + touch only.
  // It records headless: a visible Firefox on a Retina screen records the
  // top-left quarter at 2x. HEADED_FIREFOX=1 to watch it anyway.
  firefox: { name: 'firefox', label: 'Firefox', use: { browserName: 'firefox', ...(process.env.HEADED_FIREFOX ? {} : { headless: true }) }, mobileEmulation: false },
  // WebKit = Safari's engine, not Safari.app (Apple does not let Playwright drive it).
  safari: { name: 'safari', label: 'Safari (WebKit)', use: { browserName: 'webkit' }, mobileEmulation: true },
}

export function expandBrowsers (list: string[]): BrowserDef[] {
  const names = list.flatMap(b => (b === 'all' ? ['chromium', 'firefox', 'safari'] : [b === 'webkit' ? 'safari' : b === 'msedge' ? 'edge' : b]))
  return [...new Set(names)].map((n) => {
    const def = BROWSERS[n]
    if (!def) throw new Error(`Unknown browser "${n}". Known: ${Object.keys(BROWSERS).join(', ')}`)
    return def
  })
}
