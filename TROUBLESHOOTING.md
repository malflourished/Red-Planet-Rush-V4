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

Your folder should look like this:
```
Red-Planet-Rush-V4/
  ├── index.html
  ├── main.js
  └── style.css
```

All three files must be in the same folder!

## Step 5: Test Basic Functionality

1. **Open the page** - You should see a dark map with white circles
2. **Check console** - Should see initialization messages
3. **Click WAIT button** - Day should increase by 1
4. **Click SCAN button** - Credits should decrease by 5
5. **Hover over map** - Cursor should change over nodes

If buttons work but map doesn't, the canvas might not be rendering.

## Still Not Working?

Copy any red error messages from the console and share them!

