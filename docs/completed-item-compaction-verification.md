# Completed-item compaction verification

Measured on 2026-09-16 in an isolated worktree based on `5aca5733a5`.
PR1 (`c663ff1911`, #3766) is included. These are observations from private
sanitized SQLite copies, not latency or savings guarantees.

## Correctness and storage

| Check | Result |
| --- | --- |
| Physical events | 2,082,639 → 1,080,480 (1,002,159 removed) |
| All table rows | 2,571,187 → 1,569,030 (net 1,002,157 removed) |
| Combined owners | 793,808 |
| Internal metadata | 182,951,145 bytes |
| Allocated SQLite btree bytes | 5,634,584,576 → 4,411,244,544 (1,223,340,032 saved) |
| Database file bytes | 6,006,726,656 before and after; freed pages are reusable |
| Independent logical reconstruction | All 2,082,639 records match across 2,326 threads, except 119,716 eligible empty command-delta text markers |
| Complete visible timelines | All 2,326 match, including all 2,223 non-null context values |
| Highwater and provider recovery | All 2,326 match |
| Existing side tables | All 46 non-event/non-cursor/non-migration tables match, including output, search and attachment ownership |
| Default-budget server pages | All 30 match exactly |
| Complete large-thread pagination | Three largest threads: 3,816 rendered rows match after complete traversal at a 1,000-row budget; baseline used 10,000 |
| Fork inheritance | 24 ordinary plus 10 interleaved real cases; 2,638 copied records match |
| Message edit suffixes | 24 real boundary cases; no future output survives |
| Other consumers | 2,326 latest-output checks, ten large outlines and 100 rollback-only output mutations match |

The two-row difference between physical removals and net removals is existing
migration/cursor bookkeeping. There are no added tables or indexes and no full
VACUUM. The worker performs actual forward discovery and mutation; this is not a
conversion of the prototype's auxiliary-table results.

The first worker pass removes 13 fewer rows than the prototype. A direct cohort
comparison finds 17 additional command owners left ordinary by the bounded
boundary probe (29 rows), offset by 16 additional eligible start rows. All shared
owners have the same reconstructed record counts. User-message/context-clear
crossings remain excluded, as do ambiguous/unsettled/incompatible lifecycles,
unsupported or repeated delta streams, malformed payloads and work exceeding
support/input budgets. No arbitrary mid-item rewind repair was added.

## Timing and catch-up

Measurements ran sequentially, without overlapping heavy benchmarks. The host
was shared; these are warm local observations, not cold-I/O or network bounds.

| Measurement | Result |
| --- | --- |
| Full completed-item worker pass | 120,866 advances; 306.51 seconds |
| Background advance median / p99 / maximum | 1.90 / 15.81 / 212.28 ms |
| Full live cleanup wrapper, 2,500 rotating advances | median 0.257 ms; p99 6.55 ms; maximum 270.07 ms |
| Completed-item subset of live wrapper, 500 advances | median 0.932 ms; p99 8.43 ms; maximum 270.07 ms |
| Median of 30 page case medians, before / after | 94.50 / 111.75 ms |
| Largest individual page call, before / after | 374.21 / 473.56 ms |
| Actual background sweep, 100 calls | 1,989 total advances; 398 completed-item advances |
| Maximum sweep / advance in that sample | 193.34 / 158.88 ms; the largest advance was PR1 resolved-item pruning |

The full live wrapper includes policy rotation, transaction, generation checks,
logging and notification calls; the offline harness collects logs/notifications
in process. No server or provider runs on a research copy. The background sweep
sample explicitly makes its private performance copy idle; the original copied
activity state otherwise blocks maintenance.

At 3.98 completed-item advances per sweep and the existing ten-second sweep
cadence, the first-pass catch-up estimate is about **84 idle hours**. Activity,
other policies, I/O and larger excluded lifecycles can extend elapsed time.
The implementation retains PR1's scheduler and allocator. Bounded rows/bytes do
not impose a hard stall cap. Reader median overhead and initial catch-up time
remain limitations for review.

## Automated and UI verification

- Turbo DB tests: 44 files, 589 tests pass, using migrated real SQLite.
- Turbo server tests: 16 relevant files, 200 tests pass, covering timeline caches,
  pagination, truncation, context clearing, message editing, forks and live pruning.
- New complete traversal tests pass at row budgets 1, 2, 5 and 20 with a 512-byte
  response budget, preserving canonical content through client page merging.
- Turbo DB/server typechecks pass.
- Plugin Guide tests/typecheck pass: ten files, 73 tests.
- Fresh isolated Chromium UI: expand command output, file diff and reasoning;
  preserve text and durations through an actual background rewrite; reload and
  verify persisted rendering. A second rewrite holds highwater at 15 while rows
  fall from 15 to eight. The open page automatically requests
  `timeline?afterSequence=15`, without navigation and with identical visible text.
- The synthetic UI's first fixture initially used the default starting status
  and produced a provisioning error. The fixture was repaired to idle before the
  measured rewrite. No provider turn was sent. Browser and dev processes were
  stopped after verification.

The verification inventory reports pre-existing unmapped `browser` CLI-family
drift on the fetched base. This does not represent a passed inventory check.
No iOS or provider-resume claim is made; this change does not alter drawer UI or
provider execution. Native edit/fork behavior was exercised through the actual
server functions on private copies and existing route tests.

Reproduction scripts, source briefs, full JSON comparisons, timings, logs and UI
screenshots are preserved in the implementing thread's `pr2-start-position`
storage directory. Research databases remain private and mode 0600; Connect
plugin records were verified absent. No live database was opened, no copied live
configuration was launched, and no deployment or merge was performed.
