'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..', '..');

test('geocoder-api: package does not include PostGIS client dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'geocoder-api', 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  assert.equal(deps.pg, undefined);
  assert.equal(deps['pg-query-stream'], undefined);
});

test('geocoder-api: source does not import or reference PostGIS connection code', () => {
  const srcDir = path.join(repoRoot, 'geocoder-api', 'src');
  const files = walk(srcDir).filter(file => file.endsWith('.js'));
  const joined = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');

  assert.doesNotMatch(joined, /require\(['"]pg['"]\)/);
  assert.doesNotMatch(joined, /POSTGIS_/);
  assert.doesNotMatch(joined, /\bPostgisReader\b/);
});

test('geocoder-api: request-time source does not fetch Wikidata directly', () => {
  const srcDir = path.join(repoRoot, 'geocoder-api', 'src');
  const files = walk(srcDir).filter(file => file.endsWith('.js'));
  const joined = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');

  assert.doesNotMatch(joined, /wikidata\.org/i);
  assert.doesNotMatch(joined, /Special:EntityData/i);
  assert.doesNotMatch(joined, /\bfetchEntity\b/);
});

test('docker-compose: geocoder-api is not given PostGIS environment', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const block = serviceBlock(compose, 'geocoder-api');

  assert.ok(block);
  assert.doesNotMatch(block, /^\s+env_file:/m);
  assert.doesNotMatch(block, /POSTGIS_/);
});

test('docker-compose.prod: geocoder-api has no PostGIS environment or external PostGIS network', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.prod.yml'), 'utf8');
  const block = serviceBlock(compose, 'geocoder-api');

  assert.ok(block);
  assert.doesNotMatch(block, /^\s+env_file:/m);
  assert.doesNotMatch(block, /POSTGIS_/);
  assert.doesNotMatch(block, /postgis_external/);
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function serviceBlock(compose, serviceName) {
  const match = compose.match(new RegExp(`\\n  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|\\nnetworks:|\\nvolumes:|$)`));
  return match && match[1];
}
