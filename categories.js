'use strict'

// The Categories view: every open tab, grouped by subject. Groups come from
// cluster.js and are named by their most telling words.
const CATS = $('#cats')
const CATS_MS = 600 // regrouping is coalesced to one per this interval

const C = {
  timer: 0,
  shown: '', // what the view on screen was drawn from
  pendingScroll: null, // saved scroll position, applied by the first drawing
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

chrome.tabs.onMoved.addListener(scheduleCats)
chrome.tabs.onAttached.addListener(scheduleCats)
chrome.tabs.onDetached.addListener(scheduleCats)
CATS.addEventListener('scroll', () => saveUi(), { passive: true })
// names an earlier version had Chrome's AI model write
chrome.storage.local.remove('catNames').catch(() => {})
