'use strict'

// The tab index, kept in IndexedDB so reopening the panel does not re-read every
// tab. Shared by the panel and the service worker.
let dbOpen

function db() {
  if (!dbOpen) {
    dbOpen = new Promise((resolve, reject) => {
      const r = indexedDB.open('tabsearch', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('tabs', { keyPath: 'tabId' })
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  return dbOpen
}

async function dbTx(mode, fn) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction('tabs', mode)
    const req = fn(tx.objectStore('tabs'))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}

function dbAll() {
  return dbTx('readonly', (s) => s.getAll())
}

function dbPut(rec) {
  return dbTx('readwrite', (s) => s.put(rec)).catch(() => {})
}

function dbDel(id) {
  return dbTx('readwrite', (s) => s.delete(id)).catch(() => {})
}

function dbClear() {
  return dbTx('readwrite', (s) => s.clear()).catch(() => {})
}
