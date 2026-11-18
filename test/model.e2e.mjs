// End to end test of grouping by meaning with the real model. Loads the
// extension into Chromium, opens made-up X, Reddit and YouTube pages and two
// Wikipedia articles, and sets the model up both ways: downloaded (Hugging
// Face's address is answered from the local folder, so nothing is fetched) and
// from a folder. Needs the model's folder:
//
//   node test/model.e2e.mjs /path/to/mdbr-leaf-mt
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL_DIR = path.resolve(process.argv[2] || process.env.MODEL_DIR || '')
if (!process.argv[2] && !process.env.MODEL_DIR) {
  console.log('usage: node test/model.e2e.mjs /path/to/mdbr-leaf-mt')
  process.exit(2)
}
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'))
const social = fixture('social.json').pages
const { articles } = fixture('articles.json')
const { vectors } = fixture('vectors.json')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const SOCIAL = ['X: fresh pasta', 'X: Rust release', 'X: galaxy image', 'YouTube: lasagna', 'Reddit: async JavaScript', 'YouTube: black holes']
const WIKI = ['Black hole', 'Andromeda Galaxy']
const ROUTES = {}
SOCIAL.forEach((name, i) => {
  const p = social[name]
  ROUTES['/s/' + i] =
    `<!doctype html><title>${esc(p.title)}</title><body><nav>${esc(p.nav)}</nav>` +
    `<div><article>${esc(p.article)}</article><aside>${esc(p.aside)}</aside></div><footer>${esc(p.footer)}</footer></body>`
})
WIKI.forEach((name, i) => {
  ROUTES['/w/' + i] =
    `<!doctype html><title>${name} - Wikipedia</title><body><nav>Main menu Search Donate Log in</nav><main>` +
    articles[name].split(/\n+/).map((x) => '<p>' + esc(x) + '</p>').join('') +
    '</main></body>'
})

const srv = http.createServer((req, res) => {
  const body = ROUTES[req.url]
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body || 'missing')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`

let fails = 0
let checks = 0
const ok = (c, label, extra) => {
  checks++
  if (!c) {
    fails++
    console.log('FAIL ' + label + (extra ? ' :: ' + extra : ''))
  }
}
const p = (label, s) => console.log(label + ': ' + JSON.stringify(s))

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-model-'))
const EXT = path.resolve(here, '..')
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage'],
})
let sw = ctx.serviceWorkers()[0]
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
const id = new URL(sw.url()).host

// Hugging Face, answered from the model folder; every request is recorded
const fetched = []
let offline = false
await ctx.route('https://huggingface.co/**', async (route) => {
  const url = route.request().url()
  fetched.push(url)
  const m = /\/resolve\/[0-9a-f]{40}\/(.+)$/.exec(url)
  const file = m && path.join(MODEL_DIR, m[1])
  if (offline || !file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' })
  route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': 'application/octet-stream' } })
})

// two windows, so the window tags show; the duplicate opens later
const win = (paths) => paths.map((x) => base + x)
const first = await ctx.newPage()
await first.goto(base + '/s/0', { waitUntil: 'load' })
for (const x of ['/s/1', '/s/2', '/w/0']) await (await ctx.newPage()).goto(base + x, { waitUntil: 'load' })

const problems = []
const watch = (pg) => {
  pg.on('console', (m) => m.type() !== 'log' && m.type() !== 'info' && problems.push(m.text()))
  pg.on('pageerror', (e) => problems.push(String(e)))
  pg.on('worker', (w) => w.on('console', (m) => problems.push('worker: ' + m.text())))
}
// on a timeout, say what the panel showed
const waitFor = (fn, ms) =>
  panel.waitForFunction(fn, null, { timeout: ms, polling: 250 }).catch(async (e) => {
    console.log('state: ' + (await panel.textContent('#modelstate')) + ' | note: ' + (await panel.textContent('#catnote')))
    console.log('problems: ' + problems.slice(-10).join('\n'))
    throw e
  })
let panel = await ctx.newPage()
watch(panel)
await panel.goto(`chrome-extension://${id}/sidepanel.html`)
await panel.evaluate((urls) => chrome.windows.create({ url: urls }), win(['/s/3', '/s/4', '/s/5', '/w/1']))
await panel.waitForFunction(() => S.cache.size >= 8, null, { timeout: 30000, polling: 250 })
await panel.bringToFront()
await panel.click('#v-cats')
await panel.waitForSelector('#cats section.cat', { timeout: 10000 })
ok(/Not set up/.test(await panel.textContent('#modelstate')), 'the model starts not set up', await panel.textContent('#modelstate'))

const cats = () =>
  panel.$$eval('#cats section.cat', (secs) =>
    secs.map((s) => ({
      name: s.querySelector('.catname').textContent,
      subs: [...s.querySelectorAll('.sub')].map((x) => ({
        name: x.querySelector('.subname').textContent,
        tabs: [...x.querySelectorAll('.cattab .title')].map((t) => t.textContent),
      })),
      tabs: [...s.querySelectorAll('.cattab .title')].map((t) => t.textContent),
    }))
  )
const short = (t) => t.slice(0, 18)
const together = (cs, a, b) => cs.some((c) => c.name !== 'Unlike the others' && c.tabs.some((t) => t.startsWith(a)) && c.tabs.some((t) => t.startsWith(b)))
const byMeaning = () =>
  panel.waitForFunction(() => document.querySelector('#catnote').textContent === 'Grouped by meaning.', null, { timeout: 180000, polling: 500 })

// --- download --------------------------------------------------------------
await panel.click('#catopts summary')
const t0 = Date.now()
await panel.click('#modeldl')
await waitFor(() => /Ready|could not|failed|no /i.test(document.querySelector('#modelstate').textContent), 120000)
ok(/from the download/.test(await panel.textContent('#modelstate')), 'the downloaded model loads', await panel.textContent('#modelstate'))
await byMeaning()
console.log('download, load and embedding took ' + Math.round((Date.now() - t0) / 1000) + ' s')
ok(fetched.length === 4 && fetched.every((u) => u.startsWith('https://huggingface.co/MongoDB/mdbr-leaf-mt/resolve/')), 'only the four model files are fetched', JSON.stringify(fetched))
ok(fetched.every((u) => !/[?#]/.test(u)), 'nothing about the tabs is in the requests')
ok((await panel.isHidden('#modeldl')) && !(await panel.isHidden('#modelrm')), 'a finished download offers removal instead')

let cs = await cats()
p('by meaning', cs.map((c) => [c.name, c.tabs.map(short), c.subs.map((s) => s.name)]))
ok(together(cs, 'Marco Rossi', 'The BEST Classic Lasagna'), 'the pasta post and the lasagna video are together')
ok(together(cs, 'Rust Language', 'async/await'), 'the Rust post and the JavaScript thread are together')
ok(together(cs, 'NASA Webb', 'Andromeda Galaxy') && together(cs, 'What Happens Inside', 'Black hole'), 'the space pages are together')
ok(!together(cs, 'Marco Rossi', 'Rust Language') && !together(cs, 'Rust Language', 'NASA Webb'), 'posts on X about different things are apart')
const space = cs.find((c) => c.tabs.some((t) => t.startsWith('Black hole')))
ok(space && space.subs.length === 2, 'the space category is split into subgroups', JSON.stringify(space && space.subs))

// the browser's vectors are the ones Python makes from the same model
const sims = await panel.evaluate(
  ([want, names]) =>
    names.map((name) => {
      const rec = [...S.cache.values()].find((r) => r.title === name)
      if (!rec || !rec.vec) return -1
      return rec.vec.reduce((s, x, i) => s + x * want[name][i], 0)
    }),
  [Object.fromEntries(SOCIAL.map((n) => [social[n].title, vectors[n]])), SOCIAL.map((n) => social[n].title)]
)
// quantized arithmetic differs a little between WebAssembly and native code
ok(sims.every((x) => x > 0.995), 'vectors match the reference vectors', JSON.stringify(sims.map((x) => x.toFixed(4))))

// --- reopening reuses the saved vectors -------------------------------------
// a marker: the Rust post's saved vector replaced by the pasta post's
await panel.evaluate(async () => {
  const recs = await dbAll()
  const rust = recs.find((r) => /^Rust Language/.test(r.title))
  rust.vec = recs.find((r) => /^Marco Rossi/.test(r.title)).vec
  await dbPut(rust)
})
offline = true
fetched.length = 0
await panel.reload()
await panel.waitForSelector('#cats section.cat', { timeout: 30000 })
await byMeaning()
ok(fetched.length === 0, 'a reopened panel loads the model without fetching anything', JSON.stringify(fetched))
cs = await cats()
ok(together(cs, 'Marco Rossi', 'Rust Language'), 'a reopened panel uses the saved vectors', JSON.stringify(cs.map((c) => c.tabs.map(short))))
const rest = cs.find((c) => c.name === 'Unlike the others')
ok(rest && rest.tabs.includes('about:blank'), 'blank and browser pages are not grouped', JSON.stringify(rest))
// undo the marker: the Rust post is embedded again
await panel.evaluate(() => {
  ;[...S.cache.values()].find((r) => /^Rust Language/.test(r.title)).vecKey = ''
  paintCats()
})
await panel.waitForFunction(() => !document.querySelector('#cats .dup'), null, { timeout: 60000, polling: 300 })
await byMeaning()

// --- duplicates --------------------------------------------------------------
const dup = await ctx.newPage()
await dup.goto(base + '/s/0#replies', { waitUntil: 'load' })
await panel.bringToFront()
await panel.waitForFunction(() => document.querySelectorAll('#cats .dup').length === 2, null, { timeout: 60000, polling: 300 })
// SHOTS=<folder> saves pictures of the panel at side panel width
if (process.env.SHOTS) {
  await panel.setViewportSize({ width: 360, height: 900 })
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'categories.png') })
  await panel.evaluate(() => (document.querySelector('#catopts').open = true))
  await panel.screenshot({ path: path.join(process.env.SHOTS, 'adjustments.png') })
  await panel.setViewportSize({ width: 1280, height: 720 })
}
const dupHelp = await panel.$eval('#cats .dup', (d) => d.title)
ok(/same page is open in another tab: Marco Rossi/.test(dupHelp), 'duplicates are marked, naming the other tab', dupHelp)
await dup.close()

// --- removing the download ----------------------------------------------------
await panel.bringToFront()
await panel.click('#modelrm')
await panel.waitForFunction(() => /Not set up/.test(document.querySelector('#modelstate').textContent), null, { timeout: 30000 })
await panel.waitForFunction(() => /words/.test(document.querySelector('#catnote').textContent), null, { timeout: 30000 })
ok(true, 'removing the download goes back to grouping by words')

// --- a folder ---------------------------------------------------------------
await panel.fill('#modelfolder', '/no/such/folder')
await panel.click('#modeluse')
await panel.waitForFunction(() => document.querySelector('#modelstate').classList.contains('bad'), null, { timeout: 30000 })
if (await panel.evaluate(() => chrome.extension.isAllowedFileSchemeAccess())) {
  // Chromium started by Playwright allows it from the start
  console.log('file access was already on, so its message is not checked')
} else {
  const why = await panel.textContent('#modelstate')
  ok(/Allow access to file URLs/.test(why), 'without file access, the panel says how to allow it', why)
  // switching file access on reloads the extension, so the panel is opened again
  const ext = await ctx.newPage()
  await ext.goto(`chrome://extensions/?id=${id}`)
  await ext.click('#allow-on-file-urls')
  await ext.waitForTimeout(3000)
  await ext.close()
  panel = await ctx.newPage()
  watch(panel)
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  ok(await panel.evaluate(() => chrome.extension.isAllowedFileSchemeAccess()), 'file access is on')
  await panel.waitForSelector('#cats section.cat', { timeout: 30000 })
  await panel.click('#catopts summary').catch(() => {})
  await panel.waitForFunction(() => document.querySelector('#modelstate').classList.contains('bad'), null, { timeout: 30000 })
}
ok(/not found/.test(await panel.textContent('#modelstate')), 'a missing folder is reported', await panel.textContent('#modelstate'))
await panel.fill('#modelfolder', MODEL_DIR)
await panel.click('#modeluse')
await panel.waitForFunction(() => /Ready/.test(document.querySelector('#modelstate').textContent), null, { timeout: 120000, polling: 250 })
ok(/from the folder/.test(await panel.textContent('#modelstate')), 'the model loads from a folder', await panel.textContent('#modelstate'))
ok(await panel.isDisabled('#modeldl'), 'with the model loaded from a folder, the download button is grayed out')
ok(/already loaded/.test(await panel.getAttribute('#modeldl', 'title')), 'and its description says why')
await byMeaning()
cs = await cats()
ok(together(cs, 'Rust Language', 'async/await'), 'grouped by meaning with the model from the folder')

console.log('---')
console.log(checks - fails + '/' + checks + ' checks passed')
await ctx.close()
srv.close()
fs.rmSync(profile, { recursive: true, force: true })
process.exit(fails ? 1 : 0)
