'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const openapiText = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8');
const openapi = JSON.parse(openapiText);

function getParameter(operation, name) {
  const parameter = operation.parameters.find((item) => item.name === name);
  assert.ok(parameter, `expected parameter ${name}`);
  return parameter;
}

test('openapi: normalize example uses valid Arabic UTF-8', () => {
  const example = openapi.paths['/v1/debug/normalize'].post.requestBody.content['application/json'].example;

  assert.equal(example.text, 'شارع الكرادة داخل');
  assert.doesNotMatch(openapiText, /Ã˜Â´Ã˜Â§Ã˜Â±Ã˜Â¹/);
});

test('openapi: NormalizeResponse documents cleanup fields', () => {
  const schema = openapi.components.schemas.NormalizeResponse;

  assert.deepEqual(schema.required, ['input', 'normalized', 'tokens', 'detected_script', 'applied_rules', 'warnings']);
  assert.deepEqual(schema.properties.detected_script.enum, ['arabic', 'latin', 'mixed', 'unknown']);
  assert.ok(schema.properties.applied_rules);
  assert.ok(schema.properties.warnings);
});

test('openapi: reusable place object schemas exist', () => {
  const schemas = openapi.components.schemas;

  for (const schema of ['NamesObject', 'AddressParts', 'RoutablePoint', 'Entrance', 'Category']) {
    assert.ok(schemas[schema], `expected schema ${schema}`);
  }

  const placeProperties = schemas.PlaceProperties.properties;
  assert.equal(placeProperties.routable_points.items.$ref, '#/components/schemas/RoutablePoint');
  assert.equal(placeProperties.entrances.items.$ref, '#/components/schemas/Entrance');
  assert.equal(placeProperties.address_parts.$ref, '#/components/schemas/AddressParts');
  assert.equal(placeProperties.names.$ref, '#/components/schemas/NamesObject');
});

test('openapi: ErrorResponse requires request_id', () => {
  const schema = openapi.components.schemas.ErrorObject;

  assert.deepEqual(schema.required, ['code', 'message', 'request_id', 'details']);
  assert.ok(schema.properties.request_id);
});

test('openapi: nearby include_distance and coordinate bounds are documented', () => {
  const nearby = openapi.paths['/v1/nearby'].get;
  const includeDistance = getParameter(nearby, 'include_distance');
  const pointLat = getParameter(nearby, 'point.lat');
  const pointLon = getParameter(nearby, 'point.lon');

  assert.equal(includeDistance.schema.default, true);
  assert.equal(pointLat.schema.minimum, -90);
  assert.equal(pointLat.schema.maximum, 90);
  assert.equal(pointLon.schema.minimum, -180);
  assert.equal(pointLon.schema.maximum, 180);
});
