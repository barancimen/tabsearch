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

const srv = http.createServer((req, res) => {
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

const panel = await ctx.newPage()
const consoleProblems = []
panel.on('console', (m) => {
  if (m.type() !== 'log' && m.type() !== 'info') consoleProblems.push(m.text())
})
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
    titles: await panel.$$eval('.tabhead .title', (n) => n.map((x) => x.textContent)),
    marks: await panel.$$eval('mark', (n) => n.length),
    status: await text('#status'),
  }
}

const p = (label, s) => console.log(label + ': ' + JSON.stringify(s))

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

const suggestions = await panel.$$eval('#doms option', (n) => n.map((x) => x.value))
p('suggestions', suggestions)
ok(
  suggestions.join(',') === '127.0.0.1,[::1],foo.localhost,localhost',
  'datalist lists every distinct hostname, sorted',
  suggestions.join(',')
)

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
ok(s.count === '1 matches in 1 tabs', 'reopened panel serves the saved text', s.count)
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
ok(after.re, 'reopened panel keeps the options', JSON.stringify(after))
ok(after.open, 'reopened panel keeps the dropdown open', JSON.stringify(after))
ok(before.selIndex === 1 && after.sel === before.sel, 'reopened panel keeps the selected result', JSON.stringify([before, after]))
ok(after.scroll === before.scroll && before.scroll === 60, 'reopened panel keeps the scroll position', JSON.stringify([before.scroll, after.scroll]))
ok((await text('#count')) !== '', 'reopened panel shows the results', await text('#count'))

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
