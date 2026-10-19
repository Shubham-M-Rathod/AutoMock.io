/**
 * generate-mocks.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Smart OpenAPI Mock Generator with Minimum Change Preservation 🎯
 *
 * Core Concept:
 * When openapi.yml changes (e.g. a new field 'age' is added, or an endpoint
 * is updated), we DO NOT blow away existing mock values like 'firstName: "John"'.
 *
 * Algorithm (Smart Reconciliation):
 * 1. Load existing mock file for the endpoint (from ./mocks, ./existing-mocks, or GitHub API).
 * 2. If existing mock exists:
 *    - For every field present in both existing mock AND updated schema:
 *      If the type/shape is still valid → PRESERVE the existing value!
 *    - For fields new to the schema → generate deterministic fake data.
 *    - For fields deleted from the schema → remove them to stay in sync.
 *    - For fields whose types changed incompatibly → re-generate with new type.
 * 3. If no existing mock exists → generate fresh mock using schema faker.
 *
 * Output:
 *   mocks/
 *     .automock-meta.json          ← sync metadata & diff stats
 *     endpoints/...                ← minimal-diff JSON fixtures
 *     msw-handlers.js              ← MSW v2 handlers
 * ─────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import * as yaml from 'js-yaml';
import jsf from 'json-schema-faker';

// ── Deterministic & Clean Config ─────────────────────────────────────────
jsf.option({
  alwaysFakeOptionals: true,
  useExamplesValue: true,
  useDefaultValue: true,
  fillProperties: false,       // only use explicitly defined schema properties
  maxItems: 2,
  maxLength: 40,
});

// ── Read openapi.yml ─────────────────────────────────────────────────────
const specPath = path.resolve('openapi.yml');
if (!fs.existsSync(specPath)) {
  console.error('❌ openapi.yml not found in working directory');
  process.exit(1);
}

const specRaw = fs.readFileSync(specPath, 'utf8');
const spec = yaml.load(specRaw);
const openapiHash = createHash('sha256').update(specRaw).digest('hex').slice(0, 40);

console.log(`📄 Loaded openapi.yml (hash: ${openapiHash})`);
console.log(`📋 Title: ${spec.info?.title || 'API'} v${spec.info?.version || '1.0.0'}`);

// ── Load Existing Mocks (Local or via GitHub API) ─────────────────────────
const outputDir = path.resolve('mocks');
const existingMocksDir = path.resolve('existing-mocks');

// Pre-fetch existing mocks map: Map<relativeFilePath, object>
const existingMocksCache = new Map();

async function initExistingMocks() {
  // 1. Check local existing-mocks/ directory
  if (fs.existsSync(existingMocksDir)) {
    console.log(`🔍 Loading existing mocks from local: ${existingMocksDir}`);
    loadMocksFromDisk(existingMocksDir, '');
    return;
  }

  // 2. Check local mocks/ directory (e.g. running inside frontend repo)
  if (fs.existsSync(outputDir)) {
    console.log(`🔍 Loading existing mocks from current output directory: ${outputDir}`);
    loadMocksFromDisk(outputDir, '');
    return;
  }

  // 3. Fallback: If running inside Kestra container and GitHub credentials provided
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.FRONTEND_REPO_OWNER;
  const repo = process.env.FRONTEND_REPO_NAME;
  const branch = process.env.FRONTEND_DEFAULT_BRANCH || 'main';

  if (token && owner && repo) {
    console.log(`🌐 Fetching existing mocks from GitHub: ${owner}/${repo}@${branch}...`);
    try {
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (treeRes.ok) {
        const treeData = await treeRes.json();
        const mockFiles = (treeData.tree || []).filter(
          (item) => (item.path.startsWith('mocks/endpoints/') || item.path.startsWith('src/__mocks__/endpoints/')) && item.path.endsWith('.json')
        );

        for (const file of mockFiles) {
          const contentRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}?ref=${branch}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
              },
            }
          );
          if (contentRes.ok) {
            const fileData = await contentRes.json();
            const jsonText = Buffer.from(fileData.content, 'base64').toString('utf8');
            const relKey = file.path.replace(/^(mocks\/|src\/__mocks__\/)/, '');
            existingMocksCache.set(relKey, JSON.parse(jsonText));
          }
        }
        console.log(`✅ Loaded ${existingMocksCache.size} existing mock files from GitHub.`);
      }
    } catch (err) {
      console.warn(`⚠️ Could not pre-fetch existing mocks from GitHub: ${err.message}`);
    }
  }
}

function loadMocksFromDisk(baseDir, currentRel) {
  const dir = path.join(baseDir, currentRel);
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      loadMocksFromDisk(baseDir, relPath);
    } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      try {
        const content = fs.readFileSync(path.join(baseDir, relPath), 'utf8');
        existingMocksCache.set(relPath, JSON.parse(content));
      } catch (e) {
        // skip malformed
      }
    }
  }
}

function getExistingMock(relPath) {
  return existingMocksCache.get(relPath) ?? null;
}

// ── Schema Resolution Helpers ────────────────────────────────────────────

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
    const merged = { type: 'object', properties: {} };
    for (const sub of schema.allOf) {
      const resolved = resolveSchema(sub, rootSpec, depth + 1);
      Object.assign(merged.properties, resolved.properties || {});
    }
    return merged;
  }

  if (schema.oneOf || schema.anyOf) {
    const options = schema.oneOf || schema.anyOf;
    return resolveSchema(options[0], rootSpec, depth + 1);
  }

  return schema;
}

// ── Smart Reconciliation (Minimum Changes) ───────────────────────────────

function isTypeCompatible(value, schema) {
  if (value === undefined || value === null) return false;

  const expectedType = schema.type;
  if (!expectedType) return true; // loose schema

  if (expectedType === 'string') {
    if (typeof value !== 'string') return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
    return true;
  }

  if (expectedType === 'integer' || expectedType === 'number') {
    if (typeof value !== 'number' || isNaN(value)) return false;
    if (expectedType === 'integer' && !Number.isInteger(value)) return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
    return true;
  }

  if (expectedType === 'boolean') {
    return typeof value === 'boolean';
  }

  if (expectedType === 'object') {
    return typeof value === 'object' && !Array.isArray(value);
  }

  if (expectedType === 'array') {
    return Array.isArray(value);
  }

  return true;
}

/**
 * Generates a mock value strictly adhering ONLY to declared schema properties.
 * Eliminates all random filler keys (e.g. eu4_, laborum_9d, etc.).
 */
async function generateCleanValue(schema, rootSpec) {
  const resolved = resolveSchema(schema, rootSpec);
  if (!resolved) return null;

  // Prefer explicit schema examples and defaults first
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];

  // Objects: strictly construct ONLY the declared properties
  if (resolved.type === 'object' || resolved.properties) {
    const properties = resolved.properties || {};
    const obj = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      obj[key] = await generateCleanValue(propSchema, rootSpec);
    }
    return obj;
  }

  // Arrays: generate 1-2 items strictly using the item schema
  if (resolved.type === 'array' || resolved.items) {
    const itemSchema = resolveSchema(resolved.items, rootSpec);
    if (!itemSchema) return [];
    return [
      await generateCleanValue(itemSchema, rootSpec),
      await generateCleanValue(itemSchema, rootSpec),
    ];
  }

  // Primitives: use jsf for realistic data (email, uuid, dates, etc.)
  try {
    return jsf.generate(resolved);
  } catch (err) {
    if (resolved.type === 'string') {
      if (resolved.format === 'uuid') return '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
      if (resolved.format === 'email') return 'user@example.com';
      if (resolved.format === 'date-time') return new Date().toISOString();
      return 'sample_value';
    }
    if (resolved.type === 'integer' || resolved.type === 'number') return 1;
    if (resolved.type === 'boolean') return true;
    return null;
  }
}

/**
 * Reconciles existing mock data with an updated schema.
 * - Preserves existing fields when unaffected (e.g. firstName).
 * - Generates new fields strictly from schema without random extra keys.
 * - Strips deleted fields to maintain contract integrity.
 */
async function reconcileWithExisting(existingData, schema, rootSpec, stats = { preserved: 0, added: 0, updated: 0 }) {
  const resolved = resolveSchema(schema, rootSpec);
  if (!resolved) return existingData ?? {};

  // Case 1: No prior mock exists -> generate strictly clean mock
  if (existingData === null || existingData === undefined) {
    stats.added++;
    return await generateCleanValue(resolved, rootSpec);
  }

  // Case 2: Object schemas
  if (resolved.type === 'object' || resolved.properties) {
    if (typeof existingData !== 'object' || Array.isArray(existingData)) {
      stats.updated++;
      return await generateCleanValue(resolved, rootSpec);
    }

    const properties = resolved.properties || {};
    const result = {};

    for (const [propKey, propSchema] of Object.entries(properties)) {
      const resolvedPropSchema = resolveSchema(propSchema, rootSpec);
      const hasExistingProp = Object.prototype.hasOwnProperty.call(existingData, propKey);

      if (hasExistingProp) {
        const existingVal = existingData[propKey];

        if (resolvedPropSchema.type === 'object' || resolvedPropSchema.properties) {
          result[propKey] = await reconcileWithExisting(existingVal, resolvedPropSchema, rootSpec, stats);
        } else if (resolvedPropSchema.type === 'array' || resolvedPropSchema.items) {
          result[propKey] = await reconcileWithExisting(existingVal, resolvedPropSchema, rootSpec, stats);
        } else if (isTypeCompatible(existingVal, resolvedPropSchema)) {
          // Unaffected field -> PRESERVE untouched!
          result[propKey] = existingVal;
          stats.preserved++;
        } else {
          // Type incompatible -> generate clean new
          result[propKey] = await generateCleanValue(resolvedPropSchema, rootSpec);
          stats.updated++;
        }
      } else {
        // New field added to openapi spec -> generate clean value
        result[propKey] = await generateCleanValue(resolvedPropSchema, rootSpec);
        stats.added++;
      }
    }

    return result;
  }

  // Case 3: Array schemas
  if (resolved.type === 'array' || resolved.items) {
    const itemSchema = resolveSchema(resolved.items, rootSpec);
    if (!itemSchema) return existingData;

    if (!Array.isArray(existingData) || existingData.length === 0) {
      stats.added++;
      return [
        await generateCleanValue(itemSchema, rootSpec),
        await generateCleanValue(itemSchema, rootSpec),
      ];
    }

    // Reconcile each item in existing array
    const reconciledArray = [];
    for (const item of existingData) {
      reconciledArray.push(await reconcileWithExisting(item, itemSchema, rootSpec, stats));
    }
    return reconciledArray;
  }

  // Case 4: Primitive types (string, number, boolean)
  if (isTypeCompatible(existingData, resolved)) {
    stats.preserved++;
    return existingData;
  }

  stats.updated++;
  return await generateCleanValue(resolved, rootSpec);
}

// ── Main Execution ────────────────────────────────────────────────────────

await initExistingMocks();

const endpointsDir = path.join(outputDir, 'endpoints');
fs.mkdirSync(endpointsDir, { recursive: true });

const mswHandlers = [];
const summary = [];
let totalPreserved = 0;
let totalAdded = 0;
let totalUpdated = 0;

const paths = spec.paths || {};

for (const [routePath, pathItem] of Object.entries(paths)) {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

  for (const method of methods) {
    const operation = pathItem[method];
    if (!operation) continue;

    const operationId = operation.operationId || `${method.toUpperCase()} ${routePath}`;
    const safePath = routePath.replace(/^\//, '').replace(/\//g, path.sep);
    const opDir = path.join(endpointsDir, safePath, method.toUpperCase());
    fs.mkdirSync(opDir, { recursive: true });

    const responses = operation.responses || {};

    for (const [statusCode, responseObj] of Object.entries(responses)) {
      const content = responseObj.content;
      let schema = null;
      if (content) {
        const jsonMedia = content['application/json'] || content['*/*'];
        if (jsonMedia?.schema) {
          schema = jsonMedia.schema;
        }
      }

      const fixtureName = `${statusCode}.json`;
      const fixturePath = path.join(opDir, fixtureName);
      const relativeMockKey = `endpoints/${routePath.replace(/^\//, '')}/${method.toUpperCase()}/${fixtureName}`.replace(/\\/g, '/');

      // Check for existing mock data to preserve unaffected fields
      const existingData = getExistingMock(relativeMockKey);
      const stats = { preserved: 0, added: 0, updated: 0 };

      let mockData = null;
      if (schema) {
        mockData = await reconcileWithExisting(existingData, schema, spec, stats);
      }

      totalPreserved += stats.preserved;
      totalAdded += stats.added;
      totalUpdated += stats.updated;

      fs.writeFileSync(fixturePath, JSON.stringify(mockData, null, 2));

      const statusIcon = existingData
        ? `🔄 preserved: ${stats.preserved}, added: ${stats.added}, updated: ${stats.updated}`
        : `✨ fresh: ${stats.added} fields`;

      console.log(`  ${method.toUpperCase()} ${routePath} [${statusCode}] → ${statusIcon}`);

      if (statusCode.startsWith('2')) {
        const mswPath = routePath.replace(/\{(\w+)\}/g, ':$1');
        mswHandlers.push({
          method: method.toUpperCase(),
          path: mswPath,
          status: parseInt(statusCode),
          fixture: `./endpoints${routePath.replace(/\//g, '/')}/${method.toUpperCase()}/${fixtureName}`,
          operationId,
        });
      }

      summary.push({
        method: method.toUpperCase(),
        path: routePath,
        status: statusCode,
        preserved: stats.preserved,
        added: stats.added,
        updated: stats.updated,
      });
    }
  }
}

// ── Write MSW v2 Handlers ─────────────────────────────────────────────────
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
 * Unaffected fields preserved. Only diffs generated.
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

// ── Write AutoMock Metadata with Diff Stats ───────────────────────────────
const meta = {
  generatedAt: new Date().toISOString(),
  openapiTitle: spec.info?.title,
  openapiVersion: spec.info?.version,
  openapiSha: openapiHash,
  stats: {
    preservedFields: totalPreserved,
    addedFields: totalAdded,
    updatedFields: totalUpdated,
  },
  endpointCount: Object.keys(paths).length,
  mockCount: summary.length,
};

fs.writeFileSync(path.join(outputDir, '.automock-meta.json'), JSON.stringify(meta, null, 2));

console.log(`\n🎉 Done! Summary: ${totalPreserved} fields preserved (minimal diff), ${totalAdded} added, ${totalUpdated} updated.`);

// ── Push to GitHub if TARGET_BRANCH and GITHUB_TOKEN are provided ───────────
async function pushAllMocksToGitHub(owner, repo, targetBranch, token) {
  const filesToUpload = [];

  function collectFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath);
      } else if (entry.isFile()) {
        const relPath = path.relative('.', fullPath).replace(/\\/g, '/');
        filesToUpload.push({ fullPath, relPath });
      }
    }
  }

  collectFiles(outputDir);
  console.log(`\n📤 Found ${filesToUpload.length} files to push to branch '${targetBranch}'...`);

  for (const file of filesToUpload) {
    const fileContent = fs.readFileSync(file.fullPath, 'utf8');
    const contentBase64 = Buffer.from(fileContent).toString('base64');

    let existingSha = undefined;
    try {
      const checkRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(file.relPath)}?ref=${encodeURIComponent(targetBranch)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        existingSha = checkData.sha;
      }
    } catch (e) {
      // not found, treat as new
    }

    const payload = {
      message: existingSha
        ? `chore(automock): update ${file.relPath} (minimal diff)`
        : `chore(automock): add ${file.relPath}`,
      content: contentBase64,
      branch: targetBranch,
    };
    if (existingSha) {
      payload.sha = existingSha;
    }

    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(file.relPath)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`Failed to upload ${file.relPath} to ${targetBranch}: HTTP ${putRes.status} -> ${errText}`);
    }

    console.log(`  ✅ Pushed ${file.relPath}`);
  }

  console.log(`🎉 All ${filesToUpload.length} mock files successfully committed to ${targetBranch}!`);
}

const targetBranch = process.env.TARGET_BRANCH;
const token = process.env.GITHUB_TOKEN;
const owner = process.env.FRONTEND_REPO_OWNER;
const repo = process.env.FRONTEND_REPO_NAME;

if (targetBranch && token && owner && repo) {
  console.log(`\n📤 Pushing generated mock files to branch: ${targetBranch}...`);
  await pushAllMocksToGitHub(owner, repo, targetBranch, token);
} else {
  console.log(`\nℹ️ TARGET_BRANCH or credentials not provided. Skipping GitHub push.`);
}

