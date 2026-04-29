# Troubleshooting Guide

## Step 1: Open Browser Console

**Chrome/Edge:**
- Press `F12` OR `Cmd + Option + I` (Mac) OR `Ctrl + Shift + I` (Windows)
- Click the "Console" tab at the top

**Safari:**
- First enable Developer menu: Safari → Settings → Advanced → Check "Show Develop menu"
- Then: Develop → Show JavaScript Console

**Firefox:**
- Press `F12` OR `Cmd + Option + K` (Mac) OR `Ctrl + Shift + K` (Windows)

## Step 2: Check for Errors

Look for messages in the console:

### ✅ GOOD Signs:
- "DOM loaded, initializing game..." or "DOM already loaded, initializing game..."
- "Element check: {canvas: true, actionTravel: true, ...}"

### ❌ BAD Signs (Red Errors):
- **"Failed to load resource"** → The JavaScript file isn't loading
- **"Cannot read property of null"** → An HTML element is missing
- **"Uncaught ReferenceError"** → JavaScript syntax error

## Step 3: Common Issues & Fixes

### Issue: "Failed to load resource: main.js"
**Fix:** 
- Make sure `main.js` is in the same folder as `index.html`
- Check the file path in HTML: `<script src="main.js" defer></script>`
- Try refreshing the page (Cmd+R or F5)

### Issue: "Element check: {canvas: false, ...}"
**Fix:**
- The HTML elements aren't being found
- Make sure you're opening `index.html` (not just viewing the folder)
- Check that all IDs match between HTML and JavaScript

### Issue: Console shows nothing / blank
**Fix:**
- Make sure you're on the Console tab (not Elements/Network/etc.)
- Try refreshing the page
- Check if JavaScript is disabled in browser settings

### Issue: Page loads but nothing happens when clicking
**Fix:**
- Check console for errors first
- Make sure you see the debug messages in console
- Try clicking buttons - do you see any console errors?

## Step 4: Verify File Structure

Your folder should look roughly like this (the cleanup-phase modules are
linked in by `main.js` via `import` statements):

```
Red-Planet-Rush-V4/
  ├── index.html
  ├── main.js
  ├── style.css
  ├── assets/
  │   ├── scenes/
  │   │   ├── planets/             earth.png, moon.png, mars-01.png
  │   │   ├── outposts/<setId>/    arrival.png, interior.png
  │   │   ├── stations/            <scene>-<instanceId>.jpg
  │   │   ├── asteroids/arrival/   asteroid_arrival_NN.png
  │   │   └── asteroids/surface/   asteroid_surface_NN.png
  │   └── items/supplies/          air-canister_*.png, life-support_*, ...
  └── js/
      ├── debug.js
      ├── hull.js
      ├── time.js                  advanceDays + per-day hooks
      ├── scheduler.js             rAF dirty-render + zoom constants
      ├── travelViewMode.js
      ├── dispatchAction.js
      ├── state/initialState.js    documented gameState shape
      ├── map/route.js             Moon→Mars route + ring helpers
      ├── map/orbital.js           pure orbital math
      └── assets/manifest.js       canonical asset paths
```

Because `main.js` uses ES modules (`<script type="module" src="main.js">`),
the page **must be opened over HTTP**, not via `file://`. From the repo
root, run a local server:

```
python3 -m http.server 8080
```

Then visit `http://localhost:8080/index.html`.

## Step 4b: Missing Images

If scenes load but show black backgrounds, the asset tree under `assets/`
is incomplete. The console will log lines like:

```
[renderScene] Scene image missing: assets/scenes/asteroids/arrival/asteroid_arrival_07.png
```

Check `js/assets/manifest.js` for the canonical path layout the game
expects. The `midjourney_session/` segment in asteroid surface paths is a
known carry-over from content generation; it's controlled by
`ASTEROID_SURFACE_DIR` in the manifest and should be flipped to
`assets/scenes/asteroids/surface` once content is migrated.

## Step 5: Test Basic Functionality

1. **Open the page** - You should see a dark map with white circles
2. **Check console** - Should see initialization messages
3. **Click WAIT button** - Day should increase by 1
4. **Click SCAN button** - Credits should decrease by 5
5. **Hover over map** - Cursor should change over nodes

If buttons work but map doesn't, the canvas might not be rendering.

## Still Not Working?

Copy any red error messages from the console and share them!

