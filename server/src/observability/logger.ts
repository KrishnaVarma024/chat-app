// Deliberately minimal, hand-rolled structured logger — one JSON object per
// line (newline-delimited JSON), which is the format every real log
// aggregator (Datadog, CloudWatch, Loki, the `docker logs` pipeline) expects
// so it can index fields instead of grepping free text. A production system
// would reach for pino or winston instead of this file — mainly for their
// child-logger ergonomics and lower per-call overhead under real load — but
// the *shape* of what gets logged (one JSON object, always including the
// request id, never string-concatenated) is the actual thing worth
// understanding, and this is small enough to read top to bottom in one pass.
//
// stdout only, on purpose: this process doesn't know or care whether it's
// running in a terminal or inside a container whose stdout a log collector
// is already tailing — writing to a file here would just be one more thing
// to rotate and ship, duplicating what the platform already does for you.

type LogLevel = 'info' | 'warn' | 'error';

interface LogFields {
  requestId?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, fields: LogFields = {}) {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  // console.error for 'error' so it lands on stderr, matching how most log
  // collectors and `npm run dev` itself distinguish error output from the
  // rest — everything else goes to stdout via console.log.
  if (level === 'error') {
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

export const logger = {
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};
