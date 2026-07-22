import type { AppLocale } from './appLocale';
import { APP_LOCALES } from './appLocale';

// One JSON file per module (folder per locale), like the Frontend NVX2 layout:
//   src/locales/<locale>/<module>.json
// The module filename is the top-level namespace, so a key such as
// `report_view.edit_toolbar.edit_button.tooltip` lives in report_view.json.
// The English modules are imported explicitly below so `MessageBundle` stays a
// precise type and en_US is always available as the runtime fallback.
import en_common from '../locales/en_US/common.json';
import en_errors from '../locales/en_US/errors.json';
import en_app_shell from '../locales/en_US/app_shell.json';
import en_app_landing from '../locales/en_US/app_landing.json';
import en_ai_chat from '../locales/en_US/ai_chat.json';
import en_menu_editor from '../locales/en_US/menu_editor.json';
import en_report_view from '../locales/en_US/report_view.json';
import en_composite_report from '../locales/en_US/composite_report.json';
import en_sql_editor from '../locales/en_US/sql_editor.json';
import en_login from '../locales/en_US/login.json';
import en_settings from '../locales/en_US/settings.json';

const en_US = {
  common: en_common,
  errors: en_errors,
  app_shell: en_app_shell,
  app_landing: en_app_landing,
  ai_chat: en_ai_chat,
  menu_editor: en_menu_editor,
  report_view: en_report_view,
  composite_report: en_composite_report,
  sql_editor: en_sql_editor,
  login: en_login,
  settings: en_settings,
};

export type MessageBundle = typeof en_US;

// Non-English module files are globbed so a locale folder added later
// auto-registers without code changes — provided its code is in
// APP_LOCALES. Each file's contents are keyed under its module (filename), so the
// assembled bundle matches the shape of the explicit en_US object above.
const moduleFiles = import.meta.glob<Record<string, unknown>>('../locales/*/*.json', {
  eager: true,
  import: 'default',
});

const assembled: Partial<Record<AppLocale, Record<string, unknown>>> = {};
for (const [path, contents] of Object.entries(moduleFiles)) {
  const match = path.match(/\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) continue;
  const [, locale, moduleName] = match;
  if (!(APP_LOCALES as readonly string[]).includes(locale)) continue;
  (assembled[locale as AppLocale] ??= {})[moduleName] = contents;
}

export const MESSAGE_PACKS = assembled as Partial<Record<AppLocale, MessageBundle>>;

/**
 * Deep-merge a translation bundle over the English base so every missing leaf
 * (an untranslated key, or an entire missing module) falls back to English
 * instead of rendering a raw key path. Non-object leaves in `override` win.
 */
function deepMergeOverEnglish(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = out[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
    ) {
      out[key] = deepMergeOverEnglish(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (typeof value === 'string' && value.length > 0) {
      // Only let a translation override when it actually has content; an empty
      // string (some exporters emit these for untranslated keys) keeps English.
      out[key] = value;
    }
  }
  return out;
}

const packCache = new Map<AppLocale, MessageBundle>();

export function getMessagePack(locale: AppLocale): MessageBundle {
  // en_US uses the explicitly-imported (fully typed) bundle.
  if (locale === 'en_US') return en_US;
  const cached = packCache.get(locale);
  if (cached) return cached;
  const pack = MESSAGE_PACKS[locale];
  const merged = (
    pack
      ? deepMergeOverEnglish(en_US as unknown as Record<string, unknown>, pack as Record<string, unknown>)
      : en_US
  ) as MessageBundle;
  packCache.set(locale, merged);
  return merged;
}

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return value != null && (APP_LOCALES as readonly string[]).includes(value);
}
