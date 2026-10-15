// Matches the game's SELECTABLE_LANGUAGE_IDS: Korean + 11 translation targets.
export const languages = [
  ["ko", "한국어"],
  ["en", "English"],
  ["ja", "日本語"],
  ["zh-Hant", "繁體中文"],
  ["zh-Hans", "简体中文"],
  ["th", "ไทย"],
  ["vi", "Tiếng Việt"],
  ["id", "Bahasa Indonesia"],
  ["es", "Español"],
  ["pt-BR", "Português (Brasil)"],
  ["de", "Deutsch"],
  ["ru", "Русский"],
];
export const languageIds = languages.map(([id]) => id);
export const languageNames = Object.fromEntries(languages);
