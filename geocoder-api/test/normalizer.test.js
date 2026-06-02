'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeText, normalizeArabic, normalizeDigits, detectScript, containsArabic } = require('../src/normalizer');

test('normalizeText: removes Arabic diacritics', () => {
  const result = normalizeText('شَارِعُ الكِرَادَة', 'ar');
  assert.equal(result.normalized, 'شارع الكرادة');
  assert.ok(result.applied_rules.includes('remove_diacritics'));
});

test('normalizeText: preserves taa marbuta ة', () => {
  const result = normalizeText('الكرادة', 'ar');
  assert.equal(result.normalized, 'الكرادة');
  assert.ok(!result.normalized.includes('ه'));
});

test('normalizeText: preserves مدينة (taa marbuta)', () => {
  const result = normalizeText('مدينة', 'ar');
  assert.equal(result.normalized, 'مدينة');
});

test('normalizeText: normalizes alef variants', () => {
  const result = normalizeText('أحمد إبراهيم آية ٱلله', 'ar');
  assert.ok(result.normalized.startsWith('احمد'));
  assert.ok(result.applied_rules.includes('normalize_alef'));
});

test('normalizeText: normalizes alef maqsura to ya', () => {
  const result = normalizeText('مستشفى', 'ar');
  assert.ok(result.normalized.includes('مستشفي'));
  assert.ok(result.applied_rules.includes('normalize_alef_maqsura'));
});

test('normalizeText: normalizes hamza carriers', () => {
  const result = normalizeText('مؤسسة مئذنة', 'ar');
  assert.ok(result.normalized.includes('موسسة'));
  assert.ok(result.normalized.includes('ميذنة'));
  assert.ok(result.applied_rules.includes('normalize_hamza_carriers'));
});

test('normalizeText: removes tatweel', () => {
  const result = normalizeText('بـغـداد', 'ar');
  assert.equal(result.normalized, 'بغداد');
  assert.ok(result.applied_rules.includes('remove_tatweel'));
});

test('normalizeText: converts Arabic digits to Latin', () => {
  const result = normalizeText('شارع ١٢٣', 'ar');
  assert.ok(result.normalized.includes('123'));
  assert.ok(result.applied_rules.includes('arabic_digits_to_latin'));
});

test('normalizeText: converts Persian digits to Latin', () => {
  const result = normalizeText('۰۱۲۳۴۵۶۷۸۹');
  assert.equal(result.normalized, '0123456789');
});

test('normalizeText: normalizes Arabic punctuation', () => {
  const result = normalizeText('بغداد، العراق؟ نعم؛', 'ar');
  assert.ok(result.normalized.includes(','));
  assert.ok(result.applied_rules.includes('arabic_punctuation'));
});

test('normalizeText: normalizes Persian characters', () => {
  const result = normalizeText('گلستان ک', 'ar');
  assert.ok(result.normalized.includes('كلستان'));
  assert.ok(result.applied_rules.includes('normalize_persian_chars'));
});

test('normalizeText: normalizes Kurdish kaf and yaa variants', () => {
  const result = normalizeText('ڪوردێ', 'ku');
  assert.equal(result.normalized, 'كوردي');
  assert.ok(result.applied_rules.includes('normalize_kurdish_kaf_yaa'));
});

test('normalizeText: handles common Iraqi spellings', () => {
  const result = normalizeText('كراده بصره جامعه', 'ar');
  assert.equal(result.normalized, 'كرادة بصرة جامعة');
  assert.ok(result.applied_rules.includes('normalize_iraqi_spellings'));
});

test('normalizeText: lowercases Latin text', () => {
  const result = normalizeText('Baghdad IRAQ', 'en');
  assert.equal(result.normalized, 'baghdad iraq');
  assert.ok(result.applied_rules.includes('lowercase'));
});

test('normalizeText: tokenizes correctly', () => {
  const result = normalizeText('شارع الكرادة داخل', 'ar');
  assert.deepEqual(result.tokens, ['شارع', 'الكرادة', 'داخل']);
});

test('normalizeText: handles empty input', () => {
  const result = normalizeText('', 'ar');
  assert.equal(result.normalized, '');
  assert.deepEqual(result.tokens, []);
});

test('normalizeText: handles whitespace-only input', () => {
  const result = normalizeText('   ');
  assert.equal(result.normalized, '');
});

test('normalizeText: collapses multiple spaces', () => {
  const result = normalizeText('شارع    الكرادة', 'ar');
  assert.equal(result.normalized, 'شارع الكرادة');
});

test('normalizeText: returns detected_script', () => {
  assert.equal(normalizeText('بغداد').detected_script, 'arabic');
  assert.equal(normalizeText('Baghdad').detected_script, 'latin');
  assert.equal(normalizeText('بغداد Baghdad').detected_script, 'mixed');
  assert.equal(normalizeText('123').detected_script, 'unknown');
});

test('normalizeText: returns input unchanged in output', () => {
  const result = normalizeText('شَارِع');
  assert.equal(result.input, 'شَارِع');
});

test('detectScript: Arabic only', () => {
  assert.equal(detectScript('بغداد'), 'arabic');
});

test('detectScript: Latin only', () => {
  assert.equal(detectScript('Baghdad'), 'latin');
});

test('detectScript: mixed', () => {
  assert.equal(detectScript('بغداد Baghdad'), 'mixed');
});

test('containsArabic: true for Arabic', () => {
  assert.ok(containsArabic('بغداد'));
});

test('containsArabic: false for Latin', () => {
  assert.ok(!containsArabic('Baghdad'));
});

test('normalizeArabic: comprehensive Iraqi text', () => {
  const result = normalizeArabic('شَـارِعُ الكِـرَادَة دَاخِل');
  assert.ok(!result.text.includes('\u064B')); // no diacritics
  assert.ok(!result.text.includes('\u0640')); // no tatweel
  assert.ok(result.text.includes('الكرادة')); // ة preserved
});
