# Tab Text Search

Chrome extension (Manifest V3) that searches the rendered text of every open
tab at once, including PDFs. Click a result to switch to the owning tab and
reveal the match. Two more tabs list the open tabs by window and group them by
subject.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and pick this folder.
4. Click the toolbar icon. The side panel opens.

## Use

The panel has four tabs along the top: Search, Windows, Subjects and Active.
Under them is the domain filter, which all four share, and in Search the search
box below it. Opening the panel puts the cursor in the search box, or the focus
on the list in the other tabs, so you can type or press Page Down at once.
Page Down and Page Up scroll the list even while the cursor is in a box.

Type in the search box. Results are grouped by tab, busiest tab first, with
the match highlighted in a snippet of surrounding text.

| Control | Effect |
| --- | --- |
| `Aa` | Match case |
| `Word` | Whole word only |
| `.*` | Treat the query as a regular expression |
| `↻` (Reindex) | Re-read every tab, except suspended tabs that already have saved text |
| `⊘` | Open the list of excluded domains (see below) |
| `Up` / `Down` | Move through results |
| `Enter` | Open the selected result (or the first one) |
| `N not searchable` | Expand the list of tabs that could not be searched, and why |
| `Load` / `Load all` | Wake one or every "Not loaded" tab in the background so it can be read |

Mode toggles persist across sessions.

### Filter by domain

The domain field narrows the search to tabs on one site. As you type, a list as
wide as the field offers the domains of your open tabs with how many tabs each
has. Pick one with the mouse, or with the arrow keys and Enter. Escape closes
the list and keeps what you typed.

| You type | Matches |
| --- | --- |
| `x.com` | `x.com`, `www.x.com`, `mobile.x.com` |
| `foo.x.com` | `foo.x.com` only |
| `*.x.com` | `x.com` and its subdomains, the `*.` is dropped |
| `www.x.com` | same as `x.com`, the `www.` is dropped |
| `https://x.com/home` | same as `x.com`, scheme and path are dropped |
| `x.com:8443` | only tabs served on that port |

A bare domain matches on the hostname, so typing `x.com` covers tabs whose URLs
carry a port. The filter is matched against the tab's own URL, so text a page
pulls in from an embedded frame on another origin is attributed to the tab you
are looking at. The filter is kept with the rest of the panel's state (see
below), and the count says `on x.com` while it applies.

### Excluded domains

The `⊘` button next to Reindex opens a list of domains whose tabs the extension
never reads. Type a domain and press Enter or Exclude, and press Remove to take
one off. Domains are written the way the domain filter takes them, so `x.com`
also covers its subdomains, and `https://www.x.com/home` is saved as `x.com`.

Tabs on an excluded domain are not read, downloaded or embedded, and any saved
text, word counts and vectors they had are deleted at once. They are left out
of Search, are listed under `N not searchable` as "Excluded", and are listed
apart in Subjects ("Unlike the others") and Active ("Not compared"). Windows
still lists them. Removing a domain reads its tabs straight away.

There is one list, shared by the panels of every window, which update together
when it changes. It is kept in `chrome.storage.local`, which survives browser
restarts and reloading or updating the extension. Removing the extension from
Chrome deletes it, along with the rest of the extension's data.

### Panel state

Closing and reopening the panel, in the same window or another one, brings back
the query, the domain filter, the mode toggles, the open or closed "not
searchable" list, the selected result and the scroll position. Panels open in
several windows at once follow each other's query, filter, toggles and list. The
state is kept in `chrome.storage.local`, so it also survives a browser restart.

## Windows, Subjects and Active

The Active tab, bright green with white text while chosen, lists every other tab by how alike it
is to the tab you are looking at in the panel's window, most alike first, with
a score from 0 to 1. It follows you as you switch tabs. Tabs are compared by
meaning once the model is set up (see below) and by the words they share until
then. A "Less alike" line marks where tabs stop being alike enough to share a
category with it, using the Subjects category setting. The same page open in
another tab comes first, marked "Duplicate". Tabs the model has not read yet are
listed under "Still being read", the tab you are looking at is read first, and
browser pages with no text are listed under "Not compared".

The Windows tab lists every open tab window by window. Each window is a
foldable section named W1, W2, ... in the order Chrome numbers them, with its
tabs in tab strip order, and the panel's own window marked "(this window)".
This needs no grouping, so it shows at once, and the model is not loaded for
it. Duplicates are tabs with the same address.

The Subjects tab lists every open tab grouped by subject, across all
windows. Large categories are split into subgroups when they fall into two or
more of them, and tabs in no subgroup are listed under "Other". Tabs that
resemble no other tab are listed last under "Unlike the others", along with
blank tabs and browser pages that have no text. With more than one window open,
each tab shows which window it is in (`W1`, `W2`, ...). A page open in two tabs
is marked "Duplicate", and hovering the mark names the other tab. Click a tab
to switch to it. Click a category or subgroup's name or triangle, or press
Enter on it, to fold or unfold it. Folded groups are remembered by name.

The groups are drawn as the work goes on, at most every 0.6 s: from the tabs
read so far, and once the model is ready, from the tabs it has embedded so far.
Tabs still waiting for the model are listed last under "Still being read" and
join the groups as it reads them, two at a time. The line above the groups says
what is being done. While the model loads, which takes a few seconds, the view
waits rather than show groups by words and then switch to meaning. A count of
unread items at the start of a title, as in "(3) Home / X", is ignored, so a
notification doesn't count as a change.

In Subjects, category headings are a darker grey than subgroup headings, and a
2px line separates two categories.

A line above the groups says how they were made: by meaning, with the model
below, or by the words the tabs share, when the model is not set up.

The tab you were on is remembered with the rest of the panel's state.

The domain filter works in both tabs as it does in Search, so `x.com` also
covers its subdomains. In Subjects, the groups are still made from
every tab, and only the tabs on the domain are shown, so filtering doesn't
change the groups or their names. Groups with no tab on the domain are left
out, and the counts are of the tabs shown. In Windows, only windows with a tab
on the domain are shown, under the numbers they have without the filter.

### The meaning model

Tabs are compared by meaning with MongoDB's
[mdbr-leaf-mt](https://huggingface.co/MongoDB/mdbr-leaf-mt), a small embedding
model (23 million parameters) made for grouping and similarity. It runs inside
the extension, in a worker (`embed-worker.js`), with onnxruntime-web and
Hugging Face's tokenizer, both in `vendor/`. No page text leaves the computer.
The model's files are not part of the extension. Under Adjustments you either:

- point it at a folder on this computer that holds `tokenizer.json` and
  `onnx/model_quantized.onnx` with its `model_quantized.onnx_data` file. A
  Hugging Face download folder (`models--MongoDB--mdbr-leaf-mt`) works as it
  is. Chrome only lets the extension read files once "Allow access to file
  URLs" is on in the extension's Details in `chrome://extensions`, and the
  panel says so when it is off.
- or download it. The four files (24 MB) come from MongoDB's Hugging Face
  repository at a fixed commit and are kept in the extension's own storage
  until you remove them. The requests carry nothing about your tabs.

The model is loaded the first time the Subjects tab is shown. Each tab is
read from its title, then the page's own content, cut to the model's limit of
512 tokens. The page's own content is the text of its outermost `<article>`
elements, or else of `<main>`, with the meta description in front, so a post
on X or Reddit is read without the site's menus, sidebars and footer. Pages
without either element are read whole. A tab that could not be read is read
from its title. Each tab's vector is saved in its index record with the model
and title it was made from, so reopening the panel embeds nothing, and a new
tab is embedded on its own. On this test machine, one slow CPU core, eight tabs took a
few seconds; a laptop is much faster.

When any tab has no vector, for example while the model loads or when it is
not set up, every tab is compared by its words instead.

### How tabs are grouped

`cluster.js` does the grouping, in the same way for both kinds of resemblance:

- Two tabs' resemblance is the cosine similarity of their model vectors, or of
  their TF-IDF word vectors. The words come from the title (counted three
  times) and the page's own content, with stop words, social media buttons
  ("Reposts", "Likes"), numbers and years dropped, and everyday English words
  counted at 0.3. Two-word phrases that recur count as terms. The website plays
  no part.
- Tabs in the same window count as up to 5% more alike. The boost shrinks when
  most tabs share a window, and is gone with a single window, because sharing
  one then says little. It only scales a resemblance above zero, so tabs with
  nothing in common are never grouped because they share a window.
- Groups form by average linkage. The two groups whose tabs are most alike on
  average merge, over and over. The groups as they stand when no pair reaches
  the subgroup threshold are the subgroups, and merging continues to the
  category threshold for the categories.
- A category is named by the words that weigh a lot in most of its tabs and
  little in other tabs, and a subgroup by the words that set it apart from the
  rest of its category, without repeating the category's words. A phrase
  ("Black hole") is used instead of one of its words when it scores at least
  half as well. Words are written as the pages write them ("GitHub", "NASA"),
  and a page open twice counts once.
- Two tabs are duplicates when their addresses are the same apart from the
  `#` part, or when they are almost identical (0.97 by meaning, 0.9 by words).

Each tab's word counts are saved in its index record, like its vector, and
redone when its title changes or `Cluster.VERSION` is bumped. The grouping
itself runs over all tabs, at most once per 0.6 s and only while the view is
showing, and the list is redrawn only when the groups change.

### Adjustments

Adjustments, under the domain filter in Subjects, holds the model controls
and four sliders. Each slider regroups the tabs as it moves and has a
description on hover. A moved slider shows a *default* button, and *Set all to
default* resets them all. Meaning and words measure resemblance on different
scales, so each keeps its own settings, and the sliders show the ones in use.
The settings are saved and shared by the panels of every window.

| Slider | By meaning | By words |
|---|---|---|
| How alike tabs in a category must be | 0.45 (0.25–0.8) | 0.02 (0.005–0.2) |
| How alike tabs in a subgroup must be | 0.62 (0.25–0.9) | 0.08 (0.005–0.3) |
| How much sharing a window counts | 5% (0–30%) | 5% (0–30%) |
| Words in each name | 3 (1–5) | 3 (1–5) |

The thresholds were tuned on 12 Wikipedia articles from five subjects and 8
made-up X, Reddit and YouTube pages on the same subjects, each with its site's
real menus, sidebars and footer (`test/fixtures/`). By meaning, every category
threshold from 0.40 to 0.55 puts all 20 pages with their subject and none
elsewhere; below 0.38 everything merges. By words, 0.01 to 0.02 does the same.
Posts on X about different subjects end up apart either way. Text without
spaces between words (Chinese, Japanese) is not split into words, so such
pages group poorly by words.

## What gets indexed

Per tab, and per frame inside that tab:

- the page title and the meta description
- the visible text of the body (whitespace collapsed), with `script`, `style`,
  `noscript` and `template` contents removed
- the value of each `input` and `textarea`, except password fields

### PDFs

PDFs open in Chrome's built-in viewer or in the Google Scholar PDF Reader are
indexed, every page. A tab counts as a PDF by its content type, so the URL does
not need to end in `.pdf`. The extension downloads its own copy with your
cookies and extracts the text with pdf.js, in `vendor/pdfjs`.

### Keeping the index current

The index is saved in IndexedDB, so opening the panel shows saved text at once
and reads only the tabs it does not have. A tab is re-read when it finishes
loading or navigating, dropped when it closes, and added when a new one loads.
This also happens while the panel is closed: the saved text of a tab that
reloads or navigates is thrown away, and the tab is read the next time the panel
opens.

Text that changes without a reload or a URL change, such as new chat messages or
something typed into a field, stays out of date until you press `Reindex`.

Saved text, including non-password field values, is written to disk along with
each tab's word counts and model vector, and cleared at the next browser start
or a fresh install. Reloading or updating the extension keeps it, so nothing is
read or embedded again: tab ids are unchanged within a browser session, and each
saved record is used only while its tab still shows the same address. Incognito
tabs are never saved.

### Suspended tabs

A suspended tab keeps the text it had when it was last awake, and is re-read
when it wakes. A suspended tab that was never read is downloaded from its URL
without waking it. If the download redirects to another site or has under 200
characters of page text, as pages built by JavaScript do, the tab stays
"Not loaded" until you use `Load`.

## Limits

- Pages Chrome forbids extensions from reading are skipped and listed under
  `N not searchable`: `chrome://`, `about:`, `devtools://`, `view-source:`,
  other extensions' pages, the Chrome Web Store, and `data:`/`blob:` URLs. The
  list also holds tabs whose read failed or found no text.
- Text drawn into a canvas or video and text in images are not searchable.
  Scanned PDFs have no text layer and there is no OCR, so they show as
  "No text found".
- A PDF the server will not hand over on a second request, such as one behind a
  one-time link, shows as "PDF could not be read".
- `file://` pages and PDFs need **Allow access to file URLs** turned on in the
  extension's details page.
- Text inside shadow roots that a page does not reflect into the light DOM is
  invisible to the extractor.
- Text is read from the DOM, not from what is painted, so text hidden with CSS
  is still searchable.
- There is no limit on how much text a tab contributes. 5 snippets per tab are
  shown, at most 400 tabs are listed, and counting stops at 5,000 matches per
  tab.

Result snippets come from a copy of the page text that has had its whitespace
collapsed, so revealing a match in the page uses Chrome's own find on the
longest word inside the match rather than an exact offset. Chrome's find does
not work inside PDF viewers, so clicking a PDF result switches to the tab without
scrolling to the match.

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | Read the title, URL and window of each tab |
| `scripting` | Inject the extractor and the reveal helper |
| `sidePanel` | Show the search UI next to the page |
| `storage` | Remember the panel's state between opens and across windows |
| `<all_urls>` | Read text from any site and download PDFs and suspended pages. There is no narrower permission that can read tabs you are not looking at. It also covers downloading the model from Hugging Face |

The manifest allows `'wasm-unsafe-eval'` on the extension's pages, which lets
the model's runtime compile its WebAssembly. It allows nothing else beyond the
default policy.

## Files

    manifest.json      MV3 manifest
    background.js      opens the panel, keeps the saved index in step with tabs
    db.js              IndexedDB store for the saved index
    sidepanel.html     panel markup
    sidepanel.css      panel styles, light and dark
    sidepanel.js       extraction, index, search, rendering, navigation
    cluster.js         groups tabs by subject and picks words to name the groups
    model.js           finds, downloads and loads the meaning model
    embed-worker.js    runs the model away from the panel's page
    categories.js      the Windows, Subjects and Active tabs
    vendor/pdfjs/      pdf.js, used to read PDF text
    vendor/ort/        onnxruntime-web, runs the model
    vendor/tokenizers/ Hugging Face's tokenizer for JavaScript
    icons/             toolbar icons
    test/e2e.mjs       end to end test
    test/cluster.test.mjs   unit test for cluster.js, plain Node
    test/model.e2e.mjs end to end test of grouping by meaning with the real model
    test/exclude.e2e.mjs    end to end test of the excluded domains list
    test/make-vectors.py    makes the model vectors the unit test uses
    test/fixtures/     Wikipedia articles, made-up social media pages, and their vectors

## Test

Boots a real Chromium with the extension loaded, serves pages and PDFs with
known text on four loopback hostnames (`127.0.0.1`, `localhost`,
`foo.localhost`, `[::1]`), suspends some of the tabs, drives the side panel, and
asserts on the rendered results. For Windows and Subjects it opens Wikipedia articles in
two windows that mix subjects, and moves the Adjustments sliders.
`test/exclude.e2e.mjs` checks the excluded domains list on its own, in under a
minute: that excluding a domain from one panel stops every panel searching and
saving its tabs, and that the list survives an extension reload and a browser
restart. `npm run test:exclude` runs it.

`npm run test:unit` runs only the clustering test, in a few seconds. It groups
the 20 fixture pages by words and by meaning, using the vectors in
`test/fixtures/vectors.json`, under three window layouts, and checks what each
setting does.

`test/model.e2e.mjs` needs the model's folder and runs the real model in
Chromium on eight tabs. It downloads the model (with Hugging Face's address
answered from the folder), checks the browser's vectors against the reference
vectors, reloads the extension, removes the download and loads the model from
the folder. Both browser tests turn on Developer mode, as Chromium disables an
unpacked extension that reloads without it. `SHOTS=<folder>` also saves pictures of the panel.

`test/make-vectors.py` remakes the reference vectors after the fixtures or
`embedInput()` change. It needs Python with onnxruntime, tokenizers and numpy.

    npm install
    npx playwright install chromium
    npm test
    node test/model.e2e.mjs /path/to/mdbr-leaf-mt
    python test/make-vectors.py /path/to/mdbr-leaf-mt
