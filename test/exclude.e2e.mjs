// End to end test of the excluded domains list: loads the unpacked extension
// into Chromium, excludes a domain from one panel, and checks that every panel
// follows, that nothing from the domain is searched, saved or grouped, and that
// the list survives an extension reload and a browser restart.
//
//   node test/exclude.e2e.mjs
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const page = (title, word) =>
  `<!doctype html><title>${title}</title><body><p>excludemarker ${word} ${'filler text about gardens '.repeat(10)}</p></body>`
const PAGES = {
  '/a': page('Alpha Garden', 'alpha'),
  '/b': page('Beta Garden', 'beta'),
  '/c': page('Gamma Garden', 'gamma'),
}

const server = http.createServer((req, res) => {
  const body = PAGES[new URL(req.url, 'http://x').pathname]
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body || 'not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const url = (host, p) => `http://${host}:${port}${p}`

let checks = 0
let fails = 0
function ok(c, label, extra) {
  checks++
  if (!c) {
    fails++
    console.log('FAIL ' + label + (extra ? ' :: ' + extra : ''))
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-ex-'))
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage'],
  })

let ctx = await launch()
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }))
const id = new URL(sw.url()).host
const PANEL = `chrome-extension://${id}/sidepanel.html`

const openAll = async () => {
  for (const [host, p] of [
    ['localhost', '/a'],
    ['foo.localhost', '/b'],
    ['127.0.0.1', '/c'],
  ]) {
    const pg = await ctx.newPage()
    await pg.goto(url(host, p), { waitUntil: 'load' })
  }
}

const openPanel = async () => {
  const pg = await ctx.newPage()
  await pg.goto(PANEL)
  await pg.waitForFunction(() => /tabs indexed/.test(document.querySelector('#status').textContent), null, {
    timeout: 30000,
    polling: 100,
  })
  return pg
}

const search = async (pg, q = 'excludemarker') => {
  await pg.bringToFront()
  await pg.fill('#q', '')
  await pg.fill('#q', q)
  await pg.waitForTimeout(600)
  return {
    count: await pg.textContent('#count'),
    titles: await pg.$$eval('#results .tabhead .title', (n) => n.map((x) => x.textContent).sort()),
  }
}

const listed = (pg) => pg.$$eval('#exlist li .h', (n) => n.map((x) => x.textContent))
const savedUrls = (pg) => pg.evaluate(async () => (await dbAll()).map((r) => r.url))

await openAll()
const p1 = await openPanel()
let s = await search(p1)
ok(s.count === '3 matches in 3 tabs', 'all three tabs searchable at first', s.count)

const p2 = await openPanel()

// exclude from the first panel, by keyboard
await p1.bringToFront()
ok((await p1.isHidden('#exbox')), 'the list starts closed')
await p1.click('#exclude')
ok(await p1.isVisible('#exbox'), 'the button opens the list')
ok((await p1.textContent('#exlist')).includes('No domains are excluded'), 'empty list says so')
await p1.fill('#exadd', 'https://www.localhost/some/path')
await p1.press('#exadd', 'Enter')
await p1.waitForTimeout(600)
ok(JSON.stringify(await listed(p1)) === '["localhost"]', 'the domain is normalised as the filter does', JSON.stringify(await listed(p1)))
ok((await p1.inputValue('#exadd')) === '', 'the box empties after adding')

s = await search(p1)
ok(s.count === '1 matches in 1 tabs', 'localhost and its subdomain are no longer searched', s.count)
ok(JSON.stringify(s.titles) === '["Gamma Garden"]', 'only the other domain is found', JSON.stringify(s.titles))
const urls = await savedUrls(p1)
ok(!urls.some((u) => u.includes('localhost:')), 'saved text of the excluded tabs is deleted', JSON.stringify(urls))
ok(urls.some((u) => u.includes('127.0.0.1')), 'saved text of other tabs is kept', JSON.stringify(urls))

// the bad list names them
await p1.click('#status button')
await p1.waitForTimeout(300)
const whys = await p1.$$eval('#bad .tabhead', (n) => n.map((x) => x.textContent))
ok(whys.filter((w) => w.includes('Excluded')).length === 2, 'both tabs are listed as Excluded', JSON.stringify(whys))

// Escape closes the list
await p1.focus('#exadd')
await p1.keyboard.press('Escape')
ok(await p1.isHidden('#exbox'), 'Escape closes the list')

// the other panel follows
s = await search(p2)
ok(s.count === '1 matches in 1 tabs', 'the other panel stops searching them too', s.count)
ok(JSON.stringify(await listed(p2)) === '["localhost"]', 'the other panel shows the same list')

// a reload of an excluded tab is not read
const alpha = ctx.pages().find((pg) => pg.url().includes('/a'))
await alpha.reload({ waitUntil: 'load' })
await p1.waitForTimeout(800)
s = await search(p1)
ok(s.count === '1 matches in 1 tabs', 'a reloaded excluded tab is not read', s.count)

// Subjects does not group them
await p1.click('#v-subjects')
await p1.waitForTimeout(1500)
const rest = await p1.$$eval('#cats .rest', (n) => n.map((x) => x.textContent).join(' | '))
ok(rest.includes('Alpha Garden') && rest.includes('Beta Garden'), 'Subjects lists excluded tabs apart', rest)
await p1.click('#v-search')

// survives an extension reload
const ext = await ctx.newPage()
await ext.goto('chrome://extensions/')
await ext.evaluate(() => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)))
await ext.close()
await p1.evaluate(() => setTimeout(() => chrome.runtime.reload(), 50))
await p1.waitForEvent('close', { timeout: 20000 }).catch(() => {})
await new Promise((r) => setTimeout(r, 1500))
let p3 = await openPanel()
ok(JSON.stringify(await listed(p3)) === '["localhost"]', 'the list survives an extension reload')
s = await search(p3)
ok(s.count === '1 matches in 1 tabs', 'still excluded after an extension reload', s.count)

// survives a browser restart
await ctx.close()
ctx = await launch()
await (ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker', { timeout: 20000 }))
for (const pg of ctx.pages()) if (pg.url().startsWith('chrome-extension://')) await pg.close()
if (!ctx.pages().some((pg) => pg.url().includes(':' + port))) await openAll()
p3 = await openPanel()
ok(JSON.stringify(await listed(p3)) === '["localhost"]', 'the list survives a browser restart')
s = await search(p3)
ok(s.count === '1 matches in 1 tabs', 'still excluded after a browser restart', s.count)

// removing the domain reads its tabs again
await p3.click('#exclude')
await p3.click('#exlist button')
await p3.waitForTimeout(1500)
s = await search(p3)
ok(s.count === '3 matches in 3 tabs', 'removing the domain makes its tabs searchable again', s.count)
ok((await p3.textContent('#exlist')).includes('No domains are excluded'), 'the list is empty again')

await ctx.close()
server.close()
fs.rmSync(profile, { recursive: true, force: true })
console.log(`${checks - fails}/${checks} checks passed`)
process.exit(fails ? 1 : 0)
