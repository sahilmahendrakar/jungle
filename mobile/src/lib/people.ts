// Deterministic avatar coloring derived from a handle, so a given person always gets the same
// color. Ported from frontend/src/lib/people.ts — same hash + palette order, but returns a hex
// (RN has no Tailwind classes). Text is always white on these 500-weight backgrounds.
import { avatarPalette } from "../theme";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function avatarColor(handle: string): string {
  return avatarPalette[hash(handle) % avatarPalette.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
