import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.cwd();

function resolveCandidate(filePath) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  const exts = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
  for (const ext of exts) {
    const candidate = filePath + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'keytar') {
    const mock = path.resolve(root, 'src/mocks/empty.ts');
    return nextResolve(pathToFileURL(mock).href, context);
  }
  if (specifier.startsWith('@/')) {
    const full = path.resolve(root, 'src', specifier.slice(2));
    const resolved = resolveCandidate(full) || full;
    return nextResolve(pathToFileURL(resolved).href, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (context.parentURL && (specifier.startsWith('.') || specifier.startsWith('/'))) {
      let baseDir = root;
      try {
        baseDir = path.dirname(fileURLToPath(context.parentURL));
      } catch {
        // Fall back to project root
      }
      const target = specifier.startsWith('/')
        ? path.resolve(root, '.' + specifier)
        : path.resolve(baseDir, specifier);
      const resolved = resolveCandidate(target);
      if (resolved) {
        return nextResolve(pathToFileURL(resolved).href, context);
      }
    }
    throw err;
  }
}

import esbuild from 'esbuild';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.tsx') || url.endsWith('.jsx')) {
    const filePath = fileURLToPath(url);
    const code = fs.readFileSync(filePath, 'utf8');
    const transformed = esbuild.transformSync(code, {
      loader: url.endsWith('.tsx') ? 'tsx' : 'jsx',
      format: 'esm',
      sourcefile: filePath,
      jsx: 'automatic',
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: transformed.code,
    };
  }
  return nextLoad(url, context);
}
