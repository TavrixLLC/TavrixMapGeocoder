'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const openapi = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.yaml'), 'utf8');

test('openapi: normalize example uses valid Arabic UTF-8', () => {
  assert.match(openapi, /text:\s*شارع الكرادة داخل/);
  assert.doesNotMatch(openapi, /Ø´Ø§Ø±Ø¹/);
});

test('openapi: NormalizeResponse documents cleanup fields', () => {
  assert.match(openapi, /NormalizeResponse:[\s\S]*required: \[input, normalized, tokens, detected_script, applied_rules, warnings\]/);
  assert.match(openapi, /detected_script:[\s\S]*enum: \[arabic, latin, mixed, unknown\]/);
  assert.match(openapi, /applied_rules:/);
  assert.match(openapi, /warnings:/);
});

test('openapi: reusable place object schemas exist', () => {
  for (const schema of ['NamesObject', 'AddressParts', 'RoutablePoint', 'Entrance', 'Category']) {
    assert.match(openapi, new RegExp(`\\n    ${schema}:`));
  }
  assert.match(openapi, /routable_points:[\s\S]*\$ref: '#\/components\/schemas\/RoutablePoint'/);
  assert.match(openapi, /entrances:[\s\S]*\$ref: '#\/components\/schemas\/Entrance'/);
  assert.match(openapi, /address_parts:[\s\S]*\$ref: '#\/components\/schemas\/AddressParts'/);
  assert.match(openapi, /names:[\s\S]*\$ref: '#\/components\/schemas\/NamesObject'/);
});

test('openapi: ErrorResponse requires request_id', () => {
  assert.match(openapi, /ErrorObject:[\s\S]*required: \[code, message, request_id, details\]/);
  assert.match(openapi, /request_id:/);
});

test('openapi: nearby include_distance and coordinate bounds are documented', () => {
  assert.match(openapi, /name: include_distance[\s\S]*default: true/);
  assert.match(openapi, /name: point\.lat[\s\S]*minimum: -90[\s\S]*maximum: 90/);
  assert.match(openapi, /name: point\.lon[\s\S]*minimum: -180[\s\S]*maximum: 180/);
});

