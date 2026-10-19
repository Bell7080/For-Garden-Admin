// Snapshot of the game's lobby events (For-Garden src/data/lobbyEvents.ts + ko titles).
// Linking a notice stores only the id and copies the period; edit the period freely.
// When the game adds an event, add one line here in the same change.
export const GAME_EVENTS = [
  {
    id: "wolf-cafe",
    title: "우당탕탕 늑대 카페",
    subtitle: "디안 한정 픽업 이벤트!",
    starts_at: "2026-09-01T00:00:00+09:00",
    ends_at: "2026-12-31T23:59:59+09:00",
  },
  {
    id: "autumn-harvest",
    title: "가을 수확제",
    subtitle: "매일 들러 수확 선물을 받는 이벤트",
    starts_at: "2026-09-01T00:00:00+09:00",
    ends_at: "2026-12-31T23:59:59+09:00",
  },
];
