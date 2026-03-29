/** Verbose logs when URL has ?debug (e.g. index.html?debug) */
let debugEnabled = false;

export function initDebugFromUrl() {
  try {
    debugEnabled = new URLSearchParams(window.location.search).has("debug");
  } catch {
    debugEnabled = false;
  }
}

export function isDebug() {
  return debugEnabled;
}

export function debugLog(...args) {
  if (debugEnabled) console.log(...args);
}
