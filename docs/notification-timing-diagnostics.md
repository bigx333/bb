# Temporary notification timing capture

This investigation branch provides an internally distributed iOS build and optional server logging. It does not fix notification timing. Do not publish it as a release.

## Build and capture

Run the **Mobile iOS (EAS)** workflow on this branch with profile `preview`, `submit=false`, and an empty external group. This embeds the JavaScript bundle, so the phone does not need Metro. Internal iOS installation requires the phone to be in the existing EAS provisioning profile; a signing failure is a blocker, not a successful build.

The profile sets `EXPO_PUBLIC_BB_NOTIFICATION_TRACE=1`. On this investigation branch, only this profile enables the diagnostic injection and iOS Files access. Connect to the usual server and enable notifications. Use two fresh root threads with the same short prompt. Keep another thread visible in the foreground run so read-state suppression does not prevent the notification. Then separately check the notified thread while visible. For the background run, background the app before completion, tap the notification, and wait for the answer. Record the screen for the visual notification/display boundary; a JS callback is not proof that a banner was displayed.

Export **Files → On My iPhone → bb → notification-trace.ndjson** immediately after the runs. The file retains the newest 1,000 records across app launches. It contains timestamps, thread and notification IDs, app state, timeline sequence numbers, row counts, and text lengths. It does not contain response text, push tokens, server URLs, or credentials. DOM samples are deduplicated, observed after two animation frames, and do not claim that a completed answer has painted. Virtualized/collapsed content may not be present in the DOM. Timeline headers and body arrival are separate events. Background JS receipt callbacks can be deferred; preserve `nativeDate` separately from callback time.

## Server evidence

On the server host, run this read-only sampler during both trials:

```sh
python3 scripts/trace-notification-events.py /absolute/path/to/bb.db thr_foreground thr_background --seconds 180 > notification-server.ndjson
```

It captures persisted final-message and completion metadata plus the last global relay result. The global result has no thread ID and cannot alone attribute delivery when other threads complete concurrently. Existing event `created_at` values are stored-event timestamps, not a measured SQLite commit instant; `observedAt` records when the sampler first saw the row.

For exact per-thread send boundaries, run the diagnostic server branch with `BB_NOTIFICATION_TRACE=1`. The push plugin logs `scheduled`, `suppressed-read`, `relay-request`, and `relay-result` as JSON in the ordinary server log. No push tokens or response text are logged. This flag requires this branch; it does not instrument an already-running installed server. Do not replace or restart the personal server merely to enable it without coordinating that operational change.

Compare mobile events on the phone's clock. HTTP `Date` headers provide only a coarse server-clock estimate (second precision plus request latency); do not interpret cross-device millisecond differences as exact latency. A relay success is an Expo acceptance result, not proof of APNs delivery or on-screen presentation. Correlate thread IDs, stored sequence, native notification date, callback time, timeline body arrival, DOM observations, and the screen recording before assigning a root cause.

Remove this diagnostic build after capture. No issue should be reopened on the strength of instrumentation alone.
