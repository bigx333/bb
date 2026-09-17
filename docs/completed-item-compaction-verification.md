# Completed-item compaction verification

Measured on 2026-09-16 in an isolated worktree based on `5aca5733a5`,
including PR1 (`c663ff1911`, #3766). The final measurements include the
output-order safeguard and exclusion of compaction from synchronous per-thread
cleanup. These are observations from private sanitized SQLite copies.

## Correctness and storage

| Check                              | Result                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Physical events                    | 2,082,639 → 1,080,655 (1,001,984 removed)                                                                                 |
| All table rows                     | 2,571,187 → 1,569,205 (net 1,001,982 removed)                                                                             |
| Combined owners                    | 793,715                                                                                                                   |
| Internal metadata                  | 182,920,304 bytes                                                                                                         |
| Allocated SQLite btree bytes       | 5,634,584,576 → 4,411,314,176 (1,223,270,400 saved)                                                                       |
| Database file bytes                | 6,006,726,656 before and after; freed pages are reusable                                                                  |
| Independent logical reconstruction | All 2,082,639 records match across 2,326 threads, except 119,716 eligible empty command-delta text markers                |
| Complete visible timelines         | All 2,326 match, including all 2,223 non-null context values                                                              |
| Highwater and provider recovery    | All 2,326 match                                                                                                           |
| Existing side tables               | All 46 non-event/non-cursor/non-migration tables match, including output, search and attachment ownership                 |
| Default-budget server pages        | All 30 match exactly                                                                                                      |
| Complete large-thread pagination   | Three largest threads: all 3,816 rendered rows match after complete traversal at a 1,000-row budget; baseline used 10,000 |
| Other consumers                    | 2,326 latest-output checks, ten large outlines and 100 rollback-only output mutations match                               |

There are no added tables or indexes and no full VACUUM. The two-row difference
between physical and total removals is migration/cursor bookkeeping. The worker
performs actual discovery and mutation on a fresh clone.

The output-order safeguard leaves 93 more owners ordinary, retaining 175 rows
that the first revision removed. Assistant items crossing another assistant
completion or manager output must stay ordinary: otherwise moving the completion
can make the output API, plugin summaries and child notifications choose an older
message. Both cases were reproduced through the actual server output helper and
now pass regression tests. Existing user-message/context-clear exclusions and
bounded support/input discovery remain in place.

## Timing and catch-up

Heavy measurements ran sequentially. The host was shared; these observations do
not establish cold-I/O bounds or a maximum event-loop stall.

| Measurement                                             | Result                                            |
| ------------------------------------------------------- | ------------------------------------------------- |
| Full completed-item worker pass                         | 120,866 advances; 304.50 seconds                  |
| Background advance median / p99 / maximum               | 1.90 / 15.18 / 372.18 ms                          |
| Final live wrapper, 2,500 calls                         | median 0.288 ms; p99 5.46 ms; maximum 322.25 ms   |
| PR1 live wrapper, same 2,500-call workload              | median 0.243 ms; p99 5.28 ms; maximum 87.34 ms    |
| Compaction calls / event deletions in final live sample | zero / zero                                       |
| Median of 30 page case medians, before / after          | 103.62 / 121.55 ms                                |
| Median paired page increase                             | 8.42 ms                                           |
| Largest individual page call, before / after            | 391.81 / 464.44 ms                                |
| Actual background sweep, 100 calls                      | 1,565 total advances; 313 completed-item advances |
| Maximum sweep / advance in that sample                  | 216.46 / 177.78 ms                                |

The original 270 ms live compaction stall was independently reproduced at 249 ms.
An isolated replay attributed the delay to transaction commit. Disabling automatic
checkpointing on a disposable copy reduced that compaction call to 1.53 ms;
an explicit checkpoint immediately afterwards took 333.05 ms for 1,002 WAL frames.
That experiment moved the cost; it was not a fix. No checkpoint settings change
in this PR.

Completed-item compaction now runs only in the existing idle background sweep.
The synchronous per-thread rotation retains PR1's four policies. This removes
compaction writes from ingestion and turn-completion handlers, but does not
eliminate SQLite checkpoint stalls from existing writes. The final live maximum
occurred during the existing usage policy with zero event deletions; cursor
transactions still write. The PR1 comparison also exceeded 50 ms. These samples
do not prove identical worst-case latency or quantify a regression from the
individual maxima. No sub-50 ms guarantee is made.

The live harness includes the real wrapper, transaction, generation checks and
in-process notification/logging calls. The background sample explicitly marks
its private copy idle. No server or provider runs on a research copy.

At 3.13 completed-item advances per sweep and the existing ten-second cadence,
the latest sample extrapolates to about **107 idle hours** for first-pass catch-up.
The initial revision's sample estimated 84 hours. Actual processing time remains
about five minutes; scheduling, activity and I/O determine elapsed catch-up.
These are short-sample estimates, not an end-to-end scheduled run. Reader overhead,
checkpoint stalls and multi-day idle catch-up remain limitations.

## Automated and UI verification

Final follow-up checks:

- Turbo DB tests: 44 files, 591 tests pass, using migrated real SQLite.
- Turbo affected server tests: 14 tests pass, including the previously failing
  scheduler test and cached timeline refresh through the actual idle sweep.
- Live cleanup leaves the completion ordinary; idle background cleanup combines
  it and invalidates the warmed timeline. Raw output still excludes metadata.
- Turbo DB/server typechecks pass.
- Full-copy comparisons and pagination listed above were rerun after the fixes.

The initial revision additionally passed 200 selected server tests and 73 Plugin
Guide tests, small-budget traversal tests at budgets 1/2/5/20 with 512-byte
responses, 34 real fork cases (2,638 copied records), and 24 real edit-boundary
rewinds. Fresh synthetic Chromium verification proved command output, file diffs,
reasoning, answers and durations survive background rewriting and reload. A
rewrite with unchanged highwater refreshed the open browser automatically. Those
UI/fork/edit checks were not rerun in the follow-up; renderer, fork and edit code
are unchanged, and compaction eligibility is narrower.

The initial verification inventory reported pre-existing unmapped `browser`
CLI-family drift. No iOS or provider-resume claim is made. Dev processes/browser
from the initial verification were stopped.

Initial evidence remains under implementing thread `thr_mwh5k9hti7` in
`pr2-start-position`. Follow-up scripts, full comparisons, timings and logs are
under parent thread `thr_vmdgc3ke5y` in `pr2-review/final`. Copies are private and
mode 0600, with Connect plugin records verified absent. No live database or copied
Connect configuration was used; nothing was merged or deployed.

## Reader optimization follow-up (2026-09-17)

Compared with rebased PR2 `e2091fbea2` (base `0188d91972`), the reader now
fetches selected completion metadata in one parameterized query instead of
250-ID batches. SQLite uses the existing events primary-key index; `json_each`
expands only the supplied ID array. Nested history no longer goes through an
extra JSON serialization, parse and validation, and reconstruction skips parsing
completion payloads when it needs none of their fields. Storage, compaction
rules, cache state and indexes are unchanged.

Ten large selections, alternating original and optimized reconstruction ten times
per case, matched exactly. Median relative reconstruction improvement was 22.6%.
One 10,000-row selection improved from 170.1 to 135.5 ms, with 35 metadata queries
reduced to one. The query plan uses `sqlite_autoindex_events_1`, not an events scan.

Thirty matching page requests were also measured with six alternating calls per
implementation, after warming both. All response fields and pagination matched.
The median paired elapsed reduction was 7.3 ms; process CPU time fell by a median
paired 8.3 ms, with lower CPU usage in 26 of 30 cases. The host was busy, so elapsed
timings are approximate and are not expected production latency. This compares
optimized PR2 with the original rebased PR2; it does not establish that PR2 is as
fast as main. Component reconstruction savings are not whole-page percentages.

The follow-up passes 602 DB tests, 74 server tests, and DB/server typechecks.
All 2,326 complete timelines and context values match the uncompacted baseline,
with zero differences or errors. This reader change does not establish a new
maximum live or background event-loop stall time.

Artifacts and harnesses:
`/Users/michael/.bb/thread-storage/thr_vmdgc3ke5y/pr2-reader-optimization/`.
