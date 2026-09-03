# Publishing a spoint game (itch.io / GitHub Pages)

This is the recipe for shipping a `create-spoint-game` project to a static host with no backend
server -- itch.io's HTML5 upload, a GitHub Pages project site, or any plain CDN/file host. It relies
entirely on spoint's **singleplayer / BrowserServer mode**: the same server code that normally runs
under Node runs instead inside a Web Worker in the visitor's own browser, so there is nothing to
host except static files. Multiple visitors each get their own independent world instance -- this is
not multiplayer hosting, it's "run the whole game client-side," matching how the project's own
`?singleplayer` URL mode already works during local development (see the main `README.md`).

## 1. Build the static export

From your project directory (where `node_modules/spoint` is installed):

```bash
npx spoint-static-export dist-static
```

(equivalent explicit form: `node node_modules/spoint/scripts/static-export.mjs dist-static` -- both
resolve to the same script, `spoint-static-export` is just the package's declared `bin` alias for it.)

Or, if developing spoint itself (this repo, not a scaffolded project):

```bash
npm run static-export -- dist-static
# or directly: node scripts/static-export.mjs dist-static
```

This assembles everything a static host needs into `dist-static/`:

- `app.js` -- the minified client bundle (esbuild, `scripts/bundle-client.mjs`)
- `src/sdk/WorkerEntry.js` -- the bundled server-side module graph that runs inside the Worker
  (`scripts/bundle-worker.mjs`, same mechanism `client/BrowserServer.js` already expects at that path)
- `index.html`, `style.css`, `manifest.json`, `service-worker.js`, `favicon.svg`,
  `singleplayer-world.json` -- the app shell
- `node_modules/` -- only the packages the client importmap actually references (three, jolt-physics,
  mapspinner, streaming-gltf, etc.)
- `apps/` -- your project's own game code (`apps/_lib/` engine helpers are merged in automatically)

The script fails loudly (non-zero exit) if the WorkerEntry bundle comes out suspiciously small
(<50KB) -- a sign the SDK graph didn't actually inline, which would silently break in a visitor's
browser. Don't ignore that failure; it means something changed in the import graph and the export
tool needs an update (compare against `.github/workflows/gh-pages.yml`'s own bundle step, which uses
the identical mechanism for spoint's own demo deploy).

## 2. Base-path handling

Leave `dist-static/` as-is (no `--base` flag) for:
- itch.io HTML5 uploads (served at the zip's own root)
- a custom domain / root-level GitHub Pages user site (`username.github.io`)

Pass `--base=/your-repo-name` for a **GitHub Pages project site**
(`username.github.io/your-repo-name/`), which serves your files under a subpath:

```bash
npx spoint-static-export dist-static --base=/your-repo-name
```

This rewrites every absolute `/node_modules/...`, `/src/...`, `/apps/...`, `/vendor/...` reference
in the exported JS/HTML to be prefixed with the base path -- without it, every asset request 404s
under a subpath host (this is the same class of bug `.github/workflows/gh-pages.yml`'s own
"Patch paths for gh-pages" step exists to fix for spoint's own demo).

## 3. Publish

### itch.io

1. Zip the **contents** of `dist-static/` (not the folder itself -- `index.html` must be at the zip root).
2. On your itch.io project page: Uploads -> add the zip -> check **"This file will be played in the
   browser"**.
3. Under Embed options, set a fixed viewport size (or "Fullscreen button", recommended for a 3D game)
   and enable **SharedArrayBuffer support** if your itch.io project has that toggle available --
   spoint's physics/audio worker paths benefit from it but degrade gracefully without it.
4. itch.io serves your zip at its own root, so no `--base` flag is needed for step 1.

### GitHub Pages

**Project site** (`username.github.io/repo-name/`) -- most common case:

```bash
npx spoint-static-export dist-static --base=/repo-name
```

Then push `dist-static/`'s contents to a `gh-pages` branch (or configure Pages to serve from a
`docs/` folder / GitHub Actions deploy, whichever this repo already uses). See
`.github/workflows/gh-pages.yml` in the spoint repo itself for a complete, working CI example of
this exact pattern (it deploys spoint's own demo the same way, just with its own hardcoded map
assets instead of your project's `apps/`) -- copy its structure into your own project's workflow if
you want the export to run automatically on every push.

**User/org root site** (`username.github.io`, this repo IS the pages source) -- no `--base` needed,
same as itch.io.

## 4. Verify before publishing

Serve `dist-static/` locally with any static file server (no spoint/Node backend needed -- that's
the whole point) and open it in a browser:

```bash
npx serve dist-static
# or: python -m http.server --directory dist-static 8080
```

Visit the printed URL with no query string -- `index.html`'s own inline script auto-redirects to
`?singleplayer&world=<your default world>`. Confirm:
- the page loads with zero console errors
- the game boots and is playable (this proves BrowserServer's in-Worker server + the bundled
  WorkerEntry graph both work with no real backend)
- DevTools -> Application -> Service Workers shows `service-worker.js` registered (the offline app
  shell -- see `client/service-worker.js`'s own header comment for exactly what it does and does not
  cache; it deliberately does NOT cache `app.js` itself, so a redeploy is never masked by a stale
  worker)

## Limits of this mode

- **No real multiplayer.** Each visitor's BrowserServer instance is theirs alone. For actual
  multiplayer you need a real Node host (`npm start` / `server.js`) or a P2P room via wireweave
  (`?wwjoin=...` / `?room=...`) -- static hosting covers neither of those transports, only the
  in-Worker singleplayer path.
- **Asset size.** Everything under `apps/` (including any `.glb`/`.vrm` models) ships as static
  files in the export -- there is no server-side asset optimization pipeline running at request
  time (the live dev server's on-demand GLB transform/quantize pipeline only runs under Node). Run
  your own model optimization before export if your assets are large.
- **No editor/hot-reload.** The in-browser editor and `ReloadManager` hot-reload path are dev-time
  tools; a static export is a frozen build, matching how `npm run build:client`'s bundle already
  behaves in production mode (see the main `README.md`'s Production Build section).
