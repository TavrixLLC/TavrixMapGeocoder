#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_LANGUAGES = ['en', 'ar', 'ku', 'ckb', 'fa', 'tr', 'fr', 'de'];

async function main() {
  const options = {
    taxonomyPath: process.env.CATEGORY_TAXONOMY_PATH || path.join(REPO_ROOT, 'config', 'category-taxonomy.json'),
    outputPath: process.env.CATEGORY_LABELS_OUTPUT || path.join(REPO_ROOT, 'generated', 'category-labels.wikidata.json'),
    cacheDir: process.env.WIKIDATA_CACHE_DIR || path.join(REPO_ROOT, 'generated', 'wikidata-cache'),
    languages: (process.env.WIKIDATA_LANGUAGES || DEFAULT_LANGUAGES.join(','))
      .split(',').map(lang => lang.trim()).filter(Boolean),
    refresh: process.env.WIKIDATA_REFRESH === '1',
    fetchImpl: globalThis.fetch
  };

  const result = await buildCategoryWikidata(options);
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  console.log(`wrote ${result.outputPath}`);
}

async function buildCategoryWikidata(options) {
  if (typeof options.fetchImpl !== 'function') {
    throw new Error('No fetch implementation available; Node 20+ is required.');
  }

  const taxonomy = JSON.parse(await fs.readFile(options.taxonomyPath, 'utf8'));
  const categories = taxonomy.categories || [];
  const warnings = [];
  const output = {
    version: 1,
    generated_at: new Date().toISOString(),
    source: 'wikidata',
    languages: options.languages,
    categories: {}
  };

  await fs.mkdir(options.cacheDir, { recursive: true });
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });

  for (const category of categories) {
    const qids = unique((category.wikidata || []).filter(Boolean));
    if (qids.length === 0) continue;

    const labels = {};
    const aliases = {};
    const safeAliases = {};
    const raw_qids = {};

    for (const qid of qids) {
      try {
        const entity = await fetchEntity(qid, options);
        raw_qids[qid] = {
          labels: pickLanguageValues(entity.labels, options.languages),
          aliases: pickLanguageAliases(entity.aliases, options.languages)
        };
        mergeValues(labels, raw_qids[qid].labels);
        mergeAliasValues(aliases, raw_qids[qid].aliases);
      } catch (err) {
        warnings.push(`${category.id}:${qid}: ${err.message}`);
      }
    }

    for (const [lang, values] of Object.entries(aliases)) {
      safeAliases[lang] = filterAliases(values, {
        labels,
        manualAliases: category.aliases || {},
        categoryId: category.id
      });
    }

    output.categories[category.id] = {
      wikidata: qids,
      labels,
      aliases,
      safe_aliases: safeAliases,
      raw_qids
    };
  }

  output.warnings = warnings;
  await fs.writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return { outputPath: options.outputPath, warnings, output };
}

async function fetchEntity(qid, options) {
  const cachePath = path.join(options.cacheDir, `${qid}.json`);
  if (!options.refresh) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      return cached.entities && cached.entities[qid] ? cached.entities[qid] : cached;
    } catch (_) {
      // Cache miss.
    }
  }

  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const response = await options.fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'TavrixMapGeocoderCategoryBuilder/1.0'
    }
  });
  if (!response.ok) {
    throw new Error(`Wikidata HTTP ${response.status}`);
  }
  const body = await response.json();
  await fs.writeFile(cachePath, `${JSON.stringify(body, null, 2)}\n`);
  const entity = body.entities && body.entities[qid];
  if (!entity || entity.missing) throw new Error('Wikidata entity missing');
  return entity;
}

function pickLanguageValues(values = {}, languages = DEFAULT_LANGUAGES) {
  const out = {};
  for (const lang of languages) {
    const value = values[lang] && values[lang].value;
    if (value) out[lang] = value;
  }
  return out;
}

function pickLanguageAliases(values = {}, languages = DEFAULT_LANGUAGES) {
  const out = {};
  for (const lang of languages) {
    const aliases = (values[lang] || []).map(alias => alias.value).filter(Boolean);
    if (aliases.length > 0) out[lang] = unique(aliases);
  }
  return out;
}

function filterAliases(values = [], context = {}) {
  const manual = new Set(Object.values(context.manualAliases || {})
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(normalize));
  const labelValues = new Set(Object.values(context.labels || {}).map(normalize));
  const seen = new Set();
  const out = [];

  for (const value of values) {
    const clean = String(value || '').trim();
    const key = normalize(clean);
    if (!key || key.length < 2 || seen.has(key)) continue;
    if (isUnsafeAlias(key, { manual, labelValues, categoryId: context.categoryId })) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function isUnsafeAlias(key, { manual, labelValues, categoryId }) {
  if (manual.has(key) || labelValues.has(key) || key === normalize(categoryId)) return false;
  if (/^q\d+$/i.test(key)) return true;
  return new Set([
    'place',
    'point',
    'service',
    'services',
    'building',
    'business',
    'company',
    'organization',
    'location',
    'facility'
  ]).has(key);
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064a')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeValues(target, source) {
  for (const [lang, value] of Object.entries(source || {})) {
    if (!target[lang]) target[lang] = value;
  }
}

function mergeAliasValues(target, source) {
  for (const [lang, values] of Object.entries(source || {})) {
    target[lang] = unique([...(target[lang] || []), ...values]);
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCategoryWikidata,
  filterAliases,
  pickLanguageValues,
  pickLanguageAliases
};
