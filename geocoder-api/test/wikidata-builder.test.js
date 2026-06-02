'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCategoryWikidata,
  filterAliases
} = require('../scripts/build-category-wikidata');

test('wikidata builder: filters broad aliases but keeps useful labels', () => {
  const aliases = filterAliases(['place', 'Restaurant', 'dining', 'Q123'], {
    labels: { en: 'Restaurant' },
    manualAliases: { en: ['dining'] },
    categoryId: 'restaurant'
  });

  assert.deepEqual(aliases, ['Restaurant', 'dining']);
});

test('wikidata builder: writes generated labels and warns without failing per QID', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'category-wikidata-'));
  const taxonomyPath = path.join(dir, 'taxonomy.json');
  const outputPath = path.join(dir, 'labels.json');
  const cacheDir = path.join(dir, 'cache');

  await fs.writeFile(taxonomyPath, JSON.stringify({
    categories: [
      {
        id: 'restaurant',
        wikidata: ['Q11707', 'Q404'],
        names: { en: 'Restaurant' },
        aliases: { en: ['dining'] }
      }
    ]
  }));

  const result = await buildCategoryWikidata({
    taxonomyPath,
    outputPath,
    cacheDir,
    languages: ['en', 'ar'],
    fetchImpl: async url => {
      if (String(url).includes('Q404')) {
        return { ok: false, status: 404 };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            entities: {
              Q11707: {
                labels: {
                  en: { value: 'Restaurant' },
                  ar: { value: '\u0645\u0637\u0639\u0645' }
                },
                aliases: {
                  en: [{ value: 'place' }, { value: 'dining' }],
                  ar: [{ value: '\u0645\u0637\u0627\u0639\u0645' }]
                }
              }
            }
          };
        }
      };
    }
  });

  const generated = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(generated.categories.restaurant.labels.ar, '\u0645\u0637\u0639\u0645');
  assert.deepEqual(generated.categories.restaurant.safe_aliases.en, ['dining']);
  assert.ok(result.warnings.some(warning => warning.includes('Q404')));
});
