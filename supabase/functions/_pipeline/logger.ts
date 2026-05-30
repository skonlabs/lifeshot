// deno-lint-ignore-file no-explicit-any
export interface LogFields { [k: string]: unknown }

function emit(level: string, msg: string, fields: LogFields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}
export const logger = {
  debug: (m: string, f?: LogFields) => emit("debug", m, f),
  info:  (m: string, f?: LogFields) => emit("info", m, f),
  warn:  (m: string, f?: LogFields) => emit("warn", m, f),
  error: (m: string, f?: LogFields) => emit("error", m, f),
};

export function metric(name: string, value = 1, tags: LogFields = {}) {
  emit("metric", name, { value, ...tags });
}

export async function timed<T>(name: string, tags: LogFields, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    metric(`${name}.ms`, Math.round(performance.now() - t0), { ...tags, ok: true });
    return r;
  } catch (e) {
    metric(`${name}.ms`, Math.round(performance.now() - t0), { ...tags, ok: false });
    throw e;
  }
}