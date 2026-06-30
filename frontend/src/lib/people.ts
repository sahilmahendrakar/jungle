// Deterministic avatar styling derived from a handle, so a given person always
// gets the same color. Tailwind classes (background + text) for an AvatarFallback.
const PALETTE = [
  "bg-rose-500 text-white",
  "bg-orange-500 text-white",
  "bg-amber-500 text-white",
  "bg-emerald-500 text-white",
  "bg-teal-500 text-white",
  "bg-sky-500 text-white",
  "bg-indigo-500 text-white",
  "bg-violet-500 text-white",
  "bg-fuchsia-500 text-white",
  "bg-pink-500 text-white",
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function avatarClass(handle: string): string {
  return PALETTE[hash(handle) % PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
