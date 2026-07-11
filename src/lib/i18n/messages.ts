import { common } from "./catalog/common";
import { feed } from "./catalog/feed";
import { articles } from "./catalog/articles";
import { shared } from "./catalog/shared";
import { settings } from "./catalog/settings";
import { errors } from "./catalog/errors";
import { translate } from "./catalog/translate";
import { onboarding } from "./catalog/onboarding";
import { program } from "./catalog/program";
import { player } from "./catalog/player";

/**
 * The full message tree, assembled from the per-domain catalogs. `ja` is the
 * source of truth; its shape defines {@link Messages}, and every other locale
 * (en here, plus the standalone files in ./locales) is type-checked against it,
 * so a forgotten key is a compile error rather than a silent blank.
 */
export const ja = {
  common: common.ja,
  feed: feed.ja,
  articles: articles.ja,
  shared: shared.ja,
  settings: settings.ja,
  errors: errors.ja,
  translate: translate.ja,
  onboarding: onboarding.ja,
  program: program.ja,
  player: player.ja,
};

export const en: Messages = {
  common: common.en,
  feed: feed.en,
  articles: articles.en,
  shared: shared.en,
  settings: settings.en,
  errors: errors.en,
  translate: translate.en,
  onboarding: onboarding.en,
  program: program.en,
  player: player.en,
};

export type Messages = typeof ja;
