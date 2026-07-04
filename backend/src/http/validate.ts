import { ApiError } from "./errors";

// Small request-parsing helpers so route bodies/queries validate consistently instead of ad-hoc
// String(req.body?.x ?? "") casts. Each throws ApiError(400) with a clear message on bad input.

// A required, non-empty trimmed string.
export function reqString(v: unknown, field: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new ApiError(400, `${field} required`);
  return s;
}

// An optional trimmed string (undefined when absent/empty).
export function optString(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s || undefined;
}

// A finite integer parsed from a query/body value, or undefined when absent/unparseable. Never
// throws — callers that want a default use `?? fallback`.
export function optInt(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Assert `value` is one of `allowed`, else 400. Returns the narrowed value.
export function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ApiError(400, `unsupported ${field}: ${value}`);
}
