'use strict'

// The Categories view: every open tab, grouped by subject. Groups come from
// cluster.js. They are named by their most telling words, or by Chrome's
// built-in AI model when this device has it.
const CATS = $('#cats')
const CATNOTE = $('#catnote')
const CATS_MS = 600 // regrouping is coalesced to one per this interval

const AI_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
}
const AI_SYSTEM =
  'You name groups of browser tabs. You get the titles of the tabs in one group ' +
  'and words that are common in them. Reply with a short English name for what ' +
  'the tabs have in common, 1 to 4 words, in Title Case, such as "Italian Cooking", ' +
  '"Rust Programming" or "Apartment Hunting". Name the subject, not the websites.'
const AI_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
}

const C = {
  terms: new Map(), // tabId -> { title, text, host, terms }
  timer: 0,
  shown: '', // what the view on screen was drawn from
  names: new Map(), // group key -> name from the AI model
  ai: null, // promise of the model session
  aiState: '', // availability of the model, '' until asked
  aiNote: '',
  naming: false,
  pendingScroll: null, // saved scroll position, applied by the first drawing
  groups: [],
}

function docFor(t) {
  const rec = S.cache.get(t.id)
  const text = rec ? rec.text : ''
  const title = t.title || ''
  const host = hostsOf(t.url).hostname
  let c = C.terms.get(t.id)
  if (!c || c.text !== text || c.title !== title || c.host !== host) {
    c = { text, title, host, terms: Cluster.terms(title, text, host) }
    C.terms.set(t.id, c)
  }
  return { id: t.id, windowId: t.windowId, index: t.index, title, text, terms: c.terms, tab: t }
}

function groupKey(g) {
  return g.tabs
    .map((d) => d.id + ':' + d.title)
    .sort()
    .join('\n')
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
  const live = new Set(tabs.map((t) => t.id))
  for (const id of C.terms.keys()) if (!live.has(id)) C.terms.delete(id)
  const { groups, rest } = Cluster.group(tabs.map(docFor))
  for (const g of groups) g.key = groupKey(g)
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
  return C.names.get(g.key) || g.label
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
    sec.dataset.key = g.key
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
        .then(() => nameGroups())
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
      initialPrompts: [{ role: 'system', content: AI_SYSTEM }],
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

function aiPrompt(g) {
  const lines = g.tabs.slice(0, 15).map((d) => '- ' + (d.title || d.tab.url || '').slice(0, 120))
  if (g.tabs.length > 15) lines.push('- and ' + (g.tabs.length - 15) + ' more')
  return 'Tab titles:\n' + lines.join('\n') + '\nCommon words: ' + g.keywords.join(', ')
}

function cleanName(raw) {
  let s = String(raw || '')
  try {
    s = JSON.parse(s).name || ''
  } catch (e) {}
  s = s.split('\n')[0].replace(/^["'“”\s]+|["'“”.\s]+$/g, '')
  return s.length > 0 && s.length <= 48 ? s : ''
}

async function loadNames() {
  try {
    const { catNames } = await chrome.storage.session.get('catNames')
    for (const [k, v] of catNames || []) if (!C.names.has(k)) C.names.set(k, v)
  } catch (e) {}
}

function saveNames() {
  // the most recent names are enough; groups change as tabs come and go
  const all = [...C.names].slice(-200)
  chrome.storage.session.set({ catNames: all }).catch(() => {})
}

// Asks the model for a name for each group that has none yet, one at a time.
async function nameGroups() {
  if (C.naming) return
  if (!C.aiState) {
    C.aiState = await aiAvailability()
    paintNote()
  }
  if (C.aiState !== 'available') return
  C.naming = true
  try {
    const session = await aiSession()
    for (;;) {
      const g = C.groups.find((x) => !C.names.has(x.key))
      if (!g || S.view !== 'cats') break
      let name = ''
      try {
        const s = await session.clone()
        try {
          name = cleanName(await s.prompt(aiPrompt(g), { responseConstraint: AI_SCHEMA }))
        } finally {
          s.destroy()
        }
      } catch (e) {}
      // remembered even when empty, so a group the model cannot name is not asked again
      C.names.set(g.key, name || g.label)
      saveNames()
      const sec = [...CATS.querySelectorAll('section.cat')].find((x) => x.dataset.key === g.key)
      if (sec && name) {
        sec.querySelector('.catname').textContent = sec.querySelector('.catname').title = name
        sec.querySelector('.catwhy').hidden = false
      }
    }
  } catch (e) {
  } finally {
    C.naming = false
  }
}

chrome.tabs.onMoved.addListener(scheduleCats)
chrome.tabs.onAttached.addListener(scheduleCats)
chrome.tabs.onDetached.addListener(scheduleCats)
CATS.addEventListener('scroll', () => saveUi(), { passive: true })
loadNames()
