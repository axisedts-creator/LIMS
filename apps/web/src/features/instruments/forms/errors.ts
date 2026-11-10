// Error mapping for the instrument form: API problem+json `errors[]` (JSON Pointer paths) → field messages.
export interface FieldProblem { path?: string; code?: string; message?: string }

/** First message per pointer. Own-property result: a hostile path like "/__proto__/x" can never touch Object.prototype. */
export function fieldErrorsByPointer(errors?: unknown): Record<string, string> {
  const m = new Map<string, string>();
  if (Array.isArray(errors)) {
    for (const e of errors as unknown[]) {
      if (typeof e !== 'object' || e === null) continue;
      const { path, message } = e as FieldProblem;
      if (typeof path === 'string' && path.startsWith('/') && typeof message === 'string' && !m.has(path)) m.set(path, message);
    }
  }
  return Object.fromEntries(m);
}
