import { AppState } from "react-native";
import { z } from "zod";

export const notificationTraceEnabled =
  process.env.EXPO_PUBLIC_BB_NOTIFICATION_TRACE === "1";

const pageTraceSchema = z
  .object({
    type: z.literal("bb-notification-trace"),
    stage: z.enum([
      "page-start",
      "visibility",
      "timeline-request",
      "timeline-response",
      "timeline-error",
      "timeline-body",
      "timeline-dom-frame",
    ]),
    at: z.number().finite(),
    monotonicMs: z.number().finite(),
    threadId: z.string().nullable(),
    visibility: z.string(),
    requestId: z.number().optional(),
    status: z.number().optional(),
    serverDate: z.number().nullable().optional(),
    maxSeq: z.number().optional(),
    rowCount: z.number().optional(),
    textLength: z.number().optional(),
  })
  .strict();

type TraceFields = Record<string, string | number | boolean | null>;
const lines: string[] = [];
let writing = Promise.resolve();
let initialized = false;

export function traceNotification(
  stage: string,
  fields: TraceFields = {},
): void {
  if (!notificationTraceEnabled) return;
  const line = JSON.stringify({
    at: Date.now(),
    stage,
    appState: AppState.currentState,
    ...fields,
  });
  writing = writing
    .then(async () => {
      const FileSystem = await import("expo-file-system/legacy");
      if (FileSystem.documentDirectory === null) return;
      const path = `${FileSystem.documentDirectory}notification-trace.ndjson`;
      if (!initialized) {
        initialized = true;
        try {
          const saved = await FileSystem.readAsStringAsync(path);
          lines.push(...saved.trim().split("\n").slice(-999));
        } catch {}
      }
      lines.push(line);
      if (lines.length > 1000) lines.splice(0, lines.length - 1000);
      await FileSystem.writeAsStringAsync(path, `${lines.join("\n")}\n`);
    })
    .catch(() => undefined);
}

export function receivePageTrace(raw: string): boolean {
  if (!notificationTraceEnabled) return false;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  const parsed = pageTraceSchema.safeParse(value);
  if (!parsed.success) return false;
  const { stage, at, ...fields } = parsed.data;
  const defined: TraceFields = { pageAt: at };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) defined[key] = value;
  }
  traceNotification(stage, defined);
  return true;
}
