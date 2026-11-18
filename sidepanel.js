'use strict'

const $ = (id) => document.querySelector(id)
const Q = $('#q')
const DOMAIN = $('#dom')
const DOMS = $('#doms')
const RESULTS = $('#results')
const COUNT = $('#count')
const STATUS = $('#status')
const BAD = $('#bad')
const SEARCHBAR = $('#searchbar')

const PER_TAB = 5 // snippets shown per tab
const MAX_GROUPS = 400 // tabs listed
const PAD = 80 // snippet context chars
const REFRESH_MS = 150 // repaints are coalesced to one per this interval
const MIN_DOWNLOADED_TEXT = 200 // less than this in a downloaded page is an empty app shell
const NOT_LOADED = 'Not loaded'

const S = {
  cache: new Map(), // tabId -> record
  failed: new Map(), // tabId -> why it could not be read
  badOpen: false,
  badKey: '',
  query: '',
  domain: '',
  mode: { cs: false, ww: false, re: false },
  indexing: false,
  done: 0,
  total: 0,
  refreshT: 0,
  run: 0,
  groups: [],
  flat: [], // one entry per rendered snippet
  rows: [],
  sel: -1,
  pending: null, // saved selection and scroll, applied by the first paint with results
  painted: '', // what the results on screen are for
  view: 'search', // or 'cats'
}

// Tells this panel's saves apart from those of the panels in other windows.
const ME = Math.random().toString(36).slice(2)

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESC[c])
}

function squash(s) {
  return s.replace(/\s+/g, ' ')
}

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function favicon(src) {
  // chrome:// and other extensions' icons are refused and only log errors
  if (!/^(https?|data):/.test(src || '')) return el('span', 'fav ph')
  const img = new Image()
  img.className = 'fav'
  img.referrerPolicy = 'no-referrer'
  img.addEventListener('error', () => img.remove())
  img.src = src
  return img
}

function selKey(e) {
  return e ? e.rec.tabId + ':' + e.hit.i : ''
}

// The panel's state is saved as it changes, so a panel opened later, in any
// window, picks up where the last one left off.
let saveT = 0
function saveUi(now) {
  clearTimeout(saveT)
  const go = () => {
    const ui = {
      from: ME,
      q: Q.value,
      dom: DOMAIN.value,
      mode: S.mode,
      badOpen: S.badOpen,
      sel: S.pending ? S.pending.sel : selKey(S.flat[S.sel]),
      scroll: S.pending ? S.pending.scroll : RESULTS.scrollTop,
      view: S.view,
      catsScroll: C.pendingScroll != null ? C.pendingScroll : CATS.scrollTop,
      catOpts: $('#catopts').open,
      catBy: C.by,
    }
    chrome.storage.local.set({ ui }).catch(() => {})
  }
  if (now) go()
  else saveT = setTimeout(go, 150)
}

function applyUi(ui) {
  clearTimeout(Q._t)
  clearTimeout(DOMAIN._t)
  Q.value = ui.q || ''
  DOMAIN.value = ui.dom || ''
  S.query = Q.value
  S.domain = normDomain(DOMAIN.value)
  if (ui.mode) Object.assign(S.mode, ui.mode)
  for (const k of ['cs', 'ww', 're']) $('#' + k).classList.toggle('on', !!S.mode[k])
  S.badOpen = !!ui.badOpen
  S.view = ui.view === 'cats' ? 'cats' : 'search'
  $('#catopts').open = !!ui.catOpts
  C.by = ui.catBy === 'window' ? 'window' : 'subject'
}

// Shows the Search or the Categories view, whichever S.view says.
function showView(draw = true) {
  const cats = S.view === 'cats'
  $('#v-search').setAttribute('aria-selected', String(!cats))
  $('#v-cats').setAttribute('aria-selected', String(cats))
  SEARCHBAR.hidden = cats
  $('#catby').hidden = !cats
  showBy()
  RESULTS.hidden = cats
  CATS.hidden = !cats
  if (cats && draw) paintCats()
  if (!cats) Q.focus()
}

function paintStatus(s) {
  STATUS.textContent = s
  BAD.hidden = true
}

// Wakes a suspended tab in place. It is read when it finishes loading.
function load(t) {
  S.failed.set(t.id, 'Loading…')
  chrome.tabs.reload(t.id).catch(() => S.failed.set(t.id, NOT_LOADED)).finally(refresh)
  refresh()
}

function whyNot(t) {
  return canInject(t.url) ? S.failed.get(t.id) || '' : 'Restricted by Chrome'
}

function paintBad(bad) {
  BAD.hidden = !S.badOpen || !bad.length
  if (BAD.hidden) return
  const key = bad.map((t) => [t.id, t.url, t.title, whyNot(t)].join(' ')).join('\n')
  if (key === S.badKey) return
  S.badKey = key
  BAD.textContent = ''
  const asleep = bad.filter((t) => whyNot(t) === NOT_LOADED)
  if (asleep.length) {
    const bar = el('div', 'badbar')
    const all = el('button', '', 'Load all (' + asleep.length + ')')
    all.type = 'button'
    all.addEventListener('click', () => asleep.forEach(load))
    bar.append(all)
    BAD.append(bar)
  }
  for (const t of bad) {
    const row = el('div', 'tabhead')
    const title = el('span', 'title', t.title || t.url)
    title.title = t.url || ''
    row.append(favicon(t.favIconUrl), title, el('span', 'why', whyNot(t)))
    if (whyNot(t) === NOT_LOADED) {
      const btn = el('button', '', 'Load')
      btn.type = 'button'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        load(t)
      })
      row.append(btn)
    }
    row.addEventListener('click', () => focusTab({ windowId: t.windowId, tabId: t.id }))
    BAD.append(row)
  }
}

async function paintSummary() {
  let bad = []
  try {
    const tabs = await chrome.tabs.query({})
    bad = tabs.filter((t) => t.id != null && whyNot(t))
  } catch (e) {}
  STATUS.textContent = S.cache.size + ' tabs indexed' + (bad.length ? ', ' : '')
  if (bad.length) {
    const btn = el('button', '', bad.length + ' not searchable')
    btn.type = 'button'
    btn.setAttribute('aria-expanded', String(S.badOpen))
    btn.addEventListener('click', () => {
      S.badOpen = !S.badOpen
      saveUi()
      paintSummary()
    })
    STATUS.append(btn)
  }
  paintBad(bad)
}

function paintCount(s) {
  COUNT.textContent = s
}

// Tabs this extension is allowed to read. Everything else (chrome://, the Web
// Store, other extensions, devtools, view-source, PDF viewer) is unreachable.
const BLOCKED = /^(chrome|chrome-untrusted|edge|brave|about|devtools|view-source|chrome-extension|moz-extension|data|blob):/

function canInject(url) {
  if (!url || BLOCKED.test(url)) return false
  if (url.startsWith('https://chrome.google.com/webstore')) return false
  return /^(https?|file|ftp):/.test(url)
}

function hostsOf(url) {
  try {
    const u = new URL(url)
    return { host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase() }
  } catch (e) {
    return { host: '', hostname: '' }
  }
}

// Accepts "x.com", "*.x.com", "www.x.com", "https://x.com/home", "x.com:8443".
function normDomain(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  s = s.replace(/^\*\./, '').replace(/^www\./, '')
  return s.replace(/\.+$/, '')
}

// "x.com" covers x.com and any subdomain. Compare against both the host and the
// hostname so an explicit port narrows the match and an IPv6 literal still works.
function domMatch(rec, f) {
  if (!f) return true
  for (const h of [rec.hostname, rec.host]) {
    if (h && (h === f || h.endsWith('.' + f))) return true
  }
  return false
}

/* Runs inside each page and each of its frames. Self contained. */
function extract(doc = document) {
  const parts = []
  let bodyLength = 0
  let main = ''
  if (doc.title) parts.push(doc.title)
  const meta = doc.querySelector('meta[name="description"]')
  if (meta && meta.content) parts.push(meta.content)
  if (doc.body) {
    const SKIP = 'script,style,noscript,template'
    const skip = new Set(SKIP.split(','))
    // Elements inside a skipped element are rare, and only they need the slow ancestor check.
    const nested = doc.body.querySelector('script *,style *,noscript *,template *')
    const textOf = (root) => {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION)
      const chunks = []
      let n
      while ((n = walker.nextNode())) {
        const p = n.parentElement
        if (nested ? !p.closest(SKIP) : !skip.has(p.localName)) chunks.push(n.data)
      }
      return chunks.join('').replace(/\s+/g, ' ').trim()
    }
    const t = textOf(doc.body)
    bodyLength = t.length
    if (t) parts.push(t)
    // The page's own content, without its menus, sidebars and footer, for
    // grouping tabs by subject: the outermost <article>s (a post, a story), or
    // else <main>. Pages without either are grouped on their whole text.
    const articles = [...doc.body.querySelectorAll('article')]
    let roots = articles.filter((a) => !articles.some((b) => b !== a && b.contains(a)))
    if (!roots.length) roots = [...doc.body.querySelectorAll('main,[role="main"]')].slice(0, 1)
    const content = roots.map(textOf).join('\n')
    if (content.length >= 200) {
      main = ((meta && meta.content ? meta.content + '\n' : '') + content).slice(0, 8000)
    }
  }
  for (const f of doc.querySelectorAll('input,textarea')) {
    if (f.type === 'password') continue
    const v = f.value
    if (typeof v === 'string' && v) parts.push(v)
  }
  return {
    url: location.href,
    text: parts.join('\n'),
    main,
    // true in Chrome's viewer and in viewers that sit on top of it, like Scholar's
    pdf: doc.contentType === 'application/pdf',
    bodyLength,
  }
}

function forget(id, why) {
  S.cache.delete(id)
  S.failed.set(id, why)
  dbDel(id)
}

// XHR because fetch refuses file:// URLs.
function download(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'arraybuffer'
    xhr.withCredentials = true
    xhr.onload = () => (xhr.status < 400 ? resolve(xhr) : reject(new Error(xhr.status)))
    xhr.onerror = () => reject(new Error('network'))
    xhr.send()
  })
}

let pdfjs

// Loaded on first use. Every PDF shares one worker instead of starting its own.
function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = import('./vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs')
      return { lib, worker: new lib.PDFWorker({ verbosity: lib.VerbosityLevel.ERRORS }) }
    })
  }
  return pdfjs
}

async function parsePdf(buffer) {
  const { lib, worker } = await loadPdfjs()
  const task = lib.getDocument({
    data: new Uint8Array(buffer),
    worker,
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    isEvalSupported: false,
    verbosity: lib.VerbosityLevel.ERRORS,
  })
  try {
    const doc = await task.promise
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const { items } = await page.getTextContent()
      pages.push(items.map((x) => (x.str || '') + (x.hasEOL ? ' ' : '')).join(''))
      page.cleanup()
    }
    return squash(pages.join(' ')).trim()
  } finally {
    await task.destroy()
  }
}

function withTitle(t, body) {
  return t.title ? t.title + '\n' + body : body
}

function isAsleep(t) {
  return t.discarded || t.status === 'unloaded'
}

function decode(xhr) {
  const head = new TextDecoder('latin1').decode(xhr.response.slice(0, 2048))
  const re = /charset=["']?([\w-]+)/i
  const m = re.exec(xhr.getResponseHeader('content-type') || '') || re.exec(head)
  try {
    return new TextDecoder(m ? m[1] : 'utf-8').decode(xhr.response)
  } catch (e) {
    return new TextDecoder().decode(xhr.response)
  }
}

// main: the page's own content for grouping, or '' to group on the whole text
function saveTab(t, text, main = '') {
  const rec = {
    tabId: t.id,
    windowId: t.windowId,
    index: t.index || 0,
    title: t.title || '',
    url: t.url || '',
    fav: t.favIconUrl || '',
    ...hostsOf(t.url),
    text,
    main,
    hits: 0,
  }
  S.cache.set(t.id, rec)
  S.failed.delete(t.id)
  if (!t.incognito) dbPut(rec)
}

// A suspended tab has no page to inject into, so download its URL instead. This
// does not wake it. Pages built by JavaScript come back as an empty shell.
async function readAsleep(t) {
  let xhr
  try {
    xhr = await download(t.url)
  } catch (e) {
    forget(t.id, NOT_LOADED)
    return
  }
  const type = xhr.getResponseHeader('content-type') || ''
  const magic = new TextDecoder('latin1').decode(xhr.response.slice(0, 5))
  if (type.includes('application/pdf') || magic === '%PDF-') {
    try {
      const body = await parsePdf(xhr.response)
      if (body) saveTab(t, withTitle(t, body))
      else forget(t.id, 'No text found')
    } catch (e) {
      forget(t.id, 'PDF could not be read')
    }
    return
  }
  const redirected = hostsOf(xhr.responseURL).hostname !== hostsOf(t.url).hostname
  if (redirected || (type && !/html|xml|text/i.test(type))) {
    forget(t.id, NOT_LOADED)
    return
  }
  const v = extract(new DOMParser().parseFromString(decode(xhr), 'text/html'))
  if (v.bodyLength < MIN_DOWNLOADED_TEXT) forget(t.id, NOT_LOADED)
  else saveTab(t, v.text, v.main)
}

async function readTab(t) {
  if (t.id == null || !canInject(t.url)) return
  if (isAsleep(t)) {
    if (!S.cache.has(t.id)) await readAsleep(t)
    return
  }
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: t.id, allFrames: true },
      func: extract,
    })
    let pdfFailed = false
    const mains = []
    const parts = await Promise.all(
      res.map(async (r) => {
        const v = r && r.result
        if (!v || !v.pdf) {
          if (v && v.main) mains.push(v.main)
          return v && v.text
        }
        try {
          const body = await parsePdf((await download(v.url)).response)
          return body && withTitle(t, body)
        } catch (e) {
          pdfFailed = true
        }
      })
    )
    const text = parts.filter(Boolean).join('\n')
    if (!text) {
      forget(t.id, pdfFailed ? 'PDF could not be read' : 'No text found')
      return
    }
    saveTab(t, text, mains.join('\n').slice(0, 8000))
  } catch (e) {
    forget(t.id, 'Could not be read')
  }
}

// Loads the saved index and returns the tabs it does not cover.
async function restore(targets) {
  let saved = []
  try {
    saved = await dbAll()
  } catch (e) {}
  const live = new Map(targets.map((t) => [t.id, t]))
  for (const rec of saved) {
    const t = live.get(rec.tabId)
    if (!t || t.url !== rec.url) {
      dbDel(rec.tabId)
      continue
    }
    // a tab that finished loading while this ran has fresher text already
    if (S.cache.has(t.id)) continue
    S.cache.set(t.id, {
      ...rec,
      windowId: t.windowId,
      index: t.index || 0,
      title: t.title || '',
      fav: t.favIconUrl || '',
    })
  }
  return targets.filter((t) => !S.cache.has(t.id))
}

function refresh() {
  if (S.refreshT) return
  S.refreshT = setTimeout(() => {
    S.refreshT = 0
    if (S.indexing) paintStatus('Indexing ' + S.done + '/' + S.total)
    else paintSummary()
    paintDomains()
    if (S.query) runSearch()
    if (typeof scheduleCats === 'function') scheduleCats()
  }, REFRESH_MS)
}

async function indexAll(full) {
  if (S.indexing) return
  S.indexing = true
  const run = ++S.run
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id != null)
  const targets = tabs.filter((t) => canInject(t.url))
  if (full) {
    // a suspended tab cannot be read again, so its text is kept
    const asleep = new Set(tabs.filter(isAsleep).map((t) => t.id))
    for (const id of S.cache.keys()) if (!asleep.has(id)) S.cache.delete(id)
    S.failed.clear()
  }
  const todo = full ? targets.filter((t) => !S.cache.has(t.id)) : await restore(targets)
  if (run !== S.run) return
  S.done = 0
  S.total = todo.length
  paintStatus('Indexing 0/' + todo.length)
  paintDomains()
  if (S.query) runSearch()
  scheduleCats()
  // All at once and not in batches, so a slow tab only ever delays itself.
  await Promise.all(
    todo.map(async (t) => {
      await readTab(t)
      if (run !== S.run) return
      S.done++
      refresh()
    })
  )
  if (run !== S.run) return
  S.indexing = false
  await paintSummary()
  paintDomains()
  if (S.query) runSearch()
  scheduleCats()
}

function buildRe(q, m) {
  let src = m.re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (m.ww) src = '\\b(?:' + src + ')\\b'
  return new RegExp(src, m.cs ? 'g' : 'gi')
}

function runSearch() {
  const q = S.query
  const min = S.mode.re ? 1 : 2
  if (q.length < min) {
    S.groups = []
    paint()
    paintCount('')
    return
  }
  let re
  try {
    re = buildRe(q, S.mode)
  } catch (e) {
    S.groups = []
    S.flat = []
    S.rows = []
    S.sel = -1
    RESULTS.textContent = ''
    RESULTS.append(el('div', 'empty', 'Invalid regular expression.'))
    paintCount('Invalid pattern')
    return
  }
  const groups = []
  const domain = S.domain
  for (const rec of S.cache.values()) {
    if (groups.length >= MAX_GROUPS) break
    if (domain && !domMatch(rec, domain)) continue
    re.lastIndex = 0
    const hits = []
    let total = 0
    let m
    while ((m = re.exec(rec.text))) {
      total++
      if (hits.length < PER_TAB) hits.push({ i: m.index, len: m[0].length })
      if (m[0].length === 0) re.lastIndex++
      if (total >= 5000) break
    }
    rec.hits = total
    if (total) groups.push({ rec, hits, total })
  }
  groups.sort(
    (a, b) => b.total - a.total || a.rec.windowId - b.rec.windowId || a.rec.index - b.rec.index
  )
  S.groups = groups
  paint()
}

function snippet(text, i, len) {
  const a = text.slice(Math.max(0, i - PAD), i)
  let mid = text.slice(i, i + len)
  const c = text.slice(i + len, i + len + PAD)
  let clipped = false
  if (mid.length > 160) {
    mid = mid.slice(0, 160)
    clipped = true
  }
  const lead = i > PAD ? '…' : ''
  const tail = i + len + PAD < text.length ? '…' : ''
  return (
    lead +
    esc(squash(a).trimStart()) +
    '<mark>' +
    esc(squash(mid)) +
    (clipped ? '…' : '') +
    '</mark>' +
    esc(squash(c).trimEnd()) +
    tail
  )
}

function paintDomains() {
  const seen = new Set()
  for (const r of S.cache.values()) if (r.hostname) seen.add(r.hostname)
  DOMS.textContent = ''
  for (const h of [...seen].sort()) {
    const opt = document.createElement('option')
    opt.value = h
    DOMS.append(opt)
  }
}

function paint() {
  // A repaint of the same search keeps the selected result and the scroll position.
  const what = JSON.stringify([S.query, S.domain, S.mode])
  const same = what === S.painted
  S.painted = what
  const top = RESULTS.scrollTop
  const keep = S.pending ? S.pending.sel : same ? selKey(S.flat[S.sel]) : ''
  RESULTS.textContent = ''
  S.flat = []
  S.rows = []
  S.sel = -1
  const groups = S.groups
  if (!S.query || S.query.length < (S.mode.re ? 1 : 2)) {
    S.pending = null
    RESULTS.append(el('div', 'empty', 'Type to search the text of every open tab.'))
    return
  }
  if (!groups.length) {
    // the matches may be in tabs that are still being read
    if (!S.indexing) S.pending = null
    if (S.domain) {
      const inScope = [...S.cache.values()].filter((r) => domMatch(r, S.domain)).length
      RESULTS.append(
        el(
          'div',
          'empty',
          inScope
            ? 'No matches in ' + inScope + ' tabs on ' + S.domain + '.'
            : 'No open tab matches ' + S.domain + '.'
        )
      )
    } else {
      RESULTS.append(el('div', 'empty', 'No matches in ' + S.cache.size + ' indexed tabs.'))
    }
    paintCount('0 matches')
    return
  }
  const frag = document.createDocumentFragment()
  let shown = 0
  for (const g of groups) {
    const sec = el('section', 'group')
    const head = el('div', 'tabhead')
    head.append(favicon(g.rec.fav))
    const title = el('span', 'title', g.rec.title || g.rec.url)
    title.title = g.rec.url
    head.append(title, el('span', 'badge', String(g.total)))
    head.addEventListener('click', () => focusTab(g.rec))
    sec.append(head)
    for (const h of g.hits) {
      const row = el('div', 'hit')
      row.innerHTML = snippet(g.rec.text, h.i, h.len)
      const idx = S.flat.length
      S.flat.push({ rec: g.rec, hit: h })
      S.rows.push(row)
      row.addEventListener('click', () => {
        S.sel = idx
        select()
        jump(idx)
      })
      sec.append(row)
      shown++
    }
    if (g.total > g.hits.length) {
      sec.append(el('div', 'more', '+' + (g.total - g.hits.length) + ' more in this tab'))
    }
    frag.append(sec)
  }
  RESULTS.append(frag)
  if (keep) {
    S.sel = S.flat.findIndex((e) => selKey(e) === keep)
    if (S.sel >= 0) S.rows[S.sel].classList.add('sel')
  }
  if (S.pending) RESULTS.scrollTop = S.pending.scroll || 0
  else RESULTS.scrollTop = same ? top : 0
  S.pending = null
  paintCount(
    shown +
      ' matches in ' +
      groups.length +
      ' tabs' +
      (S.domain ? ' on ' + S.domain : '') +
      (groups.length >= MAX_GROUPS ? ' (capped)' : '')
  )
}

function focusTab(rec) {
  chrome.windows.update(rec.windowId, { focused: true }).catch(() => {})
  chrome.tabs.update(rec.tabId, { active: true }).catch(() => {})
}

/* Runs in the page: reveal the match using the browser's own find. */
function findText(cands, cs) {
  try {
    if (typeof window.find !== 'function') return false
    for (const t of cands) {
      if (t && window.find(t, cs, false, true, false, false)) return true
    }
  } catch (e) {}
  return false
}

function candidates(rec, hit) {
  const raw = rec.text.slice(hit.i, hit.i + Math.min(hit.len || 0, 200)).trim()
  const out = []
  if (raw && raw.length <= 120) out.push(raw)
  const toks = raw
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)
  for (const t of toks) if (!out.includes(t)) out.push(t)
  if (!out.length) out.push(S.query)
  return out.slice(0, 4)
}

async function jump(idx) {
  const e = S.flat[idx]
  if (!e) return
  focusTab(e.rec)
  const args = [candidates(e.rec, e.hit), S.mode.cs]
  let ok = false
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: e.rec.tabId },
      func: findText,
      args,
    })
    ok = r.some((x) => x && x.result)
  } catch (err) {}
  if (ok) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId: e.rec.tabId, allFrames: true },
      func: findText,
      args,
    })
  } catch (err) {}
}

function select() {
  for (let i = 0; i < S.rows.length; i++) S.rows[i].classList.toggle('sel', i === S.sel)
  if (S.sel >= 0) S.rows[S.sel].scrollIntoView({ block: 'nearest' })
  saveUi()
}

Q.addEventListener('input', () => {
  saveUi()
  clearTimeout(Q._t)
  const go = () => {
    S.query = Q.value
    runSearch()
  }
  if (!Q.value) go()
  else Q._t = setTimeout(go, 120)
})

DOMAIN.addEventListener('input', () => {
  saveUi()
  clearTimeout(DOMAIN._t)
  const go = () => {
    S.domain = normDomain(DOMAIN.value)
    runSearch()
    if (S.view === 'cats') paintCats()
  }
  if (!DOMAIN.value) go()
  else DOMAIN._t = setTimeout(go, 120)
})

for (const [key, id] of [
  ['cs', '#cs'],
  ['ww', '#ww'],
  ['re', '#re'],
]) {
  const btn = $(id)
  btn.addEventListener('click', () => {
    S.mode[key] = !S.mode[key]
    btn.classList.toggle('on', S.mode[key])
    saveUi()
    runSearch()
  })
}

$('#refresh').addEventListener('click', () => {
  S.run++
  S.indexing = false
  indexAll(true)
})

for (const [view, id] of [
  ['search', '#v-search'],
  ['cats', '#v-cats'],
]) {
  $(id).addEventListener('click', () => {
    if (S.view === view) return
    S.view = view
    saveUi()
    showView()
  })
}

document.addEventListener('keydown', (e) => {
  if (S.view !== 'search') return
  if (e.target === DOMAIN || e.target.closest('#status, #bad')) return
  if (e.key === 'Enter' && S.flat.length) {
    e.preventDefault()
    jump(S.sel >= 0 ? S.sel : 0)
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if (!S.flat.length) return
  e.preventDefault()
  if (e.key === 'ArrowDown') S.sel = Math.min(S.flat.length - 1, S.sel + 1)
  else S.sel = Math.max(0, S.sel - 1)
  select()
})

RESULTS.addEventListener('scroll', () => saveUi(), { passive: true })
addEventListener('pagehide', () => saveUi(true))

// A change made in the panel of another window shows up here too.
chrome.storage.onChanged.addListener((changes, area) => {
  const ui = area === 'local' && changes.ui && changes.ui.newValue
  if (!ui || ui.from === ME) return
  const view = S.view
  const by = C.by
  const domain = S.domain
  applyUi(ui)
  if (S.view !== view) showView()
  else if (C.by !== by || S.domain !== domain) {
    showBy()
    if (S.view === 'cats') paintCats()
  }
  if (!S.indexing) paintSummary()
  runSearch()
})

chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url) {
    S.cache.delete(id)
    S.failed.delete(id)
  }
  if (info.status !== 'complete') return
  readTab(tab).then(refresh)
})

chrome.tabs.onRemoved.addListener((id) => {
  S.cache.delete(id)
  S.failed.delete(id)
  refresh()
})

// Chrome gives a tab a new id when it suspends it.
chrome.tabs.onReplaced.addListener((added, removed) => {
  const rec = S.cache.get(removed)
  if (rec) {
    S.cache.delete(removed)
    rec.tabId = added
    S.cache.set(added, rec)
  }
  if (S.failed.has(removed)) {
    S.failed.set(added, S.failed.get(removed))
    S.failed.delete(removed)
  }
  refresh()
})

;(async function init() {
  // categories.js runs after this file, and a storage reply can arrive before it does
  if (document.readyState === 'loading') {
    await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }))
  }
  try {
    // "mode" is where versions before the saved panel state kept the options
    const { ui, mode } = await chrome.storage.local.get(['ui', 'mode'])
    const saved = ui || { mode }
    applyUi(saved)
    S.pending = { sel: saved.sel || '', scroll: saved.scroll || 0 }
    C.pendingScroll = saved.catsScroll || 0
  } catch (e) {}
  // the first grouping waits for the saved index, so it is not done on titles alone
  showView(false)
  // with a saved query, the first paint waits for the saved index
  if (!S.query) paint()
  await indexAll()
})()
