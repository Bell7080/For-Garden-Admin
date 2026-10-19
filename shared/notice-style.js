// Announcement styles: plain board post, event card, patch note.
// Shared byte-for-byte by the website and the admin console.
export const NOTICE_TEMPLATES = ["plain", "update", "event"];
// Featured/cover boxes are wider than tall but not a banner strip.
export const COVER_RATIO = 2;
export const COVER_ZOOM_MAX = 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) =>
  Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback;
// zoom 1 fits the box (object-fit: cover). x/y are 0-100: which part of the
// overflow is visible, so 50/50 is centred. Used by the site and the editor.
export function normalizeFrame(frame) {
  const f = frame && typeof frame === "object" ? frame : {};
  const round = (v) => Math.round(v * 100) / 100;
  return {
    zoom: round(clamp(num(f.zoom, 1), 1, COVER_ZOOM_MAX)),
    x: round(clamp(num(f.x, 50), 0, 100)),
    y: round(clamp(num(f.y, 50), 0, 100)),
  };
}
export function coverStyle(frame) {
  const { zoom, x, y } = normalizeFrame(frame);
  return `object-position:${x}% ${y}%;transform:scale(${zoom});transform-origin:${x}% ${y}%`;
}
// How many percent of focus one dragged pixel is worth. The visible window's
// left edge is x/100 * (coverWidth - boxWidth / zoom), so the mapping is exact.
export function dragFocus(frame, deltaPx, boxPx, coverPx) {
  const { zoom } = normalizeFrame(frame);
  const range = coverPx - boxPx / zoom;
  return range > 0.5 ? (-(deltaPx / zoom) / range) * 100 : 0;
}
export function coverSize(ratio, boxW, boxH) {
  return ratio > boxW / boxH
    ? { w: boxH * ratio, h: boxH }
    : { w: boxW, h: boxW / ratio };
}
const iso = (v) =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : undefined;
export function normalizeMeta(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  const out = {};
  const version =
    typeof m.version === "string" ? m.version.trim().slice(0, 24) : "";
  if (version) out.version = version;
  const id = typeof m.game_event_id === "string" ? m.game_event_id.trim() : "";
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) out.game_event_id = id;
  const starts = iso(m.starts_at);
  const ends = iso(m.ends_at);
  if (starts) out.starts_at = starts;
  if (ends) out.ends_at = ends;
  if (starts && ends && Date.parse(ends) < Date.parse(starts))
    delete out.ends_at;
  return out;
}
export function eventPhase(meta, now = Date.now()) {
  const m = normalizeMeta(meta);
  if (m.ends_at && Date.parse(m.ends_at) < now) return "ended";
  if (m.starts_at && Date.parse(m.starts_at) > now) return "upcoming";
  return "live";
}
// Remaining time for the badge: D-n for a day or more, otherwise hours/minutes.
export function remaining(endsAt, now = Date.now()) {
  const ms = Date.parse(endsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60000);
  return {
    days: Math.floor(minutes / 1440),
    hours: Math.floor((minutes % 1440) / 60),
    minutes: minutes % 60,
  };
}
