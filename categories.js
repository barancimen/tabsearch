'use strict'

// The Categories view: every open tab, grouped by subject. Groups come from
// cluster.js. They are named by Chrome's built-in AI model when this device has
// it, and by their most telling words otherwise. A group keeps its name while
// it stays mostly the same, also across browser restarts.
const CATS = $('#cats')
const CATNOTE = $('#catnote')
const CATS_MS = 600 // regrouping is coalesced to one per this interval

const AI_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
}
const AI_SYSTEM =
  'You name groups of browser tabs. The tabs in a group share a subject. Each tab ' +
  'is given as its title, its site and its opening sentence. For each group, give ' +
  'a short English name for its subject: 1 to 4 words, in Title Case. Be specific: ' +
  '"Italian Pasta Recipes" rather than "Food". Every name must differ from the ' +
  'other names and from the names already in use. Name the subject, not the ' +
  'website, unless the website is the point, as with an email inbox.'
// One worked example, for the format and the level of detail.
const AI_EXAMPLE = [
  'Group 1:',
  '- Spaghetti alla Carbonara Recipe — seriouseats.com — The classic Roman pasta with eggs, pecorino and guanciale.',
  '- Homemade Lasagne — bbcgoodfood.com — Layers of ragù, béchamel and fresh pasta sheets, baked until bubbling.',
  'Common words: Pasta, Recipe, Sauce',
  '',
  'Group 2:',
  '- spawn in tokio::task - Rust — docs.rs — Spawns a new asynchronous task, returning a JoinHandle for it.',
  '- Async in depth — tokio.rs — Tokio’s runtime polls futures until they complete.',
  'Common words: Async, Tokio, Task',
].join('\n')
const AI_EXAMPLE_ANSWER = '{"names":["Italian Pasta Recipes","Async Rust with Tokio"]}'
const AI_TABS = 10 // tabs per group shown to the model
const AI_SNIPPET = 160 // characters of a tab's opening sentence shown to the model
const KEEP_NAME = 0.5 // a group keeps a name while this share of its tabs, and of the named tabs, overlap
const NAMES_KEPT = 300 // names remembered, most recently used first

const C = {
  timer: 0,
  shown: '', // what the view on screen was drawn from
  // names from the model: { urls, name, used }, name null when it gave none
  names: [],
  loaded: null, // promise of the names saved by earlier sessions
  ai: null, // promise of the model session
  aiState: '', // availability of the model, '' until asked
  aiNote: '',
  naming: false,
  pendingScroll: null, // saved scroll position, applied by the first drawing
  groups: [],
}

// A tab's word counts are saved in its index record, so a reopened panel does not
// count them again. A record's text never changes (a re-read makes a new record),
// so the counts only go stale when the title or the site does.
function docFor(t) {
  const rec = S.cache.get(t.id)
  const title = t.title || ''
  const host = hostsOf(t.url).hostname
  const doc = { id: t.id, windowId: t.windowId, index: t.index, title, text: rec ? rec.text : '', tab: t }
  // a tab that could not be read is grouped on its title, which is quick to count
  if (!rec) return { ...doc, terms: Cluster.terms(title, '', host) }
  const key = Cluster.VERSION + '\n' + title + '\n' + host
  if (rec.termsKey !== key) {
    rec.terms = Cluster.terms(title, rec.text, host)
    rec.termsKey = key
    if (!t.incognito) dbPut(rec)
  }
  return { ...doc, terms: rec.terms }
}

// Tab ids change when the browser restarts, so names are tied to URLs.
function urlOf(d) {
  const u = d.tab.url || ''
  const i = u.indexOf('#')
  return i < 0 ? u : u.slice(0, i)
}

// Gives each group the remembered name whose tabs overlap it most, as long as
// most of the group's tabs had that name and most of the named tabs are still in
// the group. A name goes to one group at most.
function matchNames(groups) {
  const pairs = []
  groups.forEach((g, gi) => {
    const mine = new Set(g.tabs.map(urlOf))
    C.names.forEach((n, ni) => {
      let both = 0
      for (const u of n.urls) if (mine.has(u)) both++
      const score = Math.min(both / n.urls.length, both / mine.size)
      if (score >= KEEP_NAME) pairs.push([score, gi, ni])
    })
  })
  pairs.sort((a, b) => b[0] - a[0])
  const doneG = new Set()
  const doneN = new Set()
  for (const [, gi, ni] of pairs) {
    if (doneG.has(gi) || doneN.has(ni)) continue
    doneG.add(gi)
    doneN.add(ni)
    groups[gi].named = C.names[ni]
    C.names[ni].used = Date.now()
  }
}

function scheduleCats() {
  if (S.view !== 'cats' || C.timer) return
  C.timer = setTimeout(() => {
    C.timer = 0
    paintCats()
  }, CATS_MS)
}

async function paintCats() {
  let tabs = []
  try {
    tabs = (await chrome.tabs.query({})).filter((t) => t.id != null)
  } catch (e) {}
  const { groups, rest } = Cluster.group(tabs.map(docFor))
  await C.loaded
  matchNames(groups)
  C.groups = groups
  drawCats(groups, rest, tabs)
  nameGroups()
}

function catRow(d, wins) {
  const t = d.tab
  const row = el('div', 'tabhead cattab')
  const title = el('span', 'title', t.title || t.url)
  title.title = t.url || ''
  row.append(favicon(t.favIconUrl), title)
  if (wins.size > 1) {
    const w = el('span', 'win', 'W' + wins.get(t.windowId))
    w.title = 'Window ' + wins.get(t.windowId)
    row.append(w)
  }
  row.addEventListener('click', () => focusTab({ windowId: t.windowId, tabId: t.id }))
  return row
}

function nameOf(g) {
  return (g.named && g.named.name) || g.label
}

function drawCats(groups, rest, tabs) {
  // windows numbered in Chrome's order, for the W1, W2 tags
  const wins = new Map()
  for (const id of [...new Set(tabs.map((t) => t.windowId))].sort((a, b) => a - b)) {
    wins.set(id, wins.size + 1)
  }
  const what = JSON.stringify([
    groups.map((g) => [nameOf(g), g.keywords, g.tabs.map((d) => [d.id, d.title, d.tab.favIconUrl])]),
    rest.map((d) => [d.id, d.title, d.tab.favIconUrl]),
    [...wins],
  ])
  if (what === C.shown) return
  C.shown = what
  const top = CATS.scrollTop
  CATS.textContent = ''
  if (!tabs.length) {
    CATS.append(el('div', 'empty', 'No open tabs.'))
    return
  }
  if (!groups.length) {
    CATS.append(el('div', 'empty', 'No two tabs are about the same thing.'))
  }
  const frag = document.createDocumentFragment()
  for (const g of groups) {
    const sec = el('section', 'group cat')
    const head = el('div', 'cathead')
    const name = el('span', 'catname', nameOf(g))
    name.title = nameOf(g)
    head.append(name, el('span', 'badge', String(g.tabs.length)))
    sec.append(head)
    const why = el('div', 'catwhy', g.keywords.join(' · '))
    why.hidden = nameOf(g) === g.label
    sec.append(why)
    for (const d of g.tabs) sec.append(catRow(d, wins))
    frag.append(sec)
  }
  if (rest.length) {
    const sec = el('section', 'group cat rest')
    const head = el('div', 'cathead')
    head.append(el('span', 'catname', 'Unlike the others'), el('span', 'badge', String(rest.length)))
    sec.append(head)
    for (const d of rest) sec.append(catRow(d, wins))
    frag.append(sec)
  }
  CATS.append(frag)
  if (C.pendingScroll != null) {
    CATS.scrollTop = C.pendingScroll
    C.pendingScroll = null
  } else {
    CATS.scrollTop = top
  }
}

function paintNote() {
  CATNOTE.textContent = ''
  CATNOTE.hidden = S.view !== 'cats'
  if (C.aiNote) {
    CATNOTE.textContent = C.aiNote
  } else if (C.aiState === 'downloadable') {
    const btn = el('button', '', 'Name groups with Chrome’s built-in AI')
    btn.type = 'button'
    btn.title = 'Downloads Chrome’s on-device model once. Tab text stays on this computer.'
    btn.addEventListener('click', () => {
      C.aiNote = 'Starting Chrome’s AI model…'
      paintNote()
      aiSession()
        .then(() => {
          C.aiState = 'available'
          return nameGroups()
        })
        .catch(() => {})
    })
    CATNOTE.append(btn)
  } else {
    CATNOTE.hidden = true
  }
}

async function aiAvailability() {
  if (!globalThis.LanguageModel) return 'unavailable'
  try {
    return await LanguageModel.availability(AI_OPTS)
  } catch (e) {
    return 'unavailable'
  }
}

// Starting the model downloads it on first use, which needs a click.
function aiSession() {
  if (!C.ai) {
    C.ai = LanguageModel.create({
      ...AI_OPTS,
      initialPrompts: [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user', content: AI_EXAMPLE },
        { role: 'assistant', content: AI_EXAMPLE_ANSWER },
      ],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          C.aiNote = 'Downloading Chrome’s AI model: ' + Math.round(e.loaded * 100) + '%'
          paintNote()
        })
      },
    }).then(
      (s) => {
        C.aiState = 'available'
        C.aiNote = ''
        paintNote()
        return s
      },
      (e) => {
        C.ai = null
        C.aiNote = 'Chrome’s AI model could not start.'
        paintNote()
        throw e
      }
    )
  }
  return C.ai
}

function clip(s, n) {
  s = s.trim()
  return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…'
}

// What a page says about itself first: its meta description when it has one,
// otherwise the first full sentence of its text.
function opening(d) {
  const lines = (d.text || '').split('\n')
  if (lines[0] === d.title) lines.shift()
  if (!lines.length || !lines[0]) return ''
  // extract() puts a meta description on its own line before the body
  if (lines.length >= 2 && lines[0].length >= 30 && lines[0].length <= 400) return clip(lines[0], AI_SNIPPET)
  const sentence = lines[0]
    .slice(0, 2000)
    .split(/(?<=[.!?])\s+/)
    .find((x) => x.split(/\s+/).length >= 8)
  return sentence ? clip(sentence, AI_SNIPPET) : ''
}

function groupBlock(g, i, rich) {
  const shown = g.tabs.slice(0, rich ? AI_TABS : 5)
  const lines = shown.map(
    (d) =>
      '- ' +
      [clip(d.title || urlOf(d), 100), hostsOf(d.tab.url).hostname, rich ? opening(d) : '']
        .filter(Boolean)
        .join(' — ')
  )
  if (g.tabs.length > shown.length) lines.push('- and ' + (g.tabs.length - shown.length) + ' more')
  return 'Group ' + (i + 1) + ':\n' + lines.join('\n') + '\nCommon words: ' + g.keywords.join(', ')
}

function aiPrompt(groups, taken, rich) {
  const head = taken.length ? 'Names already in use: ' + taken.join(', ') + '\n\n' : ''
  return head + groups.map((g, i) => groupBlock(g, i, rich)).join('\n\n')
}

// Whether a prompt leaves room in the model's context. Older Chrome versions call
// the measures inputQuota and measureInputUsage.
async function fits(session, text) {
  const room = session.contextWindow || session.inputQuota
  const measure = session.measureContextUsage || session.measureInputUsage
  const used = session.contextUsage || session.inputUsage || 0
  if (room && measure) {
    try {
      return used + (await measure.call(session, text)) < room * 0.75
    } catch (e) {}
  }
  return text.length / 4 < 3000 // about 4 characters to a token
}

// Splits the groups into as few requests as fit in the model's context.
async function batches(session, groups, taken) {
  const out = []
  let cur = []
  for (const g of groups) {
    if (cur.length && !(await fits(session, aiPrompt([...cur, g], taken, true)))) {
      out.push(cur)
      cur = []
    }
    cur.push(g)
  }
  if (cur.length) out.push(cur)
  return out
}

function cleanName(raw) {
  const s = String(raw || '')
    .split('\n')[0]
    .replace(/^["'“”\s]+|["'“”.\s]+$/g, '')
  return s.length > 0 && s.length <= 48 ? s : ''
}

async function loadNames() {
  try {
    const { catNames } = await chrome.storage.local.get('catNames')
    if (Array.isArray(catNames)) C.names = catNames.filter((n) => n && Array.isArray(n.urls) && n.urls.length)
  } catch (e) {}
}

function saveNames() {
  C.names.sort((a, b) => b.used - a.used)
  C.names.length = Math.min(C.names.length, NAMES_KEPT)
  // a group with an incognito tab is named for this session only, and a request
  // that failed is tried again in the next one
  const keep = C.names.filter((n) => !n.incognito && !n.failed)
  chrome.storage.local.set({ catNames: keep }).catch(() => {})
}

// Asks the model to name every group that has no name yet. The groups go in one
// request, or as few as fit, so the model can keep their names apart.
async function nameGroups() {
  if (C.naming) return
  if (!C.aiState) {
    C.aiState = await aiAvailability()
    paintNote()
  }
  if (C.aiState !== 'available') return
  const todo = C.groups.filter((g) => !g.named)
  if (!todo.length || S.view !== 'cats') return
  C.naming = true
  let named = false
  try {
    const session = await aiSession()
    const taken = C.groups.filter((g) => g.named && g.named.name).map((g) => g.named.name)
    for (const batch of await batches(session, todo, taken)) {
      const rich = await fits(session, aiPrompt(batch, taken, true))
      let names = []
      let failed = false
      try {
        const s = await session.clone()
        try {
          const schema = {
            type: 'object',
            properties: {
              names: { type: 'array', items: { type: 'string' }, minItems: batch.length, maxItems: batch.length },
            },
            required: ['names'],
          }
          const reply = await s.prompt(aiPrompt(batch, taken, rich), { responseConstraint: schema })
          names = JSON.parse(reply).names || []
        } finally {
          s.destroy()
        }
      } catch (e) {
        failed = true
      }
      batch.forEach((g, i) => {
        let name = cleanName(names[i])
        // the model was told to keep names apart; if it did not, the group's top word tells them apart
        if (name && taken.some((t) => t.toLowerCase() === name.toLowerCase())) {
          name = name + ' (' + (g.keywords[0] || g.tabs.length) + ')'
        }
        if (name) taken.push(name)
        // remembered even without a name, so a group the model cannot name is not asked again
        C.names.push({
          urls: [...new Set(g.tabs.map(urlOf))],
          name: name || null,
          used: Date.now(),
          incognito: g.tabs.some((d) => d.tab.incognito) || undefined,
          failed: failed || undefined,
        })
      })
      named = true
    }
  } catch (e) {
  } finally {
    C.naming = false
  }
  if (named) {
    saveNames()
    // draws the names, and names any group that formed meanwhile
    paintCats()
  }
}

chrome.tabs.onMoved.addListener(scheduleCats)
chrome.tabs.onAttached.addListener(scheduleCats)
chrome.tabs.onDetached.addListener(scheduleCats)
CATS.addEventListener('scroll', () => saveUi(), { passive: true })
C.loaded = loadNames()
