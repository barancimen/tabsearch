# Tab Text Search

Chrome extension (Manifest V3) that searches the rendered text of every open
tab at once, including PDFs. Click a result to switch to the owning tab and
reveal the match.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and pick this folder.
4. Click the toolbar icon. The side panel opens.

## Use

Type in the box. Results are grouped by tab, busiest tab first, with the match
highlighted in a snippet of surrounding text.

| Control | Effect |
| --- | --- |
| `Aa` | Match case |
| `Word` | Whole word only |
| `.*` | Treat the query as a regular expression |
| `Reindex` | Re-read every tab, except suspended tabs that already have saved text |
| `Up` / `Down` | Move through results |
| `Enter` | Open the selected result (or the first one) |
| `N not searchable` | Expand the list of tabs that could not be searched, and why |
| `Load` / `Load all` | Wake one or every "Not loaded" tab in the background so it can be read |

Mode toggles persist across sessions.

### Filter by domain

The second field narrows the search to tabs on one site. It autocompletes from
the domains of your open tabs.

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
are looking at. The filter is not remembered between sessions, so reopening the
panel never silently hides results.

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

Saved text, including non-password field values, is written to disk and cleared
at the next browser start or extension install or update. Incognito tabs are
never saved.

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
| `storage` | Remember the mode toggles |
| `<all_urls>` | Read text from any site and download PDFs and suspended pages. There is no narrower permission that can read tabs you are not looking at |

## Files

    manifest.json      MV3 manifest
    background.js      opens the panel, keeps the saved index in step with tabs
    db.js              IndexedDB store for the saved index
    sidepanel.html     panel markup
    sidepanel.css      panel styles, light and dark
    sidepanel.js       extraction, index, search, rendering, navigation
    vendor/pdfjs/      pdf.js, used to read PDF text
    icons/             toolbar icons
    test/e2e.mjs       end to end test

## Test

Boots a real Chromium with the extension loaded, serves pages and PDFs with
known text on four loopback hostnames (`127.0.0.1`, `localhost`,
`foo.localhost`, `[::1]`), suspends some of the tabs, drives the side panel, and
asserts on the rendered results.

    npm install
    npx playwright install chromium
    npm test
