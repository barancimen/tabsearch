# Tab Text Search

Chrome extension (Manifest V3) that searches the rendered text of every open
tab at once. Click a result to switch to the owning tab and reveal the match.

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
| `Reindex` | Re-read every tab from scratch |
| `Up` / `Down` | Move through results |
| `Enter` | Open the selected result (or the first one) |

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

The first pass runs when you open the panel. After that the index is kept warm:
a tab is re-read when it finishes navigating, dropped when it closes, and added
when a new one loads.

## Limits

- Pages Chrome forbids extensions from reading are skipped and counted in the
  status line: `chrome://`, `about:`, `devtools://`, `view-source:`, other
  extensions' pages, the Chrome Web Store, and `data:`/`blob:` URLs.
- The built-in PDF viewer, `file://` URLs, and text drawn into a canvas or
  video are not searchable. For `file://` you must also enable **Allow access
  to file URLs** on the extension's details page.
- Text inside shadow roots that a page does not reflect into the light DOM is
  invisible to the extractor.
- Text is read from the DOM, not from what is painted, so text hidden with CSS
  is still searchable.
- Each tab contributes at most 200,000 characters, 5 snippets per tab are
  shown, and at most 400 tabs are listed.

Result snippets come from a copy of the page text that has had its whitespace
collapsed, so revealing a match in the page uses Chrome's own find on the
longest word inside the match rather than an exact offset.

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | Read the title, URL and window of each tab |
| `scripting` | Inject the extractor and the reveal helper |
| `sidePanel` | Show the search UI next to the page |
| `storage` | Remember the mode toggles |
| `<all_urls>` | Read text from any site. There is no narrower permission that can read tabs you are not looking at |

## Files

    manifest.json      MV3 manifest
    background.js      opens the panel when the toolbar icon is clicked
    sidepanel.html     panel markup
    sidepanel.css      panel styles, light and dark
    sidepanel.js       extraction, index, search, rendering, navigation
    icons/             toolbar icons
    test/e2e.mjs       end to end test

## Test

Boots a real Chromium with the extension loaded, serves four pages with known
text on four loopback hostnames (`127.0.0.1`, `localhost`, `foo.localhost`,
`[::1]`), drives the side panel, and asserts on the rendered results.

    npm install
    npx playwright install chromium
    npm test
