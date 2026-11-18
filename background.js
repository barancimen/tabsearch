'use strict'

importScripts('db.js')

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => {})
  // Only a fresh install starts empty. Reloading or updating the extension
  // keeps the browser session, so tab ids still hold, and the saved text, word
  // counts and vectors stay. The panel checks each record against its tab's
  // address before using it.
  if (reason === 'install') dbClear()
})

// Tab ids do not survive a restart, and page text should not outlive the session.
chrome.runtime.onStartup.addListener(() => {
  dbClear()
})

// Runs while the panel is closed too, so the saved index never hides a page change.
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.url || info.status === 'loading') dbDel(id)
})

chrome.tabs.onRemoved.addListener((id) => {
  dbDel(id)
})

// Chrome gives a tab a new id when it suspends it.
chrome.tabs.onReplaced.addListener((added, removed) => {
  dbMove(removed, added)
})
