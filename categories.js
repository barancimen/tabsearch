'use strict'

// The Categories view: every open tab, grouped by subject into categories and
// subgroups (cluster.js). Tabs are compared by meaning once the embedding model
// (model.js) is set up, and by the words they share until then.
const CATS = $('#cats')
const CATNOTE = $('#catnote')
const CATS_MS = 600 // regrouping is coalesced to one per this interval
const EMBED_VERSION = 1 // bump when embedInput() changes, so vectors are made again
const EMBED_BATCH = 4 // tabs sent to the model at a time

const C = {
  timer: 0,
  shown: '', // what the view on screen was drawn from
  mode: '', // how the groups on screen were measured: meaning or words
  pendingScroll: null, // saved scroll position, applied by the first drawing
  params: { meaning: {}, words: {} }, // the settings moved away from their defaults
  ready: null, // resolves once the saved settings are read
  regroupT: 0,
  saveT: 0,
  vecs: new Map(), // tabId -> { key, vec } for tabs with no index record
  embedding: false,
  embedLeft: 0, // tabs still to embed in this round
  embedBroken: '', // the model key embedding last failed with, so it is not retried in a loop
  waiting: false, // the view shows that groups are on their way
  draws: 0, // times the groups were drawn, for the tests
  collapsed: new Set(), // keys of the folded categories and subgroups
}
const MAX_COLLAPSED = 300 // folded groups remembered

// The sliders under Adjustments. Each changes a setting in Cluster.DEFAULTS.
// The two thresholds have their own range for each way of measuring, and a
// range with log set moves by ratios rather than steps.
const SETTINGS = [
  {
    key: 'category',
    name: 'How alike tabs in a category must be',
    ranges: { meaning: { min: 0.25, max: 0.8, step: 0.01 }, words: { min: 0.005, max: 0.2, log: true } },
    help:
      'How much tabs must have in common to be put in the same category. Higher gives more, ' +
      'smaller categories and leaves more tabs under "Unlike the others". Lower gives fewer, ' +
      'broader categories.',
  },
  {
    key: 'subgroup',
    name: 'How alike tabs in a subgroup must be',
    ranges: { meaning: { min: 0.25, max: 0.9, step: 0.01 }, words: { min: 0.005, max: 0.3, log: true } },
    help:
      'Inside a category, tabs at least this alike form a subgroup. A category is only split ' +
      'when it falls into two or more subgroups. Set it to the category value or lower for ' +
      'no subgroups.',
  },
  {
    key: 'window',
    name: 'How much sharing a window counts',
    min: 0,
    max: 0.3,
    step: 0.01,
    show: (v) => Math.round(v * 100) + '%',
    help:
      'Tabs in the same window count as up to this much more alike. At 0%, windows are ' +
      'ignored. Tabs with nothing in common are never grouped because they share a window. ' +
      'The effect is weaker when most of your tabs are in one window, because then sharing a ' +
      'window says little.',
  },
  {
    key: 'labelTerms',
    name: 'Words in each name',
    min: 1,
    max: 5,
    step: 1,
    show: (v) => String(v),
    help: 'How many words name each category and subgroup.',
  },
]
const LOG_STEPS = 1000 // positions of a log slider

// --- Tabs as the clustering sees them ---

// A tab's title without the unread count some sites put in front, as in
// "(3) Home / X", so a new notification does not make the tab look new.
const plainTitle = (t) => (t.title || '').replace(/^\(\d+\+?\)\s*/, '')

// What the model reads for a tab: its title, then the page's own content, or
// its whole text when no content could be told apart from the rest.
function embedInput(t, rec) {
  return (plainTitle(t) + '\n' + (rec ? rec.main || rec.text : '')).slice(0, 6000)
}

const vecKey = (t) => Model.M.key + '\n' + EMBED_VERSION + '\n' + plainTitle(t)

// Browser pages and blank tabs with no text are not grouped: their titles say
// nothing about a subject. Tabs that could not be read but are web pages, such
// as suspended ones, are grouped on their titles.
const skipTab = (t) => !S.cache.has(t.id) && (!t.title || !/^(https?|file):/i.test(t.url || ''))

// A tab's vector from the model, if it has one for its current title.
function vecFor(t) {
  if (Model.M.state !== 'ready') return null
  const key = vecKey(t)
  const rec = S.cache.get(t.id)
  if (rec) return rec.vecKey === key ? rec.vec : null
  const v = C.vecs.get(t.id)
  return v && v.key === key ? v.vec : null
}

// A tab's word counts are saved in its index record, so a reopened panel does not
// count them again. A record's text never changes (a re-read makes a new record),
// so the counts only go stale when the title does.
function docFor(t) {
  const rec = S.cache.get(t.id)
  const title = plainTitle(t)
  const doc = {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    title,
    text: rec ? rec.text : '',
    url: t.url || '',
    tab: t,
    vec: vecFor(t),
    skip: skipTab(t),
  }
  // a tab that could not be read is grouped on its title, which is quick to count
  if (!rec) return { ...doc, terms: Cluster.terms(title, '') }
  const key = Cluster.VERSION + '\n' + title
  if (rec.termsKey !== key) {
    rec.terms = Cluster.terms(title, rec.main || rec.text)
    rec.termsKey = key
    if (!t.incognito) dbPut(rec)
  }
  return { ...doc, terms: rec.terms }
}

// Embeds the tabs that have no vector yet, a few at a time, then regroups.
async function embedMissing() {
  if (C.embedding) return
  C.embedding = true
  try {
    for (;;) {
      if (Model.M.state !== 'ready') break
      const tabs = (await chrome.tabs.query({})).filter((t) => t.id != null && !skipTab(t) && !vecFor(t))
      C.embedLeft = tabs.length
      showNote()
      if (!tabs.length) break
      const batch = tabs.slice(0, EMBED_BATCH)
      const keys = batch.map(vecKey)
      const vecs = await Model.embed(batch.map((t) => embedInput(t, S.cache.get(t.id))))
      batch.forEach((t, i) => {
        if (keys[i] !== vecKey(t)) return // the model or the title changed meanwhile
        const rec = S.cache.get(t.id)
        if (rec) {
          rec.vec = vecs[i]
          rec.vecKey = keys[i]
          if (!t.incognito) dbPut(rec)
        } else {
          C.vecs.set(t.id, { key: keys[i], vec: vecs[i] })
        }
      })
    }
  } catch (e) {
    // the model failed, or was switched and its own state says why
    if (Model.M.state === 'ready') C.embedBroken = Model.M.key
  }
  C.embedding = false
  C.embedLeft = 0
  showNote()
  paintCats()
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
  Model.start()
  let tabs = []
  try {
    tabs = (await chrome.tabs.query({})).filter((t) => t.id != null)
  } catch (e) {}
  const live = new Set(tabs.map((t) => t.id))
  for (const id of C.vecs.keys()) if (!live.has(id)) C.vecs.delete(id)
  const docs = tabs.map(docFor)
  // Groups are drawn only once every tab is read, the model is loaded and
  // every tab has its vector, so they do not shift while the work goes on.
  // Until then the groups already on screen stay, or a message says why
  // there are none yet.
  if (busy(docs)) {
    showNote()
    if (!C.shown && !C.waiting) {
      C.waiting = true
      CATS.textContent = ''
      CATS.append(el('div', 'empty', 'The groups will show here once every tab has been read.'))
    }
    return
  }
  drawCats(Cluster.group(docs, C.params), tabs)
}

// Whether the tabs are still being read, the model loaded, or tabs embedded.
// Starts the embedding of tabs that have no vector yet.
function busy(docs) {
  const m = Model.M
  if (S.indexing || !m.checked || m.state === 'loading') return true
  if (m.state !== 'ready' || C.embedBroken === m.key) return false
  if (!docs.some((d) => !d.vec && !d.skip)) return false
  embedMissing()
  return true
}

// --- Drawing ---

function catRow(d, wins, r, byId) {
  const t = d.tab
  const row = el('div', 'tabhead cattab')
  const title = el('span', 'title', t.title || t.url)
  title.title = t.url || ''
  row.append(favicon(t.favIconUrl), title)
  const dups = r.duplicates.get(d.id)
  if (dups) {
    const tag = el('span', 'dup', 'Duplicate')
    tag.title = 'The same page is open in another tab: ' + dups.map((id) => byId.get(id).title || byId.get(id).url).join(', ')
    row.append(tag)
  }
  if (wins.size > 1) {
    const w = el('span', 'win', 'W' + wins.get(t.windowId))
    w.title = 'Window ' + wins.get(t.windowId)
    row.append(w)
  }
  row.addEventListener('click', () => focusTab({ windowId: t.windowId, tabId: t.id }))
  return row
}

// A heading that folds and unfolds the rows under it, by click or by Enter
// and Space. Folded groups are remembered by name.
function foldable(cls, name, n, key, help) {
  const box = el('div', cls === 'cathead' ? 'catgroup' : 'sub')
  const h = el('div', cls)
  const label = el('span', cls === 'cathead' ? 'catname' : 'subname', name)
  label.title = help || name
  h.append(el('span', 'tw'), label, el('span', 'badge', String(n)))
  h.tabIndex = 0
  h.setAttribute('role', 'button')
  const body = el('div', 'catbody')
  const show = () => {
    const open = !C.collapsed.has(key)
    h.setAttribute('aria-expanded', String(open))
    body.hidden = !open
  }
  const toggle = () => {
    if (C.collapsed.has(key)) C.collapsed.delete(key)
    else C.collapsed.add(key)
    show()
    saveCollapsed()
  }
  h.addEventListener('click', toggle)
  h.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  })
  show()
  box.append(h, body)
  return { box, body }
}

function saveCollapsed() {
  const keys = [...C.collapsed].slice(-MAX_COLLAPSED)
  C.collapsed = new Set(keys)
  chrome.storage.local.set({ catCollapsed: keys }).catch(() => {})
}

function drawCats(r, tabs) {
  C.mode = r.mode
  showNote()
  showSettings()
  // windows numbered in Chrome's order, for the W1, W2 tags
  const wins = new Map()
  for (const id of [...new Set(tabs.map((t) => t.windowId))].sort((a, b) => a - b)) {
    wins.set(id, wins.size + 1)
  }
  const ids = (list) => list.map((d) => [d.id, d.title, d.tab.favIconUrl])
  const what = JSON.stringify([
    r.mode,
    r.categories.map((c) => [c.label, ids(c.loose), c.subgroups.map((s) => [s.label, ids(s.tabs)])]),
    ids(r.rest),
    [...r.duplicates.keys()],
    [...wins],
  ])
  if (what === C.shown) return
  C.shown = what
  C.waiting = false
  C.draws++
  const top = CATS.scrollTop
  CATS.textContent = ''
  if (!tabs.length) {
    CATS.append(el('div', 'empty', 'No open tabs.'))
    return
  }
  if (!r.categories.length) {
    CATS.append(el('div', 'empty', 'No two tabs are about the same thing.'))
  }
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const frag = document.createDocumentFragment()
  for (const c of r.categories) {
    const sec = el('section', 'group cat')
    const cat = foldable('cathead', c.label, c.tabs.length, 'c:' + c.label)
    sec.append(cat.box)
    if (!c.subgroups.length) {
      for (const d of c.tabs) cat.body.append(catRow(d, wins, r, byId))
    } else {
      for (const s of c.subgroups) {
        const sub = foldable('subhead', s.label, s.tabs.length, 's:' + c.label + '\n' + s.label)
        for (const d of s.tabs) sub.body.append(catRow(d, wins, r, byId))
        cat.body.append(sub.box)
      }
      if (c.loose.length) {
        const help = 'Tabs in this category that are in no subgroup'
        const sub = foldable('subhead', 'Other', c.loose.length, 's:' + c.label + '\nOther', help)
        sub.box.classList.add('other')
        for (const d of c.loose) sub.body.append(catRow(d, wins, r, byId))
        cat.body.append(sub.box)
      }
    }
    frag.append(sec)
  }
  if (r.rest.length) {
    const sec = el('section', 'group cat rest')
    const rest = foldable('cathead', 'Unlike the others', r.rest.length, 'rest')
    for (const d of r.rest) rest.body.append(catRow(d, wins, r, byId))
    sec.append(rest.box)
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

// --- The model ---

const mb = (n) => (n / 1e6).toFixed(1)

// The line above the groups that says how they were made.
function showNote() {
  const m = Model.M
  let s
  if (m.state === 'downloading') s = `Downloading the model: ${mb(m.progress)} of ${mb(Model.DOWNLOAD_BYTES)} MB.`
  else if (S.indexing) s = `Reading tabs: ${S.done} of ${S.total}.`
  else if (m.state === 'loading' || (m.started && !m.checked)) s = 'Loading the model.'
  else if (m.state === 'ready' && C.embedLeft) s = `Reading the meaning of ${C.embedLeft} more tabs.`
  else if (C.mode === 'meaning') s = 'Grouped by meaning.'
  else if (m.state === 'error') s = 'The model could not be loaded, so tabs are grouped by the words they share. See Adjustments.'
  else if (m.state === 'ready') s = 'The model could not read every tab, so tabs are grouped by the words they share.'
  else s = 'Grouped by the words tabs share. To group them by meaning, set up the model under Adjustments.'
  CATNOTE.textContent = s
}

function showModel() {
  const m = Model.M
  let s
  if (m.state === 'off') s = 'Not set up. Tabs are grouped by the words they share.'
  else if (m.state === 'loading') s = 'Loading.'
  else if (m.state === 'downloading') s = `Downloading: ${mb(m.progress)} of ${mb(Model.DOWNLOAD_BYTES)} MB.`
  else if (m.state === 'ready') s = m.source === 'folder' ? 'Ready, loaded from the folder.' : 'Ready, loaded from the download.'
  else s = m.error
  $('#modelstate').textContent = s
  $('#modelstate').classList.toggle('bad', m.state === 'error')
  if (document.activeElement !== $('#modelfolder')) $('#modelfolder').value = m.folder
  const dl = $('#modeldl')
  dl.hidden = m.downloaded
  // nothing to download while a model is loaded or on its way
  dl.disabled = m.state === 'ready' || m.state === 'loading' || m.state === 'downloading'
  dl.textContent = m.state === 'downloading' ? 'Downloading' : `Download the model (${Math.round(Model.DOWNLOAD_BYTES / 1e6)} MB)`
  dl.title =
    m.state === 'ready'
      ? 'The model is already loaded from the folder, so there is nothing to download. To download it instead, empty the folder box and press Use folder.'
      : "Download the model from Hugging Face and keep it in the extension's storage. Only the model's files are fetched. Nothing about your tabs is sent."
  $('#modelrm').hidden = !m.downloaded
  showNote()
}

Model.M.onchange = () => {
  showModel()
  regroup()
}

$('#modeluse').addEventListener('click', () => Model.useFolder($('#modelfolder').value))
$('#modelfolder').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') Model.useFolder($('#modelfolder').value)
})
$('#modeldl').addEventListener('click', () => Model.download())
$('#modelrm').addEventListener('click', () => Model.removeDownload())

// --- Adjustments ---

// Settings apply to how the tabs are measured now: by meaning once the model is
// ready, otherwise by words.
const settingMode = () => (Model.M.state === 'ready' ? 'meaning' : 'words')
const rangeOf = (s) => (s.ranges ? s.ranges[settingMode()] : s)
const settingValue = (s) => {
  const own = C.params[settingMode()]
  return s.key in own ? own[s.key] : Cluster.DEFAULTS[settingMode()][s.key]
}
const showValue = (s, v) => (s.show ? s.show(v) : v.toFixed(rangeOf(s).log ? 3 : 2))

function toPos(s, v) {
  const r = rangeOf(s)
  return r.log ? Math.round((Math.log(v / r.min) / Math.log(r.max / r.min)) * LOG_STEPS) : v
}

function fromPos(s, pos) {
  const r = rangeOf(s)
  if (!r.log) return Number(pos)
  return Number((r.min * Math.pow(r.max / r.min, pos / LOG_STEPS)).toPrecision(3))
}

// Saved settings, keeping only known ones within their slider's range.
function cleanParams(values) {
  const out = { meaning: {}, words: {} }
  for (const mode of ['meaning', 'words']) {
    for (const s of SETTINGS) {
      const r = s.ranges ? s.ranges[mode] : s
      const v = values && values[mode] && values[mode][s.key]
      if (typeof v === 'number' && v >= r.min && v <= r.max) out[mode][s.key] = v
    }
  }
  return out
}

function showSetting(s) {
  const r = rangeOf(s)
  const row = s.row
  row.input.min = r.log ? '0' : String(r.min)
  row.input.max = r.log ? String(LOG_STEPS) : String(r.max)
  row.input.step = r.log ? '1' : String(r.step)
  row.input.value = String(toPos(s, settingValue(s)))
  row.val.textContent = showValue(s, settingValue(s))
  row.def.hidden = !(s.key in C.params[settingMode()])
  row.def.title = 'Back to ' + showValue(s, Cluster.DEFAULTS[settingMode()][s.key])
}

function showSettings() {
  for (const s of SETTINGS) showSetting(s)
  $('#catreset').disabled = !Object.keys(C.params[settingMode()]).length
  $('#catmode').textContent =
    settingMode() === 'meaning'
      ? 'These settings apply while tabs are grouped by meaning.'
      : 'These settings apply while tabs are grouped by the words they share.'
}

// Regroups shortly after a setting changes, at most once per this many ms.
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
  const own = C.params[settingMode()]
  const d = Cluster.DEFAULTS[settingMode()][s.key]
  // a log slider can't land exactly on its default
  if (Math.abs(v - d) <= Math.abs(d) * 0.01) delete own[s.key]
  else own[s.key] = v
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
  const input = el('input')
  input.type = 'range'
  input.id = 'set-' + s.key
  top.append(name, val, def)
  box.append(top, input)
  $('#catsliders').append(box)
  s.row = { input, val, def }
  input.addEventListener('input', () => setParam(s, fromPos(s, input.value)))
  def.addEventListener('click', () => setParam(s, Cluster.DEFAULTS[settingMode()][s.key]))
}

$('#catreset').addEventListener('click', () => {
  C.params[settingMode()] = {}
  showSettings()
  saveParams()
  regroup()
})
$('#catopts').addEventListener('toggle', () => saveUi())

// Settings and the model folder changed in another window's panel apply here too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  const p = changes.catParams && changes.catParams.newValue
  if (p && p.from !== ME) {
    C.params = cleanParams(p.values)
    showSettings()
    regroup()
  }
  if (changes.modelFolder) Model.folderChanged(changes.modelFolder.newValue || '')
})

C.ready = chrome.storage.local
  .get(['catParams', 'catCollapsed'])
  .then((r) => {
    C.params = cleanParams(r.catParams && r.catParams.values)
    if (Array.isArray(r.catCollapsed)) C.collapsed = new Set(r.catCollapsed.filter((k) => typeof k === 'string'))
  })
  .catch(() => {})
  .finally(() => {
    showSettings()
    showModel()
  })

chrome.tabs.onMoved.addListener(scheduleCats)
chrome.tabs.onAttached.addListener(scheduleCats)
chrome.tabs.onDetached.addListener(scheduleCats)
CATS.addEventListener('scroll', () => saveUi(), { passive: true })
// names an earlier version had Chrome's AI model write
chrome.storage.local.remove('catNames').catch(() => {})
