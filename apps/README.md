# apps/ convention

Every game, feature, and editor panel in spoint is an **app** living under `apps/<name>/`
(folder form, `index.js` entry) or `apps/<name>.js` (flat-file form for a small app). Apps are
the ONLY unit of game-specific code -- the engine (`src/`, `client/` core, `server.js`) has no
per-game special-casing anywhere; `src/apps/AppRuntime.js`'s `registerApp`/`_attachApp` dispatch
is fully generic, and `src/apps/AppLoader.js` discovers/hot-reloads every app the same way
regardless of what it does.

## Shape

An app module's default export is:

```js
export default {
  server: {
    setup(ctx) { /* runs once per server-side entity spawn of this app */ },
    // other optional server-side lifecycle hooks the app opts into
  },
  client: {
    setup(ctx) { /* runs once per client-side entity of this app; ctx.editor is only
                    present for a TRUSTED app in the current world's trustedApps allowlist */ },
  }
}
```

Both `server` and `client` (and every hook inside them) are **optional** -- `AppRuntime._attachApp`
only calls a hook if the app actually defines it. `apps/tps-game/index.js` is the fullest reference
example (a real multiplayer game-mode app); `apps/box-static/`, `apps/prop-dynamic/` etc are minimal
single-purpose apps worth reading for the smallest possible shape.

## Discovery

`AppLoader` (`src/apps/AppLoader.js`) resolves an app name against every configured `appsDirs` entry
(project-local `apps/` first, falling back to the SDK's own bundled `apps/` -- see
`buildUniquePathList`/`appsDirs` in `src/sdk/server.js`'s `boot()`), trying both the flat-file form
(`<dir>/<name>.js`) and the folder form (`<dir>/<name>/index.js`). A project can therefore override
or add to the SDK's bundled apps by placing its own `apps/<name>/` locally -- same name shadows the
SDK's bundled one; a new name adds a new app. Multiple unrelated games can coexist as long as each
uses a distinct app name and its own `apps/world/<worldName>.js` world-def (see "Multiple games" below).

## Creating a new app

```
npx spoint create-app --template <simple|physics|interactive|spawner|fsm-game> <name>
```

writes a starter `apps/<name>/index.js` from one of the bundled templates (`bin/templates.js`).
Add the app to a world-def's `entities` list with `{ id, app: '<name>', config: {...} }` to spawn it.

## Multiple games in one project

Each game is its own `apps/world/<worldName>.js` world-def (default export = `{ entities, ... }`),
selected at boot via the `WORLD` env var (`WORLD=<worldName> node server.js` / `npx spoint`,
default `tps-game` -- see `src/sdk/server.js` `boot()`). A world-def's `entities` list references
apps by name; unrelated games simply reference different app sets. Apps do not share module-level
state with each other (each is its own ES module instance per `AppLoader`), so two games' apps
coexisting in the same `apps/` tree is safe as long as neither app writes to a `window.__*` global
whose name collides with another app's own global (a spoint-wide convention, not enforced
automatically -- prefix a genuinely app-specific global with the app's name if it must exist at all).

## Hot reload

Editing an app file under a watched `apps/` dir triggers a live re-`import()` (blob-URL rewrite on
the client, real re-import on the server) with NO page reload -- `AppLoader.watchAll()` ->
`queueReload` -> `MSG.APP_MODULE` broadcast -> `AppModuleSystem.loadAppModule` on each client. Editing
core engine files (`src/`, `client/` outside `apps/`) instead triggers a full `MSG.HOT_RELOAD` ->
`location.reload()`, since a core-file edit changes shapes the running app instances already closed
over. Both paths are engine-owned; an app never needs to implement any reload logic itself.

## npx / external-dependency usage

When spoint is consumed as an npm dependency (`npx spoint`, or a project's own `package.json`
depending on `spoint`), the engine (`src/`, `client/` core, `server.js`) stays inside
`node_modules/spoint` -- only `apps/`, a world-def, and the project's own `package.json` live in the
project directory. `server.js`'s `boot()` already separates `SDK_ROOT` (the engine's own install
location, via `import.meta.url`) from `PROJECT` (`process.cwd()`), reading apps/world-def from
`PROJECT` and falling back to the SDK's bundled ones -- so a project's `apps/` folder is exactly the
"multi-game folder structure" described above, whether the engine lives in the same repo (this repo)
or as an external dependency (a project scaffolded by `npx spoint`/`create-spoint-game`). Upgrading
the engine is a `package.json` dependency version bump + reinstall; no engine file is ever copied
into a project's own tree by that path (the project itself is never mutated to hold engine code).
