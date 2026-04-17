/**
 * Localized Button Matcher
 *
 * Shared helper for resolving the current simulator locale's button label
 * for a given semantic key, optionally reading the app bundle's .lproj resources.
 *
 * Primary use-case: supply a list of locale-aware candidate labels to
 * `app_alert_handle`'s `buttonLabels` parameter so the AX-press path works
 * on non-English simulator locales without the caller knowing the target locale.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {
  SYSTEM_BUTTON_CATALOG,
  SemanticButtonKey,
  SupportedLocale,
} from './system-button-catalog';

const execFileAsync = promisify(execFile);

/**
 * Retrieve the active locale identifier for a booted simulator via `simctl`.
 *
 * Returns the locale string (e.g. "ko_KR", "ja_JP", "en_US") or `null` when
 * it cannot be determined (device not booted, simctl unavailable, etc.).
 */
export async function getSimulatorLocale(deviceId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'xcrun',
      ['simctl', 'spawn', deviceId, 'defaults', 'read', '-g', 'AppleLocale'],
      { timeout: 8_000 },
    );
    const locale = stdout.trim();
    return locale.length > 0 ? locale : null;
  } catch {
    return null;
  }
}

/**
 * Map a full locale string (e.g. "ko_KR", "zh_Hans_CN") to a supported
 * catalog locale key. Falls back to 'en' when no match is found.
 */
export function mapToSupportedLocale(locale: string): SupportedLocale {
  // zh-Hans variants
  if (locale.startsWith('zh_Hans') || locale.startsWith('zh-Hans')) return 'zh-Hans';
  // Language prefix matching
  const lang = locale.split('_')[0].split('-')[0];
  const supported: SupportedLocale[] = ['en', 'ko', 'ja', 'zh-Hans'];
  return (supported.find((s) => s === lang) as SupportedLocale | undefined) ?? 'en';
}

/**
 * Read a localized string from an app bundle's .lproj Localizable.strings file.
 *
 * Searches `<bundlePath>/<locale>.lproj/Localizable.strings` for the given key.
 * Returns `null` when the file is not found, the key is absent, or parsing fails.
 *
 * This is a best-effort read — callers should fall through to the catalog when null.
 */
export function readBundleLocalizedString(
  bundlePath: string,
  locale: string,
  key: string,
): string | null {
  // Try the exact locale, then the language prefix, then English
  const candidates = [
    locale,
    locale.split('_')[0],
    'en',
  ];

  for (const candidate of candidates) {
    const stringsPath = path.join(bundlePath, `${candidate}.lproj`, 'Localizable.strings');
    if (!fs.existsSync(stringsPath)) continue;

    try {
      const content = fs.readFileSync(stringsPath, 'utf-8');
      // Simple regex parse: "key" = "value";
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = content.match(new RegExp(`"${escaped}"\\s*=\\s*"([^"\\\\]|\\\\.)*"`));
      if (match) {
        // Extract value between outer quotes
        const full = match[0];
        const valueMatch = full.match(/=\s*"((?:[^"\\]|\\.)*)"/);
        if (valueMatch) {
          return valueMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
      }
    } catch {
      // File read or parse failure — try next candidate
    }
  }

  return null;
}

/**
 * Resolve the current locale's button label for a semantic key.
 *
 * Resolution order:
 *   1. App bundle .lproj resources (if `bundlePath` provided)
 *   2. System catalog (SYSTEM_BUTTON_CATALOG) for the detected locale
 *   3. English catalog fallback
 *
 * @param params.semanticKey  Semantic button key (e.g. 'alert.ok')
 * @param params.deviceId     Simulator UDID (used to detect active locale)
 * @param params.bundlePath   Optional path to the app bundle for .lproj lookup
 * @param params.stringKey    Optional Localizable.strings key (defaults to semanticKey)
 * @returns                   Ordered list of label candidates (primary + English fallback)
 */
export async function resolveLocalizedButtonLabels(params: {
  semanticKey: SemanticButtonKey;
  deviceId: string;
  bundlePath?: string;
  stringKey?: string;
}): Promise<string[]> {
  const { semanticKey, deviceId, bundlePath, stringKey } = params;

  const locale = await getSimulatorLocale(deviceId);
  const supportedLocale = locale ? mapToSupportedLocale(locale) : 'en';

  const candidates: string[] = [];

  // 1. Bundle .lproj lookup (if bundle path provided)
  if (bundlePath && locale) {
    const bundleLabel = readBundleLocalizedString(
      bundlePath,
      locale,
      stringKey ?? semanticKey,
    );
    if (bundleLabel && !candidates.includes(bundleLabel)) {
      candidates.push(bundleLabel);
    }
  }

  // 2. System catalog — locale-specific label
  const catalogEntry = SYSTEM_BUTTON_CATALOG[semanticKey];
  const localeLabel = catalogEntry[supportedLocale];
  if (localeLabel && !candidates.includes(localeLabel)) {
    candidates.push(localeLabel);
  }

  // 3. English fallback (always include as last resort)
  const enLabel = catalogEntry['en'];
  if (enLabel && !candidates.includes(enLabel)) {
    candidates.push(enLabel);
  }

  return candidates;
}
