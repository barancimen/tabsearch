// Unit test for cluster.js on real article text and made-up social media pages.
// Runs in plain Node in a few seconds:   node test/cluster.test.mjs
// The vectors in fixtures/vectors.json come from test/make-vectors.py.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ctx = {}
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(here, '..', 'cluster.js'), 'utf8') + '\nthis.Cluster = Cluster', ctx)
const Cluster = ctx.Cluster
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'))
const { articles } = fixture('articles.json')
const social = fixture('social.json').pages
const { vectors } = fixture('vectors.json')

let checks = 0
let fails = 0
const ok = (c, label, extra) => {
  checks++
  if (!c) {
    fails++
    console.log('FAIL ' + label + (extra ? ' :: ' + extra : ''))
  }
}

const TOPIC = {
  Pasta: 'food',
  Lasagna: 'food',
  Risotto: 'food',
  Pizza: 'food',
  'Python (programming language)': 'code',
  JavaScript: 'code',
  'Rust (programming language)': 'code',
  Jupiter: 'space',
  'Black hole': 'space',
  'Andromeda Galaxy': 'space',
  'Taj Mahal': 'alone',
  Mortgage: 'money',
}
for (const [name, p] of Object.entries(social)) TOPIC[name] = p.topic

// The pages as the panel would see them: Wikipedia's text has its menu in
// front, and a social page's text has the site's menus, sidebar and footer
// around the post. main is the page's own content (the <main> or <article>),
// which is what the words are counted from. Built as make-vectors.py builds them.
const PAGES = []
for (const [name, body] of Object.entries(articles)) {
  const title = name + ' - Wikipedia'
  const text = title + '\nMain menu Navigation Search Donate Create account Log in\n' + body
  PAGES.push({ name, title, text, main: body, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(name) })
}
for (const [name, p] of Object.entries(social)) {
  const text = [p.title, p.nav, p.article, p.aside, p.footer].join('\n')
  PAGES.push({ name, title: p.title, text, main: p.article, url: 'https://' + p.host + '/' + encodeURIComponent(name) })
}

function docs(windowOf, withVectors) {
  return PAGES.map((p, i) => ({
    id: i,
    windowId: windowOf(p.name, i),
    index: i,
    title: p.title,
    text: p.text,
    url: p.url,
    name: p.name,
    terms: Cluster.terms(p.title, p.main),
    vec: withVectors ? vectors[p.name] : null,
  }))
}

// "food: Lasagna, Pasta | ..." with the categories and their tabs in a stable order
function shape(r) {
  const gs = r.categories.map((c) => {
    const ts = c.tabs.map((d) => d.name).sort()
    return TOPIC[ts[0]] + ': ' + ts.join(', ')
  })
  return gs.sort().join(' | ') + ' || ' + r.rest.map((d) => d.name).sort().join(', ')
}

const byTopic = {}
for (const p of PAGES) (byTopic[TOPIC[p.name]] = byTopic[TOPIC[p.name]] || []).push(p.name)
const want =
  Object.entries(byTopic)
    .filter(([t, ns]) => ns.length > 1)
    .map(([t, ns]) => t + ': ' + ns.sort().join(', '))
    .sort()
    .join(' | ') +
  ' || ' +
  Object.values(byTopic)
    .filter((ns) => ns.length === 1)
    .flat()
    .sort()
    .join(', ')

// windows that cut across the subjects
const MIXED = { Pasta: 1, 'Python (programming language)': 1, Jupiter: 1, 'X: mortgage rates': 1, Lasagna: 2, JavaScript: 2, 'Black hole': 2, 'X: fresh pasta': 2 }
const LAYOUTS = [
  ['each tab in its own window', (n, i) => i],
  ['all tabs in one window', () => 1],
  ['windows that mix subjects', (n) => MIXED[n] || 3],
]

for (const mode of ['words', 'meaning']) {
  const meaning = mode === 'meaning'
  for (const [layout, windowOf] of LAYOUTS) {
    const t0 = Date.now()
    const r = Cluster.group(docs(windowOf, meaning))
    if (layout === LAYOUTS[0][0]) console.log(`grouped ${PAGES.length} pages by ${mode} in ${Date.now() - t0} ms`)
    ok(r.mode === mode, mode + ': measured by ' + mode, r.mode)
    ok(shape(r) === want, mode + ': categories follow the subject, ' + layout, shape(r))
  }
  const r = Cluster.group(docs((n, i) => i, meaning))
  const catOf = (name) => r.categories.find((c) => c.tabs.some((d) => d.name === name))
  const xPosts = PAGES.filter((p) => p.name.startsWith('X: ')).map((p) => p.name)
  ok(new Set(xPosts.map((n) => catOf(n) && catOf(n).label)).size === xPosts.length, mode + ': posts on X about different things are in different categories')
  for (const c of r.categories) {
    ok(c.keywords.length >= 1 && c.keywords.length <= 3, mode + ': one to three words per name', c.label)
    ok(c.keywords.every((w) => /^\p{Lu}|^\p{Ll}+\p{Lu}/u.test(w)), mode + ': name words are capitalised', c.label)
    const lower = c.keywords.map((w) => w.toLowerCase())
    ok(new Set(lower).size === lower.length, mode + ': no repeated words in a name', c.label)
    ok(!c.subgroups.length || c.subgroups.length >= 2, mode + ': a category splits into two or more subgroups or none', c.label)
    const ids = new Set(c.tabs.map((d) => d.id))
    const inSubs = c.subgroups.flatMap((s) => s.tabs.map((d) => d.id))
    ok(inSubs.every((id) => ids.has(id)) && inSubs.length + c.loose.length === c.tabs.length, mode + ': subgroups and the rest make up the category', c.label)
    for (const s of c.subgroups) {
      const own = s.keywords.map((w) => w.toLowerCase())
      ok(!own.some((w) => lower.includes(w)), mode + ': a subgroup name does not repeat its category name', s.label + ' in ' + c.label)
    }
  }
  console.log(mode + ': ' + r.categories.map((c) => c.label + (c.subgroups.length ? ' [' + c.subgroups.map((s) => s.label).join(' / ') + ']' : '')).join(' | '))
  ok(/programming|code|compiler|language/i.test(catOf('JavaScript').label), mode + ': the code category is named for code', catOf('JavaScript').label)
  ok(/black hole/i.test(catOf('Black hole').label + ' ' + catOf('Black hole').subgroups.map((s) => s.label).join(' ')), mode + ': "black hole" stays a phrase in names')
  ok(r.duplicates.size === 0, mode + ': no duplicates among different pages')
}

// Meaning: the space category splits into black holes and galaxies
{
  const r = Cluster.group(docs((n, i) => i, true))
  const space = r.categories.find((c) => c.tabs.some((d) => d.name === 'Jupiter'))
  const subs = space.subgroups.map((s) => s.tabs.map((d) => d.name).sort().join(' + ')).sort()
  ok(
    subs.join(' | ') === 'Andromeda Galaxy + X: galaxy image | Black hole + YouTube: black holes',
    'meaning: the space category splits into subgroups',
    subs.join(' | ')
  )
  // each post on X is most like a page on its own subject, not another post on X
  const cos = (a, b) => vectors[a].reduce((s, x, k) => s + x * vectors[b][k], 0)
  for (const x of PAGES.filter((p) => p.name.startsWith('X: ')).map((p) => p.name)) {
    const nearest = PAGES.map((p) => p.name).filter((n) => n !== x).sort((a, b) => cos(x, b) - cos(x, a))[0]
    ok(TOPIC[nearest] === TOPIC[x], 'meaning: ' + x + ' is most like a page on its subject', nearest)
  }
  // one tab without a vector: everything is measured by words
  const partial = docs((n, i) => i, true)
  partial[0].vec = null
  ok(Cluster.group(partial).mode === 'words', 'a tab without a vector makes the grouping use words')
}

// the settings the panel's sliders change
{
  const base = Cluster.group(docs((n, i) => i, true))
  const strict = Cluster.group(docs((n, i) => i, true), { meaning: { category: 0.7 } })
  ok(strict.rest.length > base.rest.length, 'a stricter category leaves more tabs alone', strict.rest.length)
  const loose = Cluster.group(docs((n, i) => i, true), { meaning: { category: 0.3 } })
  ok(loose.categories.length < base.categories.length, 'a looser category makes fewer categories', loose.categories.length)
  const one = Cluster.group(docs((n, i) => i, true), { meaning: { labelTerms: 1 } })
  ok(one.categories.every((c) => c.keywords.length === 1), 'one word names')
  const flat = Cluster.group(docs((n, i) => i, true), { meaning: { subgroup: 0.3 } })
  ok(flat.categories.every((c) => !c.subgroups.length), 'a subgroup setting below the category one means no subgroups')
  ok(shape(Cluster.group(docs((n, i) => i, true), { words: { category: 0.5 } })) === shape(base), 'word settings do not change grouping by meaning')
  const p = Cluster.settings('meaning', { category: -1, labelTerms: 'x', subgroup: 0.2 })
  ok(p.category === Cluster.DEFAULTS.meaning.category && p.labelTerms === 3, 'a bad setting falls back to its default')
  ok(p.subgroup === p.category, 'a subgroup is never looser than its category')
}

// A faint resemblance: two tabs share 1 of 28 words. By default sharing a
// window is not enough to group them; only a much stronger window setting is.
function faint(sameWindow, share) {
  const uniq = (q, n) => Array.from({ length: n }, (_, i) => [q + i, 1, 0])
  const d = [
    { id: 1, windowId: 1, index: 0, title: 'P', text: '', url: 'a:1', terms: [['shared', 1, 0], ...uniq('p', 27)] },
    { id: 2, windowId: sameWindow ? 1 : 2, index: 1, title: 'Q', text: '', url: 'a:2', terms: [['shared', 1, 0], ...uniq('q', 27)] },
  ]
  for (let i = 0; i < 4; i++) d.push({ id: 10 + i, windowId: 3 + (i % 2), index: i, title: 'F' + i, text: '', url: 'f:' + i, terms: uniq('f' + i + '_', 28) })
  return Cluster.group(d, share == null ? undefined : { words: { window: share } }).categories.length
}
ok(faint(false) === 0, 'a faint resemblance alone does not group two tabs')
ok(faint(true) === 0, 'by default, sharing a window does not group a faint resemblance')
ok(faint(true, 0.3) === 1, 'the strongest window setting does')
ok(faint(false, 0.3) === 0, 'but only for tabs in one window')

// nothing in common: one window never puts them together
const strangers = [
  { id: 1, windowId: 1, index: 0, title: 'A', text: '', url: 'a:1', terms: [['apple', 5, 0], ['orchard', 3, 0]] },
  { id: 2, windowId: 1, index: 1, title: 'B', text: '', url: 'a:2', terms: [['tensor', 5, 0], ['gradient', 3, 0]] },
  { id: 3, windowId: 2, index: 0, title: 'C', text: '', url: 'a:3', terms: [['violin', 5, 0]] },
]
ok(Cluster.group(strangers, { words: { window: 0.3 } }).categories.length === 0, 'tabs with nothing in common stay apart in one window')

// the same page open twice
{
  const d = docs((n, i) => i, false)
  d.push({ ...d[0], id: 99, url: d[0].url + '#History' })
  const r = Cluster.group(d)
  ok(r.duplicates.get(99) && r.duplicates.get(99)[0] === 0 && r.duplicates.get(0)[0] === 99, 'the same page in two tabs is a duplicate', JSON.stringify([...r.duplicates]))
  ok(r.duplicates.size === 2, 'and no other tab is')
  const named = (x) => x.categories.find((c) => c.tabs.some((t) => t.id === 0)).label
  ok(named(r) === named(Cluster.group(docs((n, i) => i, false))), 'a page open twice does not change names', named(r))
}

// Live: every other tab, most like one tab first
for (const meaning of [false, true]) {
  const d = docs((n, i) => i, meaning)
  const rust = d.find((x) => x.name === 'X: Rust release')
  const r = Cluster.rank(d, rust.id)
  const how = meaning ? 'meaning' : 'words'
  ok(r.mode === how && r.ranked.length === d.length - 1, how + ': every other tab is ranked')
  const top = r.ranked.slice(0, 4).map((x) => x.doc.name)
  ok(top.every((n) => TOPIC[n] === 'code'), how + ': the tabs most like the Rust post are about code', top.join(', '))
  ok(r.ranked.every((x, i) => !i || r.ranked[i - 1].sim >= x.sim), how + ': most alike first')
  ok(r.related === Cluster.DEFAULTS[how].category, how + ': the related line is the category threshold')
}
{
  const d = docs((n, i) => i, false)
  d.push({ ...d[0], id: 99, url: d[0].url + '#History' })
  const r = Cluster.rank(d, 0)
  ok(r.ranked[0].doc.id === 99 && r.ranked[0].same, 'the same page ranks first and is marked as the same page')
  ok(Cluster.rank(d, 12345) === null, 'a tab that is not there has no ranking')
}

ok(Cluster.group([]).categories.length === 0, 'no tabs')
const lone = Cluster.group([{ id: 1, windowId: 1, index: 0, title: 'New Tab', text: '', url: '', terms: Cluster.terms('New Tab', '') }])
ok(lone.categories.length === 0 && lone.rest.length === 1, 'a single tab is left on its own')

const t = new Map(Cluster.terms('Machine learning', 'Machine learning models. Machine learning in 1980s. The AI boom, UK and EU.').map((e) => [e[0], e]))
ok(t.has('machine learning'), 'two word phrases are terms')
ok(t.get('machine')[1] === 2 && t.get('machine')[2] === 1, 'text and title counts are kept apart', JSON.stringify(t.get('machine')))
ok(t.has('ai') && t.has('uk') && t.has('eu'), 'two letter acronyms are kept')
ok(!t.has('1980') && !t.has('1980s') && !t.has('the') && !t.has('in'), 'numbers and stop words are dropped')
ok(t.has('model') && !t.has('models'), 'plurals fold into the singular')
ok(!new Map(Cluster.terms('', '230 Reposts 2,104 Likes Replying to @x Trending')).size, 'social media buttons are not words')

console.log('---')
console.log(checks - fails + '/' + checks + ' checks passed')
process.exit(fails ? 1 : 0)
