'use strict';

/**
 * Text normalization for Arabic/Kurdish/English search.
 *
 * Key policy: ة (taa marbuta) is preserved in canonical output.
 * Folding ة→ه is left to Elasticsearch search-time analyzers only.
 */

// ── Arabic digit ranges ──────────────────────────────────────────
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const PERSIAN_DIGITS = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

function normalizeText(input, lang) {
  const original = String(input || '');
  const detectedScript = detectScript(original);
  const appliedRules = [];
  const warnings = [];

  let normalized = original.normalize('NFKC').trim();

  const isArabicScript = (lang || '').toLowerCase().startsWith('ar')
    || (lang || '').toLowerCase().startsWith('ku')
    || (lang || '').toLowerCase() === 'ckb'
    || detectedScript === 'arabic'
    || detectedScript === 'mixed';

  if (isArabicScript) {
    const result = normalizeArabic(normalized);
    normalized = result.text;
    appliedRules.push(...result.rules);
  } else {
    normalized = normalized.toLowerCase();
    appliedRules.push('lowercase');
  }

  // Normalize digits (Arabic and Persian to Latin)
  const digitResult = normalizeDigits(normalized);
  if (digitResult.changed) {
    normalized = digitResult.text;
    appliedRules.push('arabic_digits_to_latin');
  }

  // Normalize Arabic punctuation
  const punctResult = normalizeArabicPunctuation(normalized);
  if (punctResult.changed) {
    normalized = punctResult.text;
    appliedRules.push('arabic_punctuation');
  }

  // General whitespace/punctuation cleanup
  normalized = normalized
    .replace(/[^\p{L}\p{N}\s.,;?!_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized ? normalized.split(/\s+/) : [];

  return {
    input: original,
    normalized,
    tokens,
    detected_script: detectedScript,
    applied_rules: appliedRules,
    warnings
  };
}

/**
 * Core Arabic normalization.
 *
 * IMPORTANT: ة (taa marbuta) is NOT normalized to ه here.
 * This preserves semantic distinction (مدينة ≠ مدينه).
 * Search-time folding should be done in Elasticsearch analyzers.
 */
function normalizeArabic(value) {
  const rules = [];
  let text = value;

  // Remove diacritics/tashkeel (U+064B – U+065F, U+0670 shadda/fatha/damma/kasra/sukun/etc.)
  const beforeDiacritics = text;
  text = text.replace(/[\u064B-\u065F\u0670]/g, '');
  if (text !== beforeDiacritics) rules.push('remove_diacritics');

  // Remove tatweel/kashida (U+0640)
  const beforeTatweel = text;
  text = text.replace(/\u0640/g, '');
  if (text !== beforeTatweel) rules.push('remove_tatweel');

  // Normalize alef variants: أ إ آ ٱ → ا
  const beforeAlef = text;
  text = text.replace(/[إأآٱ]/g, 'ا');
  if (text !== beforeAlef) rules.push('normalize_alef');

  // Normalize alef maqsura: ى → ي
  const beforeAlefMaqsura = text;
  text = text.replace(/ى/g, 'ي');
  if (text !== beforeAlefMaqsura) rules.push('normalize_alef_maqsura');

  // Normalize hamza carriers: ؤ → و, ئ → ي
  const beforeHamza = text;
  text = text.replace(/ؤ/g, 'و');
  text = text.replace(/ئ/g, 'ي');
  if (text !== beforeHamza) rules.push('normalize_hamza_carriers');

  // Normalize Persian/Kurdish characters commonly mixed in Iraqi text
  const beforePersian = text;
  text = text.replace(/گ/g, 'ك');
  text = text.replace(/ک/g, 'ك');
  text = text.replace(/ی/g, 'ي');
  if (text !== beforePersian) rules.push('normalize_persian_chars');

  // Normalize additional Kurdish kaf/yaa forms used in Sorani text.
  const beforeKurdish = text;
  text = text.replace(/ڪ/g, 'ك');
  text = text.replace(/ێ/g, 'ي');
  if (text !== beforeKurdish) rules.push('normalize_kurdish_kaf_yaa');

  const beforeIraqiSpellings = text;
  text = normalizeCommonIraqiSpellings(text);
  if (text !== beforeIraqiSpellings) rules.push('normalize_iraqi_spellings');

  // Lowercase
  text = text.toLowerCase();
  rules.push('lowercase');

  return { text, rules };
}

function normalizeCommonIraqiSpellings(value) {
  return value
    .replace(/كراده/g, 'كرادة')
    .replace(/حارثيه/g, 'حارثية')
    .replace(/منطقه/g, 'منطقة')
    .replace(/مدينه/g, 'مدينة')
    .replace(/جامعه/g, 'جامعة')
    .replace(/بصره/g, 'بصرة')
    .replace(/ناصريه/g, 'ناصرية')
    .replace(/ديوانيه/g, 'ديوانية')
    .replace(/سماوه/g, 'سماوة')
    .replace(/عماره/g, 'عمارة')
    .replace(/كوفه/g, 'كوفة')
    .replace(/حله/g, 'حلة');
}

/**
 * Converts Arabic/Eastern and Persian/Farsi digits to Latin digits.
 */
function normalizeDigits(value) {
  let changed = false;
  let text = value;

  // Arabic-Indic digits ٠-٩
  text = text.replace(/[٠-٩]/g, d => { changed = true; return ARABIC_DIGITS[d]; });

  // Extended Arabic-Indic (Persian) digits ۰-۹
  text = text.replace(/[۰-۹]/g, d => { changed = true; return PERSIAN_DIGITS[d]; });

  return { text, changed };
}

/**
 * Normalizes Arabic-specific punctuation to ASCII equivalents.
 */
function normalizeArabicPunctuation(value) {
  let changed = false;
  let text = value;

  // Arabic comma ، → ,
  const before = text;
  text = text.replace(/،/g, ',');
  // Arabic semicolon ؛ → ;
  text = text.replace(/؛/g, ';');
  // Arabic question mark ؟ → ?
  text = text.replace(/؟/g, '?');
  // Arabic percent ٪ → %
  text = text.replace(/٪/g, '%');
  // Arabic decimal separator ٫ → .
  text = text.replace(/٫/g, '.');

  if (text !== before) changed = true;
  return { text, changed };
}

/**
 * Detects the primary script of the input text.
 * Returns 'arabic', 'latin', 'mixed', or 'unknown'.
 */
function detectScript(text) {
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);

  if (hasArabic && hasLatin) return 'mixed';
  if (hasArabic) return 'arabic';
  if (hasLatin) return 'latin';
  return 'unknown';
}

/**
 * Checks if text contains Arabic script characters.
 */
function containsArabic(value) {
  return /[\u0600-\u06FF]/.test(value);
}

module.exports = {
  normalizeText,
  normalizeArabic,
  normalizeCommonIraqiSpellings,
  normalizeDigits,
  normalizeArabicPunctuation,
  detectScript,
  containsArabic
};
