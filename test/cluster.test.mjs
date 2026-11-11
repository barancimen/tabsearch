// Unit test for cluster.js on real article text. Runs in plain Node in about a
// second:   node test/cluster.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ctx = {}
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(here, '..', 'cluster.js'), 'utf8') + '\nthis.Cluster = Cluster', ctx)
const Cluster = ctx.Cluster
const { articles } = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'articles.json'), 'utf8'))

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
  Mortgage: 'alone',
}
const names = Object.keys(articles)

function docs(windowOf) {
  return names.map((t, i) => {
    const title = t + ' - Wikipedia'
    const text = title + '\nMain menu Navigation Search Donate Create account Log in\n' + articles[t]
    return { id: i, windowId: windowOf(t, i), index: i, title, text, terms: Cluster.terms(title, text, 'en.wikipedia.org') }
  })
}

// "food: Lasagna, Pasta | ..." with the groups and their tabs in a stable order
function shape(r) {
  const gs = r.groups.map((g) => {
    const ts = g.tabs.map((d) => d.title.replace(' - Wikipedia', '')).sort()
    return TOPIC[ts[0]] + ': ' + ts.join(', ')
  })
  return gs.sort().join(' | ') + ' || ' + r.rest.map((d) => d.title.replace(' - Wikipedia', '')).sort().join(', ')
}

const want =
  'code: JavaScript, Python (programming language), Rust (programming language) | ' +
  'food: Lasagna, Pasta, Pizza, Risotto | ' +
  'space: Andromeda Galaxy, Black hole, Jupiter || Mortgage, Taj Mahal'

const t0 = Date.now()
const apart = Cluster.group(docs((t, i) => i))
ok(shape(apart) === want, 'groups follow the subject, each tab in its own window', shape(apart))
console.log('grouped ' + names.length + ' articles in ' + (Date.now() - t0) + ' ms')

const one = Cluster.group(docs(() => 1))
ok(shape(one) === want, 'all tabs in one window', shape(one))

// windows that cut across the subjects: the text wins
const mixed = { Pasta: 1, 'Python (programming language)': 1, Jupiter: 1, Lasagna: 2, JavaScript: 2, 'Black hole': 2 }
const across = Cluster.group(docs((t) => mixed[t] || 3))
ok(shape(across) === want, 'windows that mix subjects do not change the groups', shape(across))

for (const g of apart.groups) {
  ok(g.keywords.length >= 1 && g.keywords.length <= 3, 'one to three words per label', g.label)
  ok(g.keywords.every((w) => /^\p{Lu}|^\p{Ll}+\p{Lu}/u.test(w)), 'label words are capitalised', g.label)
  const lower = g.keywords.map((w) => w.toLowerCase())
  ok(new Set(lower).size === lower.length, 'no repeated words in a label', g.label)
}
const label = (topic) => apart.groups.find((g) => TOPIC[g.tabs[0].title.replace(' - Wikipedia', '')] === topic).label
console.log('labels: ' + ['food', 'code', 'space'].map(label).join(' / '))
ok(/programming|code|compiler|language/i.test(label('code')), 'code group is named for code', label('code'))

// A faint resemblance: two tabs share 1 of 28 terms. Apart they stay apart, in
// one window they are put together.
function faint(sameWindow) {
  const uniq = (p, n) => Array.from({ length: n }, (_, i) => [p + i, 1])
  const d = [
    { id: 1, windowId: 1, index: 0, title: 'P', text: '', terms: [['shared', 1], ...uniq('p', 27)] },
    { id: 2, windowId: sameWindow ? 1 : 2, index: 1, title: 'Q', text: '', terms: [['shared', 1], ...uniq('q', 27)] },
  ]
  for (let i = 0; i < 4; i++) d.push({ id: 10 + i, windowId: 3 + (i % 2), index: i, title: 'F' + i, text: '', terms: uniq('f' + i + '_', 28) })
  return Cluster.group(d).groups.length
}
ok(faint(false) === 0, 'a faint resemblance alone does not group two tabs')
ok(faint(true) === 1, 'the same faint resemblance groups two tabs of one window')

// nothing in common: one window never puts them together
const strangers = [
  { id: 1, windowId: 1, index: 0, title: 'A', text: '', terms: [['apple', 5], ['orchard', 3]] },
  { id: 2, windowId: 1, index: 1, title: 'B', text: '', terms: [['tensor', 5], ['gradient', 3]] },
  { id: 3, windowId: 2, index: 0, title: 'C', text: '', terms: [['violin', 5]] },
]
ok(Cluster.group(strangers).groups.length === 0, 'tabs with nothing in common stay apart in one window')

// the settings the panel's sliders change
const groupsWith = (p) => Cluster.group(docs((t, i) => i), p)
ok(shape(groupsWith({})) === want && shape(groupsWith(Cluster.DEFAULTS)) === want, 'default settings give the same groups')
ok(groupsWith({ join: 0.2 }).groups.length < apart.groups.length, 'a stricter join makes fewer groups', shape(groupsWith({ join: 0.2 })))
ok(groupsWith({ join: 0.005 }).rest.length <= apart.rest.length, 'a looser join leaves no more tabs alone')
ok(groupsWith({ labelTerms: 1 }).groups.every((g) => g.keywords.length === 1), 'one word names')
ok(groupsWith({ labelTerms: 5 }).groups.some((g) => g.keywords.length > 3), 'five word names')
for (const p of [{ titleWeight: 1 }, { titleWeight: 10 }, { genericWeight: 0 }, { genericWeight: 1 }, { siteWeight: 0 }, { siteWeight: 3 }, { vectorTerms: 400 }]) {
  ok(shape(groupsWith(p)) === want, 'clear-cut groups survive ' + JSON.stringify(p), shape(groupsWith(p)))
}
ok(groupsWith({ vectorTerms: 40 }).rest.length > apart.rest.length, 'comparing fewer words leaves more tabs alone')
ok(Cluster.settings({ join: -1, labelTerms: 'x', vectorTerms: 2.6 }).join === Cluster.DEFAULTS.join, 'a bad setting falls back to its default')
ok(Cluster.settings({ vectorTerms: 2.6 }).vectorTerms === 3, 'counts are whole numbers')
// windows ignored: the faint pair stays apart even in one window
function faintIn(sameWindow, p) {
  const uniq = (q, n) => Array.from({ length: n }, (_, i) => [q + i, 1])
  const d = [
    { id: 1, windowId: 1, index: 0, title: 'P', text: '', terms: [['shared', 1], ...uniq('p', 27)] },
    { id: 2, windowId: sameWindow ? 1 : 2, index: 1, title: 'Q', text: '', terms: [['shared', 1], ...uniq('q', 27)] },
  ]
  for (let i = 0; i < 4; i++) d.push({ id: 10 + i, windowId: 3 + (i % 2), index: i, title: 'F' + i, text: '', terms: uniq('f' + i + '_', 28) })
  return Cluster.group(d, p).groups.length
}
ok(faintIn(true, { sameWindow: 1 }) === 0, 'with windows at ×1, one window does not group a faint pair')
// a title word counts more as the title weight rises
const tw = (w) => new Map(Cluster.vectors([{ terms: Cluster.terms('Quokka', 'wombat wombat', '') }, { terms: [['zzz', 1]] }], { ...Cluster.DEFAULTS, titleWeight: w })[0])
ok(tw(10).get('quokka') > tw(1).get('quokka'), 'a higher title weight weighs title words more')

ok(Cluster.group([]).groups.length === 0, 'no tabs')
const lone = Cluster.group([{ id: 1, windowId: 1, index: 0, title: 'New Tab', text: '', terms: Cluster.terms('New Tab', '', '') }])
ok(lone.groups.length === 0 && lone.rest.length === 1, 'a single tab is left on its own')

const t = new Map(Cluster.terms('Machine learning', 'Machine learning models. Machine learning in 1980s. The AI boom, UK and EU.', ''))
ok(t.has('machine learning'), 'two word phrases are terms')
ok(t.has('ai') && t.has('uk') && t.has('eu'), 'two letter acronyms are kept')
ok(!t.has('1980') && !t.has('1980s') && !t.has('the') && !t.has('in'), 'numbers and stop words are dropped')
ok(t.has('model') && !t.has('models'), 'plurals fold into the singular')

console.log('---')
console.log(checks - fails + '/' + checks + ' checks passed')
process.exit(fails ? 1 : 0)
