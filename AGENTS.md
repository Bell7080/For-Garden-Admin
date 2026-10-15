# Operations console rules

- Preserve the deployed Supabase authentication, RLS and owner/operator vs cs/viewer permissions. Never place a service_role key in static code or local storage.
- Use the actual sibling game's font files and charcoal/gold visual style. Text must be at least 12px at every breakpoint. Theme all controls and scrollbars; no native select popups, validation bubbles or confirm dialogs. Keep keyboard/focus/screen reader and reduced-motion support.
- Support system/dark/light through shared ui/controls.js. System mode follows the OS; explicit choices persist. Shared controls are copied to the Web repo: keep copies byte-identical and validate both.
- Announcements contain original and optional manually authored language variants only. Do not add translation APIs, provider credentials, generated-cache queries or translation status/retry UI. Missing variants display the original.
- Prefer atomic save_website_notice with updated_at conflict protection. Until the migration exists, preserve the deployed three-language workflow only on the exact PGRST202 missing-RPC error through shared/legacy-save.js. This compatibility path is not atomic: retain explicit notices, create new posts as draft until original text is stored, and never disguise a general RPC failure as a legacy success.
- Do not modify the game checkout for site work. Future community content needs its own data/permissions adapters before implementation.
- Verify npm test, npm run check, npm run build plus browser login/editor/preview/theme/phone checks. Exclude backend code, migrations, secrets and tests from the static build.
