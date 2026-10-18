/**
 * generate-mocks.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Reads openapi.yml from the current working directory.
 * Generates per-endpoint JSON mock response files under ./mocks/
 * Also writes a .automock-meta.json file with the openapi SHA so the
 * frontend PR check (Flow 2) can verify if mocks are in sync.
 *
 * Usage (run by Kestra Node script task):
 *   node generate-mocks.mjs
 *
 * Output structure:
 *   mocks/
 *     .automock-meta.json          ← sync metadata
 *     endpoints/
 *       users/
 *         GET-200.json             ← mock response body
 *         POST-201.json
 *       products/
 *         GET-200.json
 *         GET-404.json             ← error responses too
 *     msw-handlers.js              ← ready-to-use MSW v2 handlers
 * ─────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const jsf = require('json-schema-faker');

// ── Config ──────────────────────────────────────────────────────────────
jsf.option({
  alwaysFakeOptionals: true,   // include optional fields in mocks
  useExamplesValue: true,       // prefer 'example' values from the spec
  useDefaultValue: true,        // fall back to 'default' values
  maxItems: 3,                  // keep arrays short in mocks
  maxLength: 50,
});

// ── Read openapi.yml ─────────────────────────────────────────────────────
const specPath = path.resolve('openapi.yml');
if (!fs.existsSync(specPath)) {
  console.error('❌ openapi.yml not found in working directory');
  process.exit(1);
}

const specRaw = fs.readFileSync(specPath, 'utf8');
const spec = yaml.load(specRaw);

// Compute a simple content hash to track the spec version
import { createHash } from 'crypto';
const openapiHash = createHash('sha256').update(specRaw).digest('hex').slice(0, 40);

console.log(`📄 Loaded openapi.yml (hash: ${openapiHash})`);
console.log(`📋 Title: ${spec.info?.title} v${spec.info?.version}`);

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve a $ref like "#/components/schemas/User" to its schema object.
 */
function resolveRef(ref, rootSpec) {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let current = rootSpec;
  for (const part of parts) {
    current = current[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (!current) return null;
  }
  return current;
}

/**
 * Recursively resolve all $ref occurrences within a schema.
 */
function resolveSchema(schema, rootSpec, depth = 0) {
  if (!schema || depth > 10) return schema;

  if (schema.$ref) {
    return resolveSchema(resolveRef(schema.$ref, rootSpec), rootSpec, depth + 1);
  }

  if (schema.properties) {
    const resolved = { ...schema, properties: {} };
    for (const [key, val] of Object.entries(schema.properties)) {
      resolved.properties[key] = resolveSchema(val, rootSpec, depth + 1);
    }
    return resolved;
  }

  if (schema.items) {
    return { ...schema, items: resolveSchema(schema.items, rootSpec, depth + 1) };
  }

  if (schema.allOf) {
    // Merge all schemas in allOf
    const merged = { type: 'object', properties: {} };
    for (const sub of schema.allOf) {
      const resolved = resolveSchema(sub, rootSpec, depth + 1);
      Object.assign(merged.properties, resolved.properties || {});
    }
    return merged;
  }

  if (schema.oneOf || schema.anyOf) {
    // Pick the first option for mock generation
    const options = schema.oneOf || schema.anyOf;
    return resolveSchema(options[0], rootSpec, depth + 1);
  }

  return schema;
}

/**
 * Generate a mock value for a given response schema.
 */
async function generateMock(schema, rootSpec) {
  const resolved = resolveSchema(schema, rootSpec);
  if (!resolved) return {};

  try {
    return await jsf.resolve(resolved);
  } catch (err) {
    console.warn(`  ⚠️  json-schema-faker failed, using fallback: ${err.message}`);
    return { _mock_error: 'Could not generate mock — check schema', schema: resolved };
  }
}

// ── Main: iterate over all paths and operations ───────────────────────────
const outputDir = path.resolve('mocks');
const endpointsDir = path.join(outputDir, 'endpoints');
fs.mkdirSync(endpointsDir, { recursive: true });

const mswHandlers = [];   // collect MSW handler entries
const summary = [];       // for logging

const paths = spec.paths || {};

for (const [routePath, pathItem] of Object.entries(paths)) {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

  for (const method of methods) {
    const operation = pathItem[method];
    if (!operation) continue;

    const operationId = operation.operationId || `${method.toUpperCase()} ${routePath}`;
    console.log(`\n🔧 ${method.toUpperCase()} ${routePath}`);

    // Build a safe directory path from the route
    // e.g. /users/{id}/posts → users/{id}/posts
    const safePath = routePath.replace(/^\//, '').replace(/\//g, path.sep);
    const opDir = path.join(endpointsDir, safePath, method.toUpperCase());
    fs.mkdirSync(opDir, { recursive: true });

    const responses = operation.responses || {};

    for (const [statusCode, responseObj] of Object.entries(responses)) {
      const content = responseObj.content;

      // Find a JSON media type
      let schema = null;
      if (content) {
        const jsonMedia = content['application/json'] || content['*/*'];
        if (jsonMedia?.schema) {
          schema = jsonMedia.schema;
        }
      }

      let mockData;

      if (schema) {
        mockData = await generateMock(schema, spec);
      } else {
        // No body (e.g. 204 No Content)
        mockData = null;
      }

      // ── Write JSON fixture file ──
      const fixtureName = `${statusCode}.json`;
      const fixturePath = path.join(opDir, fixtureName);
      fs.writeFileSync(fixturePath, JSON.stringify(mockData, null, 2));
      console.log(`  ✅ ${statusCode} → ${path.relative(outputDir, fixturePath)}`);

      // ── Collect MSW handler entry ──
      // Only add success responses as default handlers
      if (statusCode.startsWith('2')) {
        const mswPath = routePath.replace(/\{(\w+)\}/g, ':$1'); // /users/{id} → /users/:id
        mswHandlers.push({
          method: method.toUpperCase(),
          path: mswPath,
          status: parseInt(statusCode),
          fixture: `./endpoints${routePath.replace(/\//g, '/')}/${method.toUpperCase()}/${fixtureName}`,
          operationId,
        });
      }

      summary.push({ method: method.toUpperCase(), path: routePath, status: statusCode });
    }
  }
}

// ── Write MSW v2 handlers file ─────────────────────────────────────────────
const mswImports = mswHandlers.map((h, i) =>
  `import mock_${i} from '${h.fixture}' assert { type: 'json' };`
).join('\n');

const mswHandlersList = mswHandlers.map((h, i) => {
  const method = h.method.toLowerCase();
  return `  http.${method}('${h.path}', () => {
    return HttpResponse.json(mock_${i}, { status: ${h.status} });
  }),`;
}).join('\n');

const mswContent = `/**
 * MSW v2 Handlers — Auto-generated by AutoMock 🤖
 * Do not edit manually. Re-generate by running: npm run generate:mocks
 * Generated at: ${new Date().toISOString()}
 * OpenAPI SHA: ${openapiHash}
 */
import { http, HttpResponse } from 'msw';

${mswImports}

export const handlers = [
${mswHandlersList}
];
`;

fs.writeFileSync(path.join(outputDir, 'msw-handlers.js'), mswContent);
console.log('\n📦 Written: mocks/msw-handlers.js');

// ── Write automock metadata (used by Flow 2 to check sync status) ───────────
const meta = {
  generatedAt: new Date().toISOString(),
  openapiTitle: spec.info?.title,
  openapiVersion: spec.info?.version,
  openapiSha: openapiHash,   // Flow 2 compares this to the current backend SHA
  endpointCount: Object.keys(paths).length,
  mockCount: summary.length,
};
fs.writeFileSync(path.join(outputDir, '.automock-meta.json'), JSON.stringify(meta, null, 2));
console.log('📦 Written: mocks/.automock-meta.json');

// ── Final summary ─────────────────────────────────────────────────────────
console.log(`\n✨ AutoMock done! Generated ${summary.length} mock responses across ${Object.keys(paths).length} endpoint(s).`);
console.table(summary);

