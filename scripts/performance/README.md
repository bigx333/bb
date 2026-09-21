# Bounded source-app performance measurements

These scripts seed and measure an isolated source web app. They do not run tests, change product code, start provider turns, or read a production store. Use the optimized `pnpm start:worktree` launcher documented in `docs/debugging-and-qa.md`.

Create the artifact directory with `mktemp -d "$PWD/.perf-benchmark-XXXXXX"`. Its `data` directory must contain a `verify-bb-owner` file naming the absolute artifact directory, and the source app must already have initialized that fresh store. Point only the isolated worktree instance at this data. Do not adopt an existing database.

```sh
node --conditions=source --import tsx scripts/performance/seed-e2e.mjs "$RUN"
node scripts/performance/measure-api.mjs "$RUN" http://127.0.0.1:PORT baseline
node scripts/performance/measure-e2e.mjs "$RUN" http://127.0.0.1:PORT 1440 long baseline
```

The deterministic content includes a three-turn small thread and a 40-turn long thread with 260 command/message pairs in its final turn. IDs are generated and saved in `fixture.json`. The fixture explicitly selects the supported flat completed-turn display to exercise more than 200 top-level response rows. Both threads are idle. No provider execution is implied.

Use the installed `dev-browser` CLI with Chrome for Testing. The fixture assigns one task-specific persistent browser name. Set `DEV_BROWSER_CHROME` to a Chrome for Testing executable before first launch if needed. Reuse that instance; stop it only when after measurements no longer need it.

Supported browser scenarios: `cold-home`, `hard-reload`, `small`, `long`, `settings`, `home`, `switch`, `small-direct`, `long-direct`, `profile`, `windowing`. Run them sequentially. `windowing` performs three interleaved off/on pairs through the isolated settings API and leaves the experiment on; restore the prior setting before other comparisons. `profile` is one diagnostic sample, not an uninstrumented timing comparison. Mobile-width sidebar interactions can require adaptation to the rendered drawer; report automation failures instead of treating them as measured product regressions.

`cold-home` clears browser HTTP cache; it does not clear the server, OS page cache, or persisted preferences. `hard-reload` reloads the document with warm HTTP cache. Client-navigation scenarios prepare their starting page before timing the click. The API script records the full decoded response SHA256 with no field exclusions. Keep identical fixtures, settings, viewport, and cache state across revisions.

Readiness is the visible composer or final fixture marker plus two animation frames; capture continues for 500ms afterward. JSON records request timing/bytes, long tasks, browser version, DOM/row counts, errors, and sample arrays. Screenshots use 2× density. Readiness and screenshots do not prove absence of transient layout shifts. Record host CPU/memory/swap contention separately and qualify timing claims. Keep raw artifacts outside Git; only the reusable scripts belong in commits.
