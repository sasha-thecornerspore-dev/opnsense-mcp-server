#!/usr/bin/env node
/**
 * Generates call-signatures.json: a table mapping "<module>.<method>" (and
 * "plugins.<submodule>.<method>") to that client method's positional parameter
 * names, in declaration order.
 *
 * Why this exists
 * ---------------
 * The generated client takes positional arguments — (data, config),
 * (uuid, config), (uuid, data, config), (uuid, enabled, data, config) and more.
 * The MCP dispatcher used to pass a single merged object as argument 1, so every
 * method with a positional uuid built a URL containing "[object Object]" and
 * OPNsense answered 200 with an empty body. See upstream issues #3, #4, #5, #10,
 * #11, #12, #14, #16, #17.
 *
 * Source of truth is the client's own shipped type declarations
 * (dist/index.d.ts), NOT its src/ — the published package ships only dist, so a
 * generator pointed at src/ produces an empty table and every call silently
 * falls through to the broken path.
 *
 * Re-run after upgrading @richard-stovall/opnsense-typescript-client:
 *   yarn generate-call-signatures
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DTS = path.join(
  __dirname,
  '..',
  'node_modules',
  '@richard-stovall',
  'opnsense-typescript-client',
  'dist',
  'index.d.ts'
);
const OUT_FILE = path.join(__dirname, '..', 'call-signatures.json');

/** Split on commas that are not nested inside <>, (), {} or []. */
function splitTopLevel(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of params) {
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** "uuid?: string" -> "uuid" */
function parseParams(params: string): string[] {
  if (!params.trim()) return [];
  return splitTopLevel(params)
    .map((p) => p.trim().split(':')[0].replace('?', '').trim())
    .filter(Boolean);
}

/** Extract the body of `declare class <Name> {` ... matching `}` by brace depth. */
function classBody(source: string, className: string): string | null {
  const re = new RegExp(`declare class ${className.replace(/\$/g, '\\$')}\\b[^{]*\\{`);
  const m = re.exec(source);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

/** Method declarations that return the client's ApiResponse envelope. */
const METHOD_RE = /^[ \t]+([a-zA-Z_$][\w$]*)\(([\s\S]*?)\):\s*Promise</gm;

function methodsOf(source: string, className: string): Record<string, string[]> {
  const body = classBody(source, className);
  const out: Record<string, string[]> = {};
  if (!body) return out;
  for (const m of body.matchAll(METHOD_RE)) {
    const [, name, params] = m;
    if (name === 'constructor') continue;
    out[name] = parseParams(params);
  }
  return out;
}

const dts = fs.readFileSync(DTS, 'utf8');
const clientBody = classBody(dts, 'OPNsenseClient');
if (!clientBody) {
  console.error('FATAL: could not locate `declare class OPNsenseClient` in', DTS);
  process.exit(1);
}

const signatures: Record<string, string[]> = {};
let moduleCount = 0;

// Top-level modules: `readonly trafficshaper: TrafficshaperApi;`
for (const m of clientBody.matchAll(/readonly\s+([a-zA-Z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*;/g)) {
  const [, prop, cls] = m;
  const methods = methodsOf(dts, cls);
  if (Object.keys(methods).length === 0) continue;
  for (const [name, params] of Object.entries(methods)) signatures[`${prop}.${name}`] = params;
  moduleCount++;
}

// Plugins live in an inline object literal: `readonly plugins: { acmeclient: AcmeclientApi; ... }`
const pluginsBlock = /readonly\s+plugins\s*:\s*\{([\s\S]*?)\n[ \t]*\};/.exec(clientBody);
if (pluginsBlock) {
  for (const m of pluginsBlock[1].matchAll(/([a-zA-Z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*;/g)) {
    const [, prop, cls] = m;
    const methods = methodsOf(dts, cls);
    if (Object.keys(methods).length === 0) continue;
    for (const [name, params] of Object.entries(methods)) {
      signatures[`plugins.${prop}.${name}`] = params;
    }
    moduleCount++;
  }
}

const total = Object.keys(signatures).length;
if (total === 0) {
  console.error('FATAL: parsed 0 signatures — refusing to write an empty table.');
  console.error('The dispatcher falls back to single-object dispatch when a key is missing,');
  console.error('which is the bug this table exists to fix. Check the client version/layout.');
  process.exit(1);
}

fs.writeFileSync(OUT_FILE, JSON.stringify(signatures, null, 2) + '\n');
console.error(`Wrote ${OUT_FILE}`);
console.error(`  ${total} method signatures across ${moduleCount} modules`);
