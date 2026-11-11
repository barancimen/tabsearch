'use strict'

// The Categories view: every open tab, grouped by subject. Groups come from
// cluster.js and are named by their most telling words.
const CATS = $('#cats')
const CATS_MS = 600 // regrouping is coalesced to one per this interval

const C = {
  timer: 0,
  shown: '', // what the view on screen was drawn from
  pendingScroll: null, // saved scroll position, applied by the first drawing
  params: {}, // the settings moved away from their defaults
  ready: null, // resolves once the saved settings are read
  regroupT: 0,
  saveT: 0,
}

// The sliders under Adjustments. Each changes one of Cluster.DEFAULTS. A
// slider with log set moves through its range by ratios rather than steps.
const SETTINGS = [
  {
    key: 'join',
    name: 'How alike tabs must be',
    min: 0.005,
    max: 0.2,
    log: true,
    show: (v) => v.toFixed(3),
    help:
      'How much tabs must have in common to be grouped together. Higher gives smaller, ' +
      'tighter groups and leaves more tabs under "Unlike the others". Lower gives fewer, ' +
      'broader groups.',
  },
  {
    key: 'sameWindow',
    name: 'How much sharing a window counts',
    min: 1,
    max: 3,
    step: 0.1,
    show: (v) => '×' + v.toFixed(1),
    help:
      'Tabs in the same window are treated as up to this many times more alike. At ×1, ' +
      'windows are ignored. Tabs with nothing in common are never grouped just because ' +
      'they share a window. The effect is weaker when most of your tabs are in one window, ' +
      'because then sharing a window says little.',
  },
  {
    key: 'titleWeight',
    name: 'How much titles count',
    min: 1,
    max: 10,
    step: 0.5,
    show: (v) => '×' + v.toFixed(1),
    help:
      "A word in a tab's title counts as much as this many words in the page itself. " +
      'Higher groups tabs more by what their titles say.',
  },
  {
    key: 'siteWeight',
    name: 'How much the website counts',
    min: 0,
    max: 3,
    step: 0.1,
    show: (v) => v.toFixed(1),
    help:
      'Tabs from the same website are treated as a little more alike. This sets how much. ' +
      "At 0 the website doesn't matter. A website most of your tabs share counts for " +
      'very little either way.',
  },
  {
    key: 'genericWeight',
    name: 'How much everyday words count',
    min: 0,
    max: 1,
    step: 0.05,
    show: (v) => v.toFixed(2),
    help:
      'Common words that seldom say what a page is about, like "available", "official" ' +
      'or "feature", count this much of a normal word. At 0 they are ignored, and at 1 ' +
      'they count fully.',
  },
  {
    key: 'vectorTerms',
    name: 'Words compared per tab',
    min: 20,
    max: 400,
    step: 10,
    show: (v) => String(v),
    help:
      'Tabs are compared using only the words that best describe each one, this many ' +
      "per tab. Fewer looks only at each page's main subject, so tabs need to match more " +
      'closely and more are left on their own. More also takes in side topics, and can ' +
      'join tabs that only touch on the same thing.',
  },
  {
    key: 'labelTerms',
    name: 'Words in each name',
    min: 1,
    max: 5,
    step: 1,
    show: (v) => String(v),
    help: 'How many words name each group.',
  },
]
const LOG_STEPS = 1000 // positions of a log slider

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

function scheduleCats() {
  if (S.view !== 'cats' || C.timer) return
  C.timer = setTimeout(() => {
    C.timer = 0
    paintCats()
  }, CATS_MS)
}

async function paintCats() {
  await C.ready
  let tabs = []
  try {
    tabs = (await chrome.tabs.query({})).filter((t) => t.id != null)
  } catch (e) {}
  const { groups, rest } = Cluster.group(tabs.map(docFor), C.params)
  drawCats(groups, rest, tabs)
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

function drawCats(groups, rest, tabs) {
  // windows numbered in Chrome's order, for the W1, W2 tags
  const wins = new Map()
  for (const id of [...new Set(tabs.map((t) => t.windowId))].sort((a, b) => a - b)) {
    wins.set(id, wins.size + 1)
  }
  const what = JSON.stringify([
    groups.map((g) => [g.label, g.tabs.map((d) => [d.id, d.title, d.tab.favIconUrl])]),
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
    const name = el('span', 'catname', g.label)
    name.title = g.label
    head.append(name, el('span', 'badge', String(g.tabs.length)))
    sec.append(head)
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

// --- Adjustments ---

const settingValue = (s) => (s.key in C.params ? C.params[s.key] : Cluster.DEFAULTS[s.key])

function toPos(s, v) {
  return s.log ? Math.round((Math.log(v / s.min) / Math.log(s.max / s.min)) * LOG_STEPS) : v
}

function fromPos(s, pos) {
  if (!s.log) return Number(pos)
  const v = s.min * Math.pow(s.max / s.min, pos / LOG_STEPS)
  return Number(v.toPrecision(3))
}

// Saved settings, keeping only known ones within their slider's range.
function cleanParams(values) {
  const out = {}
  for (const s of SETTINGS) {
    const v = values && values[s.key]
    if (typeof v === 'number' && v >= s.min && v <= s.max) out[s.key] = v
  }
  return out
}

function showSetting(s) {
  const r = s.row
  r.input.value = String(toPos(s, settingValue(s)))
  r.val.textContent = s.show(settingValue(s))
  r.def.hidden = !(s.key in C.params)
}

function showSettings() {
  for (const s of SETTINGS) showSetting(s)
  $('#catreset').disabled = !Object.keys(C.params).length
}

// Regroups shortly after a slider moves, at most once per this many ms.
function regroup() {
  if (C.regroupT || S.view !== 'cats') return
  C.regroupT = setTimeout(() => {
    C.regroupT = 0
    paintCats()
  }, 80)
}

function saveParams() {
  clearTimeout(C.saveT)
  C.saveT = setTimeout(() => {
    chrome.storage.local.set({ catParams: { from: ME, values: C.params } }).catch(() => {})
  }, 150)
}

function setParam(s, v) {
  const d = Cluster.DEFAULTS[s.key]
  // a log slider can't land exactly on its default
  if (Math.abs(v - d) <= Math.abs(d) * 0.01) delete C.params[s.key]
  else C.params[s.key] = v
  showSettings()
  saveParams()
  regroup()
}

for (const s of SETTINGS) {
  const box = el('div', 'setting')
  box.title = s.help
  const top = el('div', 'settop')
  const name = el('label', 'setname', s.name)
  name.htmlFor = 'set-' + s.key
  const val = el('span', 'setval')
  const def = el('button', 'setdef', 'default')
  def.type = 'button'
  def.title = 'Back to ' + s.show(Cluster.DEFAULTS[s.key])
  const input = el('input')
  input.type = 'range'
  input.id = 'set-' + s.key
  input.min = s.log ? '0' : String(s.min)
  input.max = s.log ? String(LOG_STEPS) : String(s.max)
  input.step = s.log ? '1' : String(s.step)
  top.append(name, val, def)
  box.append(top, input)
  $('#catsliders').append(box)
  s.row = { input, val, def }
  input.addEventListener('input', () => setParam(s, fromPos(s, input.value)))
  def.addEventListener('click', () => setParam(s, Cluster.DEFAULTS[s.key]))
}

$('#catreset').addEventListener('click', () => {
  C.params = {}
  showSettings()
  saveParams()
  regroup()
})
$('#catopts').addEventListener('toggle', () => saveUi())

// Settings moved in another window's panel apply here too.
chrome.storage.onChanged.addListener((changes, area) => {
  const p = area === 'local' && changes.catParams && changes.catParams.newValue
  if (!p || p.from === ME) return
  C.params = cleanParams(p.values)
  showSettings()
  regroup()
})

C.ready = chrome.storage.local
  .get('catParams')
  .then((r) => {
    C.params = cleanParams(r.catParams && r.catParams.values)
  })
  .catch(() => {})
  .finally(showSettings)

chrome.tabs.onMoved.addListener(scheduleCats)
chrome.tabs.onAttached.addListener(scheduleCats)
chrome.tabs.onDetached.addListener(scheduleCats)
CATS.addEventListener('scroll', () => saveUi(), { passive: true })
// names an earlier version had Chrome's AI model write
chrome.storage.local.remove('catNames').catch(() => {})
