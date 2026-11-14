/** VERIFIED: Shared validators reject ambiguous addresses before allocation or mutation. */
import type { CancellationSignal } from 'defuss-storage';
import type { Options, Ref } from './types.js';
export type ErrorCode = 'CLOSED' | 'CORRUPT' | 'UNSUPPORTED' | 'CONFLICT' | 'ABORTED' | 'QUEUE_FULL' | 'LIMIT_EXCEEDED' | 'COMMIT_UNCERTAIN';
export class DbsonlError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options); this.name = 'DbsonlError';
  }
}
export function abort(signal?: CancellationSignal): void {
  if (signal?.aborted) throw new DbsonlError('ABORTED', 'Operation cancelled.', { cause: signal.reason });
}
export function natural(value: number, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be a safe integer >= ${min}.`);
  return value;
}
export function key(value: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new TypeError('A key must be a string of at most 4096 UTF-16 code units.');
  return value;
}
export function name(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new TypeError('Use a lowercase database name of 1..64 letters, digits, underscores or hyphens.');
  return value;
}
export function corrupt(message: string): never { throw new DbsonlError('CORRUPT', message); }
export function reference(value: unknown, end: number): asserts value is Ref {
  const r = value as Ref;
  if (!r || !Number.isSafeInteger(r.offset) || !Number.isSafeInteger(r.byteLength) || r.offset < 0 || r.byteLength < 16 || !Number.isSafeInteger(r.offset + r.byteLength) || r.offset + r.byteLength > end) corrupt('Reference escapes its committed boundary.');
}
export const DEFAULT_OPTIONS = Object.freeze({ maxRecordBytes: 16 * 1024 * 1024, maxTransactionBytes: 64 * 1024 * 1024, maxTransactionOperations: 10000, maxPendingOperations: 256, maxPendingBytes: 128 * 1024 * 1024, maxCacheBytes: 8 * 1024 * 1024, maxCachePages: 1024 });
export function options(input: Options) {
  const out: { -readonly [K in keyof typeof DEFAULT_OPTIONS]: number } = { ...DEFAULT_OPTIONS };
  for (const field of Object.keys(out) as (keyof typeof out)[]) out[field] = natural(input[field] ?? out[field], field, field.startsWith('maxCache') ? 0 : 1);
  return out;
}
export type Limits = ReturnType<typeof options>;
