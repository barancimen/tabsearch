// End to end test: loads the unpacked extension into a real Chromium, opens
// pages with known text, drives the side panel page and asserts on the index
// and on the results the panel renders.
//
//   npm install && npx playwright install chromium && npm test
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Occurrences of "needle" per page, case insensitive:
//   alpha 5 (3 in the body, 1 as "<needle>" text, 1 in an input value)
//   beta 1, gamma 1 (inside "needlework", hidden div), delta 1 (uppercase only)
const PAGES = {
  '/alpha': `<!doctype html><html><head><title>Alpha Handbook</title></head><body>
    <h1>Alpha</h1>
    <p>The needle sits in the haystack. A second needle too. Third needle here.</p>
    <p>Markup &lt;needle&gt; stays escaped.</p>
    <input value="hidden needle in a field">
  </body></html>`,
  '/beta': `<!doctype html><html><head><title>Beta Report</title>
    <meta name="description" content="A page about nothing in particular"></head>
    <body><p>Only one needle on this page.</p></body></html>`,
  '/gamma': `<!doctype html><html><head><title>Gamma Notes</title></head><body>
    <p>No straw here at all.</p>
    <script>var s = "needle inside a script tag"</script>
    <style>/* needle inside a style tag */</style>
    <div hidden>needlework in a hidden div</div>
  </body></html>`,
  '/delta': `<!doctype html><html><head><title>Delta Caps</title></head><body>
    <p>NEEDLE in capitals of the alphabet.</p></body></html>`,
  '/sleepy': `<!doctype html><title>Sleepy</title><body><p>wasreadbeforesleep text</p></body>`,
  '/article': `<!doctype html><title>Article</title><body><p>neverreadarticle ${'words of a server rendered page '.repeat(20)}</p></body>`,
  '/shell': `<!doctype html><title>Shell One</title><body><div id="root"></div>
    <script>root.textContent = ['shell', 'one', 'rendered'].join('')</script></body>`,
  '/shell2': `<!doctype html><title>Shell Two</title><body><div id="root"></div>
    <script>root.textContent = ['shell', 'two', 'rendered'].join('')</script></body>`,
  '/long': `<!doctype html><html><head><title>Long Page</title></head><body>
    <p>${'filler '.repeat(50000)} bodytailmarker</p>
    <input value="${'filler '.repeat(5000)} fieldtailmarker">
    <svg><style>svgskipmarker</style></svg>
    <noscript id="ns"></noscript>
    <script>ns.append(Object.assign(document.createElement('b'), { textContent: ['nested', 'skipmarker'].join('') }))</script>
  </body></html>`,
}

function pdfFile(objs) {
  let out = '%PDF-1.4\n'
  const offs = objs.map((b, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${b}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offs.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('')
  return out + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
}

const stream = (c) => `<</Length ${c.length}>>\nstream\n${c}\nendstream`

// Type3 font whose glyph "a" cannot be built, which makes pdf.js log a warning.
function brokenType3(text) {
  return pdfFile([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    stream(`BT /F1 18 Tf 72 700 Td (${text}) Tj ET`),
    '<</Type/Font/Subtype/Type3/FontBBox[0 0 750 750]/FontMatrix[0.001 0 0 0.001 0 0]/CharProcs<</a 6 0 R/b 7 0 R>>' +
      '/Encoding<</Type/Encoding/Differences[97/a/b]>>/FirstChar 97/LastChar 98/Widths[500 500]>>',
    stream('500 0 d0 /Missing Do'),
    stream('500 0 d0 0 0 100 100 re f'),
  ])
}

// One text string per page. An empty string makes a page with no text on it.
function pdf(pages) {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '']
  const kids = []
  const font = 3 + pages.length * 2
  pages.forEach((text, i) => {
    const page = 3 + i * 2
    kids.push(page + ' 0 R')
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 ${font} 0 R>>>>/Contents ${page + 1} 0 R>>`)
    objs.push(stream(text ? `BT /F1 18 Tf 72 700 Td (${text}) Tj ET` : ''))
  })
  objs[1] = `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages.length}>>`
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>')
  return pdfFile(objs)
}

// No .pdf in the paths: detection must not depend on the URL.
const PDFS = {
  '/paper': pdf(['first page of the paper', 'pdfsecondpagemarker on page two']),
  '/scan': pdf(['']),
  '/corrupt': '%PDF-1.4\nthis is not really a pdf',
  '/type3': brokenType3('abbabaabab'),
}

// /a/<n>: one Wikipedia article as a web page, for the Categories view
const ARTICLES = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'articles.json'), 'utf8')
).articles
const ARTICLE_NAMES = Object.keys(ARTICLES)
const article = (name) =>
  `<!doctype html><title>${name} - Wikipedia</title><body><nav>Main menu Search Donate Log in</nav><main>` +
  ARTICLES[name]
    .split(/\n+/)
    .map((x) => '<p>' + x.replace(/[<&]/g, '') + '</p>')
    .join('') +
  '</main></body>'

const srv = http.createServer((req, res) => {
  const a = /^\/a\/(\d+)$/.exec(req.url)
  if (a && ARTICLE_NAMES[a[1]]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(article(ARTICLE_NAMES[a[1]]))
  }
  const file = PDFS[req.url.split('?')[0]]
  if (file) {
    res.writeHead(200, { 'content-type': 'application/pdf' })
    return res.end(file)
  }
  const body = PAGES[req.url.split('?')[0]]
  if (!body) {
    res.writeHead(404)
    return res.end('missing')
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
})
// dual stack so 127.0.0.1, localhost, foo.localhost and [::1] all reach it
try {
  await new Promise((r, j) => {
    srv.once('error', j)
    srv.listen(0, '::', r)
  })
} catch (e) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
}
const port = srv.address().port
const origin = (h) => `http://${h}:${port}`
const base = origin('127.0.0.1')

let fails = 0
let checks = 0
const ok = (c, label, extra) => {
  checks++
  if (!c) {
    fails++
    console.log('FAIL ' + label + (extra ? ' :: ' + extra : ''))
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-prof-'))
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
})

let sw = ctx.serviceWorkers()[0]
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
const id = new URL(sw.url()).host
console.log('extension id: ' + id)
ok(!!id, 'extension service worker registered')

const open = async (p, host = '127.0.0.1') => {
  const page = await ctx.newPage()
  await page.goto(origin(host) + p, { waitUntil: 'load' })
  return page
}
// four distinct hosts, all loopback, so the domain filter has something to bite on
const alpha = await open('/alpha', '127.0.0.1')
const beta = await open('/beta', 'localhost')
const gamma = await open('/gamma', 'foo.localhost')
const delta = await open('/delta', '[::1]')
ok((await beta.title()) === 'Beta Report', 'localhost reaches the test server')
ok((await gamma.title()) === 'Gamma Notes', 'foo.localhost resolves and loads')

let panel = await ctx.newPage()
const consoleProblems = []
const listen = (pg) =>
  pg.on('console', (m) => {
    if (m.type() !== 'log' && m.type() !== 'info') consoleProblems.push(m.text())
  })
listen(panel)
await panel.goto(`chrome-extension://${id}/sidepanel.html`)
const text = (sel) => panel.textContent(sel)

const settle = async (q, dom) => {
  await panel.bringToFront()
  if (dom !== undefined) {
    await panel.fill('#dom', dom)
    await panel.waitForTimeout(300)
  }
  await panel.fill('#q', q)
  await panel.waitForTimeout(500)
  return {
    count: await text('#count'),
    titles: await panel.$$eval('#results .tabhead .title', (n) => n.map((x) => x.textContent)),
    marks: await panel.$$eval('mark', (n) => n.length),
    status: await text('#status'),
  }
}

const CATS_SETTLE = 900 // a little more than the view's regrouping interval
const p = (label, s) => console.log(label + ': ' + JSON.stringify(s))

// Reloads the extension, which closes its pages, and opens the panel again once
// the reloaded extension answers. Returns the new panel page.
async function reloadExtension(old) {
  // Chromium disables an unpacked extension that reloads without Developer
  // mode, which anyone loading this one unpacked has on
  const ext = await ctx.newPage()
  await ext.goto('chrome://extensions/')
  await ext.evaluate(() => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)))
  await ext.close()
  const startedAt = await old.evaluate(() => performance.timeOrigin)
  await old.evaluate(() => setTimeout(() => chrome.runtime.reload(), 50))
  await old.waitForEvent('close', { timeout: 20000 }).catch(() => {})
  for (let i = 0; i < 40; i++) {
    const pg = await ctx.newPage()
    try {
      await pg.goto(`chrome-extension://${id}/sidepanel.html`, { timeout: 5000 })
      if ((await pg.evaluate(() => performance.timeOrigin)) > startedAt) return pg
    } catch (e) {}
    await pg.close().catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('the extension did not come back after reloading')
}

await panel.waitForFunction(
  () => /not searchable/.test(document.querySelector('#status').textContent),
  null,
  { timeout: 30000, polling: 250 }
)
let s = { status: await text('#status') }
p('index', s)
ok(s.status === '4 tabs indexed, 2 not searchable', 'four http tabs indexed, blank and extension pages skipped', s.status)

// --- unreadable schemes ---------------------------------------------------
const blank = await open('/alpha')
await blank.goto('data:text/html,<p>needle in a data url</p>', { waitUntil: 'load' })
await panel.bringToFront()
await panel.waitForTimeout(600)
const ds = await text('#status')
p('data url tab', { status: ds })
ok(ds === '4 tabs indexed, 3 not searchable', 'data: url counted as not searchable', ds)
const dh = await panel.evaluate(() => document.querySelector('#results').innerHTML)
ok(!dh.includes('needle in a data url'), 'data: url text never indexed')
await blank.close()
await panel.bringToFront()
await panel.waitForTimeout(400)

// --- substring, case insensitive -----------------------------------------
s = await settle('needle')
p('substring', s)
ok(s.count === '8 matches in 4 tabs', 'substring match count', s.count)
ok(s.titles[0] === 'Alpha Handbook', 'busiest tab ranked first', JSON.stringify(s.titles))
ok(s.marks === 8, 'all matches highlighted', String(s.marks))

const html = await panel.innerHTML('#results')
ok(html.includes('&lt;needle&gt;'), 'page angle brackets escaped in snippets')
ok(!html.includes('<needle>'), 'no raw page markup injected')
ok(!/inside a script tag|inside a style tag/.test(html), 'script and style text excluded')
ok(html.includes('hidden needle in a field'), 'input values indexed')

// --- match case -----------------------------------------------------------
await panel.click('#cs')
s = await settle('needle')
p('case sensitive', s)
ok(s.count === '7 matches in 3 tabs', 'caps-only tab dropped', s.count)
ok(!s.titles.includes('Delta Caps'), 'Delta absent when matching case')

// --- whole word -----------------------------------------------------------
await panel.click('#ww')
s = await settle('needle')
p('whole word', s)
ok(s.count === '6 matches in 2 tabs', 'needlework excluded by whole word', s.count)
ok(s.titles.includes('Gamma Notes') === false, 'Gamma (needlework) dropped')

// --- regex ----------------------------------------------------------------
await panel.click('#cs')
await panel.click('#ww')
await panel.click('#re')
s = await settle('n[a-z]+dle')
p('regex', s)
ok(s.count === '8 matches in 4 tabs', 'regex finds every variant', s.count)

s = await settle('n[a-z+')
ok(s.count === 'Invalid pattern', 'invalid regex reported in the count slot', s.count)
ok((await text('#results')).includes('Invalid regular expression'), 'invalid regex explains itself in the pane')
ok(/tabs indexed/.test(s.status), 'index status left untouched by a bad pattern', s.status)

await panel.click('#re')

// --- jump to the match ----------------------------------------------------
s = await settle('haystack')
ok(s.count === '1 matches in 1 tabs', 'narrow query', s.count)
await panel.click('.hit >> nth=0')
await panel.waitForTimeout(700)
const active = await panel.evaluate(() => chrome.tabs.query({ active: true }).then((t) => (t[0] || {}).title))
ok(active === 'Alpha Handbook', 'clicking a hit activates the owning tab', String(active))
const sel = await alpha.evaluate(() => String(window.getSelection()))
ok(sel.toLowerCase().includes('haystack'), 'match revealed in the page', JSON.stringify(sel))

// --- reindex --------------------------------------------------------------
await panel.bringToFront()
await panel.click('#refresh')
await panel.waitForFunction(
  () => /not searchable/.test(document.querySelector('#status').textContent),
  null,
  { timeout: 30000, polling: 250 }
)
s = await settle('needle')
p('after reindex', s)
ok(s.count === '8 matches in 4 tabs', 'reindex restores full results', s.count)

// --- domain filter --------------------------------------------------------
s = await settle('needle', 'localhost')
p('domain localhost', s)
ok(s.count === '2 matches in 2 tabs on localhost', 'bare domain covers its subdomains', s.count)
ok(!s.titles.includes('Alpha Handbook') && s.titles.includes('Gamma Notes'), 'only localhost tabs kept', JSON.stringify(s.titles))

s = await settle('needle', 'foo.localhost')
p('domain foo.localhost', s)
ok(s.count === '1 matches in 1 tabs on foo.localhost', 'exact subdomain narrows it', s.count)
ok(s.titles.length === 1 && s.titles[0] === 'Gamma Notes', 'single subdomain group', JSON.stringify(s.titles))

s = await settle('needle', '127.0.0.1')
ok(s.count === '5 matches in 1 tabs on 127.0.0.1', 'dotted quad matches only that host', s.count)

s = await settle('needle', '[::1]')
ok(s.count === '1 matches in 1 tabs on [::1]', 'ipv6 literal matches', s.count)

s = await settle('needle', `http://127.0.0.1:${port}/alpha`)
p('domain pasted url', s)
ok(s.count === `5 matches in 1 tabs on 127.0.0.1:${port}`, 'pasted url normalises to host:port', s.count)

s = await settle('needle', '*.foo.localhost')
ok(s.count === '1 matches in 1 tabs on foo.localhost', 'wildcard prefix stripped', s.count)

s = await settle('needle', 'nope.example')
ok((await text('#results')).includes('No open tab matches nope.example.'), 'unknown domain says so', await text('#results'))

s = await settle('haystack', 'localhost')
ok((await text('#results')).includes('No matches in 2 tabs on localhost.'), 'in scope but no text match', await text('#results'))

await panel.fill('#dom', '')
await panel.waitForTimeout(200)
await panel.focus('#q')
await panel.focus('#dom')
await panel.waitForSelector('#domlist li', { timeout: 3000 })
const suggestions = await panel.$$eval('#domlist li .h', (n) => n.map((x) => x.textContent))
p('suggestions', suggestions)
ok(
  suggestions.join(',') === '127.0.0.1,[::1],foo.localhost,localhost',
  'the domain list offers every distinct hostname, sorted',
  suggestions.join(',')
)
if (process.env.SHOTS) {
  await panel.setViewportSize({ width: 320, height: 520 })
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'search.png') })
  await panel.setViewportSize({ width: 1280, height: 720 })
}
const widths = await panel.evaluate(() => [document.querySelector('#dom').offsetWidth, document.querySelector('#domlist').offsetWidth])
ok(widths[0] === widths[1], 'the domain list is as wide as the box', JSON.stringify(widths))
const order = await panel.evaluate(() => [document.querySelector('#dom').getBoundingClientRect().top, document.querySelector('#q').getBoundingClientRect().top])
ok(order[0] < order[1], 'the domain filter is above the search box', JSON.stringify(order))
await panel.keyboard.press('ArrowDown')
await panel.keyboard.press('ArrowDown')
await panel.keyboard.press('Enter')
ok((await panel.inputValue('#dom')) === '[::1]' && (await panel.isHidden('#domlist')), 'arrow keys and Enter pick a domain from the list', await panel.inputValue('#dom'))
await panel.fill('#dom', 'local')
await panel.waitForTimeout(100)
const narrowed = await panel.$$eval('#domlist li .h', (n) => n.map((x) => x.textContent))
ok(narrowed.join(',') === 'foo.localhost,localhost', 'typing narrows the list', narrowed.join(','))
await panel.keyboard.press('Escape')
ok((await panel.isHidden('#domlist')) && (await panel.inputValue('#dom')) === 'local', 'Escape closes the list and keeps the text')

s = await settle('needle', '')
p('filter cleared', s)
ok(s.count === '8 matches in 4 tabs', 'clearing the filter restores every tab', s.count)

// --- new tab appears ------------------------------------------------------
const extra = await open('/alpha')
await panel.bringToFront()
await panel.waitForTimeout(900)
s = await settle('needle')
ok(s.count === '13 matches in 5 tabs', 'newly opened tab added to the index', s.count)
await extra.close()
await panel.waitForTimeout(500)

// --- navigation invalidates ----------------------------------------------
await alpha.goto(base + '/gamma', { waitUntil: 'load' })
await panel.bringToFront()
await panel.waitForTimeout(900)
s = await settle('haystack')
ok(s.count === '0 matches' && s.titles.length === 0, 'navigated tab re-indexed, stale text gone', JSON.stringify(s))
s = await settle('needlework')
ok(s.count === '2 matches in 2 tabs', 'navigated tab contributes its new content', s.count)

// --- closed tab -----------------------------------------------------------
await delta.close()
await panel.bringToFront()
await panel.waitForTimeout(500)
s = await settle('capitals')
ok(s.count === '0 matches' && (await text('#results')).includes('No matches'), 'closed tab dropped from the index', s.count)

// --- no text limits -------------------------------------------------------
const long = await open('/long')
await panel.bringToFront()
await panel.waitForTimeout(900)
s = await settle('bodytailmarker')
ok(s.count === '1 matches in 1 tabs', 'text past 200,000 chars indexed', s.count)
s = await settle('fieldtailmarker')
ok(s.count === '1 matches in 1 tabs', 'field value past 20,000 chars indexed', s.count)
s = await settle('svgskipmarker')
ok(s.count === '0 matches', 'style inside svg excluded', s.count)
s = await settle('nestedskipmarker')
ok(s.count === '0 matches', 'elements nested in a skipped element excluded', s.count)
await long.close()
await panel.waitForTimeout(500)

// --- saved index ----------------------------------------------------------
const reopen = async () => {
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  await panel.waitForFunction(
    () => /not searchable/.test(document.querySelector('#status').textContent),
    null,
    { timeout: 30000, polling: 100 }
  )
}
await beta.evaluate(() => document.body.append('addedafterindex'))
await reopen()
s = await settle('only one needle')
ok(
  s.count === '1 matches in 1 tabs',
  'reopened panel serves the saved text',
  s.count +
    ' ' +
    JSON.stringify(await panel.evaluate(() => [S.query, S.domain, S.indexing, [...S.cache.values()].map((r) => r.title)]))
)
s = await settle('addedafterindex')
ok(s.count === '0 matches', 'reopened panel did not re-read an unchanged tab', s.count)

await panel.click('#refresh')
await panel.waitForTimeout(800)
s = await settle('addedafterindex')
ok(s.count === '1 matches in 1 tabs', 'reindex re-reads every tab', s.count)

await panel.goto('about:blank')
await beta.reload({ waitUntil: 'load' })
await beta.waitForTimeout(400)
await reopen()
s = await settle('addedafterindex')
ok(s.count === '0 matches', 'tab reloaded while the panel was closed is re-read', s.count)

// --- reloading the extension keeps the saved index --------------------------
await beta.evaluate(() => document.body.append('addedbeforereload'))
const kept = await panel.evaluate(() => dbAll().then((r) => r.length))
panel = await reloadExtension(panel)
listen(panel)
sw = ctx.serviceWorkers().find((w) => w.url().includes(id)) || sw
await reopen()
const keptAfter = await panel.evaluate(() => dbAll().then((r) => r.length))
ok(kept > 0 && keptAfter >= kept, 'reloading the extension keeps the saved index', kept + ' then ' + keptAfter)
s = await settle('addedbeforereload')
ok(s.count === '0 matches', 'after a reload, unchanged tabs are not read again', s.count)

// --- panel state survives closing the panel --------------------------------
await panel.setViewportSize({ width: 320, height: 260 })
await panel.click('#re')
s = await settle('e', '')
await panel.click('#status button')
await panel.focus('#q')
await panel.keyboard.press('ArrowDown')
await panel.keyboard.press('ArrowDown')
await panel.waitForTimeout(200)
const scrollable = await panel.evaluate(() => {
  const r = document.querySelector('#results')
  r.scrollTop = 60
  return r.scrollHeight - r.clientHeight
})
ok(scrollable >= 60, 'results scroll in the small panel', String(scrollable))
await panel.waitForTimeout(400)
const ui = () =>
  panel.evaluate(() => ({
    q: document.querySelector('#q').value,
    dom: document.querySelector('#dom').value,
    re: document.querySelector('#re').classList.contains('on'),
    open: !document.querySelector('#bad').hidden,
    sel: document.querySelector('.hit.sel') ? document.querySelector('.hit.sel').textContent : null,
    selIndex: S.sel,
    scroll: document.querySelector('#results').scrollTop,
  }))
const before = await ui()
await panel.goto('about:blank')
await reopen()
await panel.waitForTimeout(400)
const after = await ui()
ok(after.q === 'e', 'reopened panel keeps the query', JSON.stringify(after))
ok(await panel.evaluate(() => document.activeElement && document.activeElement.id === 'q'), 'a reopened panel puts the cursor in the search box')
ok(after.re, 'reopened panel keeps the options', JSON.stringify(after))
ok(after.open, 'reopened panel keeps the dropdown open', JSON.stringify(after))
ok(before.selIndex === 1 && after.sel === before.sel, 'reopened panel keeps the selected result', JSON.stringify([before, after]))
ok(after.scroll === before.scroll && before.scroll === 60, 'reopened panel keeps the scroll position', JSON.stringify([before.scroll, after.scroll]))
ok((await text('#count')) !== '', 'reopened panel shows the results', await text('#count'))
await panel.focus('#q')
await panel.evaluate(() => (document.querySelector('#results').scrollTop = 0))
await panel.keyboard.press('PageDown')
const paged = await panel.evaluate(() => [document.querySelector('#results').scrollTop, document.activeElement.id])
ok(paged[0] > 0 && paged[1] === 'q', 'Page Down in the search box scrolls the results', JSON.stringify(paged))
if (process.env.SHOTS) {
  await panel.setViewportSize({ width: 360, height: 520 })
  await panel.evaluate(() => (document.querySelector('#results').scrollTop = 0))
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'results.png') })
  await panel.setViewportSize({ width: 320, height: 260 })
}
await panel.evaluate(() => (document.querySelector('#results').scrollTop = 60))

const panel2 = await ctx.newPage()
await panel2.goto(`chrome-extension://${id}/sidepanel.html`)
await panel2.waitForTimeout(400)
ok((await panel2.inputValue('#q')) === 'e', 'a panel in another tab or window starts from the same state')
await panel2.fill('#dom', 'localhost')
await panel2.fill('#q', 'only one needle')
await panel2.click('#re')
await panel.waitForTimeout(500)
const synced = await ui()
ok(synced.q === 'only one needle' && synced.dom === 'localhost' && !synced.re, 'open panels follow each other', JSON.stringify(synced))
ok((await text('#count')) === '1 matches in 1 tabs on localhost', 'followed change reruns the search', await text('#count'))
await panel2.close()
await panel.click('#status button')
await panel.fill('#dom', '')
await panel.setViewportSize({ width: 1280, height: 720 })
await panel.waitForTimeout(300)

// --- categories ------------------------------------------------------------
// Two new windows whose tabs mix subjects: the groups must follow the text.
const art = (name) => base + '/a/' + ARTICLE_NAMES.indexOf(name)
const W1 = ['Pasta', 'Python (programming language)', 'Taj Mahal']
const W2 = ['Lasagna', 'JavaScript', 'Risotto', 'Rust (programming language)']
const winIds = await panel.evaluate(
  async ([a, b]) => [(await chrome.windows.create({ url: a })).id, (await chrome.windows.create({ url: b })).id],
  [W1.map(art), W2.map(art)]
)
await panel.waitForFunction(
  (n) => [...S.cache.values()].filter((r) => / - Wikipedia$/.test(r.title)).length === n,
  W1.length + W2.length,
  { timeout: 30000, polling: 200 }
)
await panel.bringToFront()
await panel.click('#v-subjects')
await panel.waitForSelector('#cats section.cat', { timeout: 10000 })
ok(await panel.evaluate(() => document.activeElement && document.activeElement.id === 'cats'), 'opening Subjects puts the focus on the list, ready for Page Down')
await panel.waitForTimeout(CATS_SETTLE)
const cats = () =>
  panel.$$eval('#cats section.cat', (secs) =>
    secs.map((s) => ({
      name: s.querySelector('.catname').textContent,
      rest: s.classList.contains('rest'),
      tabs: [...s.querySelectorAll('.cattab .title')].map((t) => t.textContent.replace(' - Wikipedia', '')),
      wins: [...s.querySelectorAll('.cattab .win')].map((t) => t.textContent),
    }))
  )
let cs = await cats()
p('categories', cs)
const groupOf = (name) => cs.find((c) => c.tabs.includes(name)) || {}
const food = groupOf('Pasta')
const code = groupOf('JavaScript')
ok(!food.rest && ['Lasagna', 'Risotto'].every((t) => food.tabs.includes(t)), 'food pages grouped across windows', JSON.stringify(food))
ok(!code.rest && ['Python (programming language)', 'Rust (programming language)'].every((t) => code.tabs.includes(t)), 'code pages grouped across windows', JSON.stringify(code))
ok(food !== code && !food.tabs.some((t) => code.tabs.includes(t)), 'tabs sharing a window are not grouped against their text')
ok(groupOf('Taj Mahal').rest, 'a page like no other is listed apart', JSON.stringify(groupOf('Taj Mahal')))
ok(food.name && food.name.split(', ').length <= 3, 'groups are named', food.name)
ok(new Set(food.wins).size === 2, 'tabs show which window they are in', JSON.stringify(food.wins))
ok(await panel.isHidden('#searchbar'), 'search controls are hidden in the categories view')
const note = await text('#catnote')
ok(/grouped by the words/i.test(note) && !(await panel.isHidden('#catnote')), 'without the model, the view says it groups by words', note)
const mainText = await panel.evaluate(() => [...S.cache.values()].find((r) => /^Pasta/.test(r.title)).main)
ok(mainText.length > 1000 && !/Main menu/.test(mainText), "a page's own content is kept apart from its menus", mainText.slice(0, 60))

await panel.locator('#cats .cattab', { hasText: 'Risotto' }).click()
await panel.waitForTimeout(300)
const catFront = await panel.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => (t[0] || {}).title))
ok(/^Risotto/.test(catFront || ''), 'clicking a tab in a group switches to it', catFront)

// grouped by window: one section per window, tabs in tab strip order
ok((await panel.getAttribute('#v-subjects', 'aria-selected')) === 'true', 'the Subjects tab is selected')
await panel.click('#v-windows')
await panel.waitForSelector('#cats .win-group', { timeout: 5000 })
const byWin = await panel.$$eval('#cats section.cat', (secs) =>
  secs.map((s) => ({
    name: s.querySelector('.catname').textContent,
    tabs: [...s.querySelectorAll('.cattab .title')].map((t) => t.textContent.replace(' - Wikipedia', '')),
    tags: s.querySelectorAll('.cattab .win').length,
  }))
)
p('by window', byWin.map((w) => [w.name, w.tabs.length]))
// SHOTS=<folder> saves a picture of the panel at side panel width
if (process.env.SHOTS) {
  await panel.setViewportSize({ width: 360, height: 640 })
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'windows.png') })
  await panel.emulateMedia({ colorScheme: 'dark' })
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'windows-dark.png') })
  await panel.emulateMedia({ colorScheme: 'light' })
  await panel.setViewportSize({ width: 1280, height: 720 })
}
ok(byWin.length === 3 && byWin.map((w) => w.name.slice(0, 2)).join() === 'W1,W2,W3', 'one section per window, named W1, W2, W3', JSON.stringify(byWin.map((w) => w.name)))
ok(JSON.stringify(byWin[1].tabs) === JSON.stringify(W1) && JSON.stringify(byWin[2].tabs) === JSON.stringify(W2), "each window lists its tabs in tab strip order", JSON.stringify(byWin.slice(1).map((w) => w.tabs)))
ok(/this window/.test(byWin[0].name), "the panel's own window is marked", byWin[0].name)
ok(byWin.every((w) => w.tags === 0), 'tabs carry no window tags when grouped by window')
ok((await panel.isHidden('#catopts')) && (await panel.isHidden('#catnote')), 'adjustments and the note are hidden when grouping by window')
await panel.click('#cats .cathead:has(.catname[title="Window 2"]) .tw')
ok((await panel.getAttribute('#cats .cathead:has(.catname[title="Window 2"])', 'aria-expanded')) === 'false', 'a window folds')
await panel.click('#cats .cathead:has(.catname[title="Window 2"]) .tw')
await panel.waitForTimeout(300)
const savedBy = await panel.evaluate(() => chrome.storage.local.get('ui').then((r) => r.ui.view))
ok(savedBy === 'windows', 'the Windows tab is saved as the view', savedBy)
await panel.click('#v-subjects')
await panel.waitForSelector('#cats section.cat:not(.win-group)', { timeout: 10000 })
ok(!(await panel.isHidden('#catopts')) && (await cats()).some((c) => c.name === food.name), 'switching back shows the categories again')

// the domain filter, in both groupings
const shownTabs = () =>
  panel.$$eval('#cats section.cat', (secs) =>
    secs.map((s) => ({
      name: s.querySelector('.catname').textContent,
      urls: [...s.querySelectorAll('.cattab .title')].map((t) => t.title),
    }))
  )
const hostOk = (u, d) => {
  try {
    const h = new URL(u).hostname
    return h === d || h.endsWith('.' + d)
  } catch (e) {
    return false
  }
}
ok(!(await panel.isHidden('#dom')), 'the domain filter shows in the categories view')
await panel.fill('#dom', 'localhost')
await panel.waitForTimeout(CATS_SETTLE)
let fs1 = await shownTabs()
p('subject, localhost', fs1)
ok(fs1.length && fs1.every((c) => c.urls.length && c.urls.every((u) => hostOk(u, 'localhost'))), 'by subject, only tabs on the domain show', JSON.stringify(fs1))
ok(!fs1.some((c) => c.name === food.name), 'categories with no tab on the domain are hidden')
await panel.click('#v-windows')
await panel.waitForTimeout(400)
fs1 = await shownTabs()
ok(fs1.length === 1 && /^W1/.test(fs1[0].name) && fs1[0].urls.every((u) => hostOk(u, 'localhost')), 'by window, only windows with tabs on the domain show', JSON.stringify(fs1))
await panel.fill('#dom', '127.0.0.1')
await panel.waitForTimeout(400)
fs1 = await shownTabs()
ok(['W2', 'W3'].every((w) => fs1.some((x) => x.name === w)), 'windows keep their numbers under a filter', JSON.stringify(fs1.map((x) => x.name)))
await panel.fill('#dom', 'nosuchsite.example')
await panel.waitForTimeout(400)
ok(/No open tab is on nosuchsite.example/.test(await text('#cats')), 'a domain with no tabs says so')
await panel.click('#v-search')
ok((await panel.inputValue('#dom')) === 'nosuchsite.example', 'the filter is the same one Search uses')
await panel.click('#v-subjects')
await panel.fill('#dom', '')
await panel.waitForTimeout(CATS_SETTLE)
ok((await cats()).some((c) => c.name === food.name), 'clearing the filter shows every category again')

// folding: the triangle or the name folds a group, Enter unfolds it
const folded = (name) =>
  panel.$eval(`#cats section.cat:has(.catname[title="${name}"])`, (s) => ({
    expanded: s.querySelector('.cathead').getAttribute('aria-expanded'),
    rowsShown: !s.querySelector('.catbody').hidden && s.querySelector('.catbody .cattab').offsetParent !== null,
  }))
const codeName = code.name
await panel.click(`#cats .cathead:has(.catname[title="${codeName}"]) .tw`)
let f = await folded(codeName)
ok(f.expanded === 'false' && !f.rowsShown, 'clicking the triangle folds a category', JSON.stringify(f))
await panel.click(`#cats .catname[title="${codeName}"]`)
f = await folded(codeName)
ok(f.expanded === 'true' && f.rowsShown, 'clicking the name unfolds it', JSON.stringify(f))
await panel.click(`#cats .catname[title="${food.name}"]`)
ok((await folded(food.name)).expanded === 'false', 'clicking a name folds a category')

// word counts are saved with the index; a marker planted in one shows the
// reopened panel uses them instead of counting again
const countsSaved = await panel.evaluate(async () => {
  const recs = (await dbAll()).filter((r) => / - Wikipedia$/.test(r.title))
  const all = recs.length === 7 && recs.every((r) => Array.isArray(r.terms) && r.terms.length > 10)
  const taj = recs.find((r) => /^Taj Mahal/.test(r.title))
  taj.terms = [['zzsavedmarker', 9]]
  await dbPut(taj)
  return all
})
ok(countsSaved, 'word counts are saved with the index')

await reopen()
await panel.waitForSelector('#cats section.cat', { timeout: 10000 })
ok(!(await panel.isHidden('#cats')), 'reopened panel keeps the categories view')
const marker = await panel.evaluate(() => [...S.cache.values()].find((r) => /^Taj Mahal/.test(r.title)).terms[0][0])
ok(marker === 'zzsavedmarker', 'reopened panel uses the saved word counts', marker)
await panel.waitForTimeout(CATS_SETTLE)
cs = await cats()
ok(groupOf('Pasta').name === food.name, 'reopened panel shows the same groups', JSON.stringify(groupOf('Pasta')))
ok((await folded(food.name)).expanded === 'false', 'a folded category stays folded after reopening')
await panel.focus(`#cats .cathead:has(.catname[title="${food.name}"])`)
await panel.keyboard.press('Enter')
ok((await folded(food.name)).expanded === 'true', 'Enter on a heading unfolds it')

// adjustments: sliders that regroup at once, each with a description on hover
ok(!(await panel.isHidden('#catopts')), 'adjustments show in the categories view')
await panel.click('#catopts summary')
const helps = await panel.$$eval('#catsliders .setting', (s) => s.map((x) => x.title))
ok(helps.length === 4 && helps.every((h) => h.length > 20), 'every slider has a description on hover', helps.length)
const modelHelp = await panel.$$eval('#modelbox, #modelfolder, #modeluse, #modeldl', (n) => n.map((x) => x.title))
ok(modelHelp.every((h) => h.length > 20), 'the model controls have descriptions on hover')
ok(/Not set up/.test(await text('#modelstate')) && /Download the model \(24 MB\)/.test(await text('#modeldl')), 'the model is offered for download', await text('#modelstate'))
ok(await panel.isHidden('#catsliders .setdef >> nth=0'), 'no default buttons before anything moves')
await panel.fill('#set-labelTerms', '1')
await panel.waitForTimeout(CATS_SETTLE)
cs = await cats()
const oneWord = cs.filter((c) => !c.rest)
ok(oneWord.length && oneWord.every((c) => !c.name.includes(',')), 'one word names after the slider moves', JSON.stringify(oneWord.map((c) => c.name)))
ok(!(await panel.isHidden('#catsliders .setting:has(#set-labelTerms) .setdef')), 'a moved slider offers its default')
ok((await panel.textContent('#catsliders .setting:has(#set-labelTerms) .setval')) === '1', 'the slider shows its value')
const groupsBefore = cs.filter((c) => !c.rest).length
await panel.fill('#set-category', '1000')
await panel.waitForTimeout(CATS_SETTLE)
cs = await cats()
ok(cs.filter((c) => !c.rest).length < groupsBefore, 'the strictest category setting makes fewer groups', JSON.stringify(cs.map((c) => c.tabs.length)))
const savedParams = await panel.evaluate(() => chrome.storage.local.get('catParams').then((r) => r.catParams.values.words))
ok(savedParams.labelTerms === 1 && savedParams.category === 0.2, 'settings are saved', JSON.stringify(savedParams))
await panel.click('#catreset')
await panel.waitForTimeout(CATS_SETTLE)
cs = await cats()
ok(groupOf('Pasta').name === food.name, 'set all to default brings the groups back', groupOf('Pasta').name)
await panel.click('#catopts summary')

// --- Live: every tab, most like the one being looked at first ---------------
const liveRows = () =>
  panel.evaluate(() => ({
    target: (document.querySelector('#cats .livehead .title') || {}).textContent,
    ranked: [...document.querySelectorAll('#cats .live .cattab')].map((r) => [
      r.querySelector('.title').textContent.replace(' - Wikipedia', ''),
      Number((r.querySelector('.score') || {}).textContent),
      !!r.querySelector('.dup'),
    ]),
  }))
const openHere = (url) =>
  panel.evaluate(async (u) => (await chrome.tabs.create({ windowId: (await chrome.windows.getCurrent()).id, url: u, active: true })).id, url)
const lasagnaTab = await openHere(art('Lasagna'))
await panel.waitForFunction((id) => S.cache.has(id), lasagnaTab, { timeout: 15000, polling: 200 })
await panel.bringToFront()
await panel.click('#v-live')
await panel.waitForFunction(() => document.querySelector('#cats .live .cattab'), null, { timeout: 10000, polling: 200 })
let lv = await liveRows()
p('live, lasagna', lv.ranked.slice(0, 4))
ok(/^Lasagna/.test(lv.target || ''), 'Live compares with the tab being looked at', lv.target)
// the test windows already have a Lasagna tab: that copy comes first, marked
ok(lv.ranked[0][0] === 'Lasagna' && lv.ranked[0][2], 'the same page open in another tab comes first, marked as a duplicate', JSON.stringify(lv.ranked[0]))
const others = (l) => l.ranked.filter((x) => !x[2]).slice(0, 2).map((x) => x[0])
ok(['Pasta', 'Risotto'].every((t) => others(lv).includes(t)), 'the tabs most like it come next', JSON.stringify(lv.ranked.slice(0, 4)))
ok(lv.ranked.every((x, i) => !i || lv.ranked[i - 1][1] >= x[1]), 'each tab shows its score, highest first')
ok(!(await panel.isHidden('#catnote')) && /Sorted by the words/.test(await text('#catnote')), 'Live says how it sorted', await text('#catnote'))
if (process.env.SHOTS) {
  await panel.setViewportSize({ width: 320, height: 560 })
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'live.png') })
  await panel.emulateMedia({ colorScheme: 'dark' })
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'live-dark.png') })
  await panel.emulateMedia({ colorScheme: 'light' })
  await panel.setViewportSize({ width: 1280, height: 720 })
}
const liveColor = await panel.$eval('#v-live', (b) => getComputedStyle(b).backgroundColor)
ok(liveColor === 'rgb(34, 197, 94)', 'the Live tab is bright green when chosen', liveColor)
const pythonTab = await openHere(art('Python (programming language)'))
await panel.waitForFunction((id) => S.cache.has(id), pythonTab, { timeout: 15000, polling: 200 })
await panel.bringToFront()
await panel.waitForFunction(() => /^Python/.test((document.querySelector('#cats .livehead .title') || {}).textContent || ''), null, { timeout: 10000, polling: 200 })
lv = await liveRows()
ok(['JavaScript', 'Rust (programming language)'].every((t) => others(lv).includes(t)), 'switching tabs sorts the list for the new tab', JSON.stringify(lv.ranked.slice(0, 4)))
await panel.evaluate((ids) => chrome.tabs.remove(ids), [lasagnaTab, pythonTab])
await panel.bringToFront()

// flat tabs that run to the top edge
const tabBox = await panel.$eval('#v-search', (b) => [b.getBoundingClientRect().top, getComputedStyle(b).borderTopLeftRadius])
ok(tabBox[0] === 0 && tabBox[1] === '0px', 'the tabs reach the top edge and have square corners', JSON.stringify(tabBox))
await panel.setViewportSize({ width: 320, height: 400 })
const fits = await panel.evaluate(() => [document.querySelector('#refresh').getBoundingClientRect().right, innerWidth])
ok(fits[0] <= fits[1], 'four tabs and the reindex button fit a 320 px panel', JSON.stringify(fits))
await panel.setViewportSize({ width: 1280, height: 720 })

await panel.click('#v-search')
ok(await panel.isHidden('#catopts'), 'adjustments are hidden in the search view')
await panel.evaluate((ids) => Promise.all(ids.map((w) => chrome.windows.remove(w))), winIds)
await panel.waitForTimeout(500)

// --- pdfs -----------------------------------------------------------------
const openPdf = async (p) => {
  const page = await ctx.newPage()
  await page.goto(base + p, { waitUntil: 'commit' })
  return page
}
await settle('')
const paper = await openPdf('/paper')
const scan = await openPdf('/scan')
const corrupt = await openPdf('/corrupt')
const paperType = await paper.evaluate(() => document.contentType)
ok(paperType === 'application/pdf', 'tab shows the built-in pdf viewer', paperType)
await panel.bringToFront()
await panel.waitForFunction(
  () => S.cache.size && [...S.cache.values()].some((r) => r.text.includes('pdfsecondpagemarker')) && S.failed.size >= 2,
  null,
  { timeout: 30000, polling: 200 }
)
s = await settle('pdfsecondpagemarker')
p('pdf', s)
ok(s.count === '1 matches in 1 tabs', 'text on page two of a pdf is found', s.count)
ok((await text('#results')).includes('page two'), 'pdf text shown in the snippet', await text('#results'))
await panel.reload()
await panel.waitForFunction(
  () => /not searchable/.test(document.querySelector('#status').textContent),
  null,
  { timeout: 30000, polling: 100 }
)
s = await settle('pdfsecondpagemarker')
ok(s.count === '1 matches in 1 tabs', 'pdf text comes back from the saved index', s.count)

// --- not searchable list --------------------------------------------------
await panel.waitForTimeout(800)
const line = await text('#status')
p('status with pdfs', line)
ok(/, \d+ not searchable$/.test(line), 'status text stays on one line', line)
ok(await panel.isHidden('#bad'), 'list starts collapsed')
ok((await panel.getAttribute('#status button', 'aria-expanded')) === 'false', 'toggle starts collapsed')
await panel.click('#status button')
await panel.waitForTimeout(200)
ok(await panel.isVisible('#bad'), 'toggle expands the list')
ok((await panel.getAttribute('#status button', 'aria-expanded')) === 'true', 'toggle reports expanded')
const rows = await panel.$$eval('#bad .tabhead', (n) => n.map((x) => x.querySelector('.why').textContent))
p('not searchable rows', rows)
ok(String(rows.length) === line.match(/(\d+) not searchable/)[1], 'one row per tab in the count', JSON.stringify(rows))
ok(rows.includes('Restricted by Chrome'), 'restricted tabs listed', JSON.stringify(rows))
ok(rows.includes('No text found'), 'pdf with no text listed', JSON.stringify(rows))
ok(rows.includes('PDF could not be read'), 'broken pdf listed', JSON.stringify(rows))
const corruptRow = panel.locator('#bad .tabhead', { hasText: 'PDF could not be read' })
await corruptRow.click()
await panel.waitForTimeout(400)
const front = await panel.evaluate(() => chrome.tabs.query({ active: true }).then((t) => (t[0] || {}).url))
ok(front === base + '/corrupt', 'clicking a row switches to that tab', String(front))
await panel.bringToFront()
await panel.click('#status button')
await panel.waitForTimeout(200)
ok(await panel.isHidden('#bad'), 'toggle collapses the list')
await paper.close()
await scan.close()
await corrupt.close()

const t3 = await openPdf('/type3')
await panel.bringToFront()
await panel.waitForFunction(
  () => [...S.cache.values()].some((r) => r.text.includes('abbabaabab')),
  null,
  { timeout: 30000, polling: 200 }
)
s = await settle('abbabaabab')
ok(s.count === '1 matches in 1 tabs', 'pdf with a broken Type3 glyph still gives its text', s.count)
ok(!consoleProblems.some((t) => t.includes('Type3')), 'pdf.js warnings stay out of the console', JSON.stringify(consoleProblems))
ok(!consoleProblems.some((t) => t.includes('local resource')), 'no refused favicon loads', JSON.stringify(consoleProblems))
await t3.close()

// --- suspended tabs -------------------------------------------------------
const discard = (sub) =>
  sw.evaluate(async (sub) => {
    const tabs = await chrome.tabs.query({})
    const t = tabs.find((x) => x.url.endsWith(sub))
    return (await chrome.tabs.discard(t.id)).discarded
  }, sub)
const tabInfo = (sub) =>
  sw.evaluate(async (sub) => {
    const tabs = await chrome.tabs.query({})
    const t = tabs.find((x) => x.url.endsWith(sub))
    return { discarded: t.discarded, status: t.status, active: t.active }
  }, sub)
const whyRows = () => panel.$$eval('#bad .tabhead', (n) => n.map((x) => x.textContent))

await open('/sleepy')
await panel.bringToFront()
await panel.waitForTimeout(900)
s = await settle('wasreadbeforesleep')
ok(s.count === '1 matches in 1 tabs', 'tab indexed while awake', s.count)
ok(await discard('/sleepy'), 'tab suspended')
await panel.waitForTimeout(500)
s = await settle('wasreadbeforesleep')
ok(s.count === '1 matches in 1 tabs', 'text survives suspension with the panel open', s.count)
await reopen()
s = await settle('wasreadbeforesleep')
ok(s.count === '1 matches in 1 tabs', 'text survives suspension across a panel reopen', s.count)
await panel.click('#refresh')
await panel.waitForFunction(
  () => /not searchable/.test(document.querySelector('#status').textContent),
  null,
  { timeout: 30000, polling: 100 }
)
s = await settle('wasreadbeforesleep')
ok(s.count === '1 matches in 1 tabs', 'reindex keeps the text of a suspended tab', s.count)
ok((await tabInfo('/sleepy')).discarded, 'reindex did not wake the tab')

// opened and suspended while the panel is closed, so never read
await panel.goto('about:blank')
await open('/article')
await open('/shell')
await open('/shell2')
const again = await openPdf('/paper?asleep')
await again.waitForTimeout(800)
await panel.bringToFront()
await discard('/article')
await discard('/shell')
await discard('/shell2')
await discard('/paper?asleep')
await panel.waitForTimeout(400)
await reopen()
await panel.waitForFunction(() => S.failed.size >= 2 && !S.indexing, null, { timeout: 30000, polling: 100 })
s = await settle('neverreadarticle')
ok(s.count === '1 matches in 1 tabs', 'never read suspended page found by download', s.count)
ok((await tabInfo('/article')).discarded, 'download did not wake the page')
s = await settle('pdfsecondpagemarker')
ok(s.count === '1 matches in 1 tabs', 'never read suspended pdf found by download', s.count)
ok((await tabInfo('/paper?asleep')).discarded, 'download did not wake the pdf')
s = await settle('shelloneRendered'.toLowerCase())
ok(s.count === '0 matches', 'empty app shell not indexed', s.count)

await settle('')
await panel.waitForTimeout(300)
await panel.click('#status button')
await panel.waitForTimeout(200)
let rowsNow = await whyRows()
p('suspended rows', rowsNow)
ok(rowsNow.filter((r) => r.includes('Not loaded')).length === 2, 'both shells listed as not loaded', JSON.stringify(rowsNow))
ok((await text('#bad .badbar button')) === 'Load all (2)', 'load all shows how many', await text('#bad .badbar button'))
await panel.locator('#bad .tabhead', { hasText: 'Shell One' }).locator('button').click()
await panel.waitForFunction(
  () => [...S.cache.values()].some((r) => r.text.includes('shellonerendered')),
  null,
  { timeout: 20000, polling: 100 }
)
const one = await tabInfo('/shell')
ok(!one.discarded && !one.active, 'load wakes the tab without switching to it', JSON.stringify(one))
await panel.waitForTimeout(400)
rowsNow = await whyRows()
ok(rowsNow.filter((r) => r.includes('Not loaded')).length === 1, 'loaded row leaves the list', JSON.stringify(rowsNow))
s = await settle('shellonerendered')
ok(s.count === '1 matches in 1 tabs', 'loaded tab is searchable', s.count)

await panel.locator('#bad .badbar button').click()
await panel.waitForFunction(
  () => [...S.cache.values()].some((r) => r.text.includes('shelltworendered')),
  null,
  { timeout: 20000, polling: 100 }
)
s = await settle('shelltworendered')
ok(s.count === '1 matches in 1 tabs', 'load all wakes the remaining tabs', s.count)
await panel.waitForTimeout(300)
rowsNow = await whyRows()
ok(!rowsNow.some((r) => r.includes('Not loaded')), 'no not-loaded rows left', JSON.stringify(rowsNow))
ok((await panel.locator('#bad .badbar').count()) === 0, 'load all goes away with nothing left to load')

console.log('---')
console.log(checks - fails + '/' + checks + ' checks passed')
await ctx.close()
srv.close()
try {
  fs.rmSync(profile, { recursive: true, force: true })
} catch (e) {}
process.exit(fails ? 1 : 0)
