import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WINDOWS_ARCHES = ['x64', 'arm64'];

function listFilesRecursive(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const entries = readdirSync(rootDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(entryPath);
    }

    if (entry.isFile()) {
      return [entryPath];
    }

    return [];
  });
}

function findRequiredFile(files, predicate, label) {
  const file = files.find(predicate);
  if (!file) {
    throw new Error(`Missing ${label}`);
  }

  return file;
}

function hasPathSegment(filePath, segment) {
  return filePath.split(/[\\/]+/).includes(segment);
}

function parseArgs(argv) {
  const result = {
    releaseTag: process.env.RELEASE_TAG,
    repository: process.env.GITHUB_REPOSITORY,
    sourceDir: 'release-assets',
    outputDir: 'windows-update-feed',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--source') {
      result.sourceDir = value;
      index += 1;
    } else if (arg === '--output') {
      result.outputDir = value;
      index += 1;
    } else if (arg === '--release-tag') {
      result.releaseTag = value;
      index += 1;
    } else if (arg === '--repository') {
      result.repository = value;
      index += 1;
    }
  }

  return result;
}

function getPackageFileName(value) {
  if (URL.canParse(value)) {
    return path.basename(new URL(value).pathname);
  }

  return path.basename(value);
}

function getReleaseAssetBaseUrl({ releaseTag, repository }) {
  if (!releaseTag) {
    throw new Error('Missing release tag for Windows update feed package URLs');
  }

  if (!repository) {
    throw new Error('Missing GitHub repository for Windows update feed package URLs');
  }

  return `https://github.com/${repository}/releases/download/${releaseTag}`;
}

function rewriteReleasePackageUrls({ content, packages, releaseAssetBaseUrl }) {
  const packageNames = new Set(packages.map((file) => path.basename(file)));
  let replacementCount = 0;

  const rewritten = content
    .split('\n')
    .map((line) => {
      const match = line.match(/^([0-9a-fA-F]{40}\s+)(\S+)(\s+\d+(?:\s+#.*)?\r?)$/);
      if (!match) {
        return line;
      }

      const packageFileName = getPackageFileName(match[2]);
      if (!packageNames.has(packageFileName)) {
        return line;
      }

      replacementCount += 1;
      const packageUrl = `${releaseAssetBaseUrl}/${encodeURIComponent(packageFileName)}`;
      return `${match[1]}${packageUrl}${match[3]}`;
    })
    .join('\n');

  if (replacementCount === 0) {
    throw new Error('Windows RELEASES file does not reference any matching .nupkg package');
  }

  return rewritten;
}

export function prepareWindowsUpdateFeed({
  releaseTag,
  repository,
  sourceDir = 'release-assets',
  outputDir = 'windows-update-feed',
} = {}) {
  const files = listFilesRecursive(sourceDir);
  const releaseAssetBaseUrl = getReleaseAssetBaseUrl({ releaseTag, repository });
  const result = {};

  rmSync(outputDir, { recursive: true, force: true });

  for (const arch of WINDOWS_ARCHES) {
    const releases = findRequiredFile(
      files,
      (file) => path.basename(file) === 'RELEASES' && hasPathSegment(file, arch),
      `Windows ${arch} RELEASES file`,
    );
    const packages = files.filter(
      (file) => file.endsWith('-full.nupkg') && hasPathSegment(file, arch),
    );
    if (packages.length === 0) {
      throw new Error(`Missing Windows ${arch} full .nupkg package`);
    }

    const targetDir = path.join(outputDir, 'win32', arch);
    mkdirSync(targetDir, { recursive: true });

    const targetReleases = path.join(targetDir, 'RELEASES');
    const rewrittenReleases = rewriteReleasePackageUrls({
      content: readFileSync(releases, 'utf8'),
      packages,
      releaseAssetBaseUrl,
    });
    writeFileSync(targetReleases, rewrittenReleases);

    result[arch] = {
      releases: targetReleases,
      packages: packages.map((file) => path.basename(file)),
    };
  }

  return result;
}

function runCli() {
  const result = prepareWindowsUpdateFeed(parseArgs(process.argv.slice(2)));
  for (const [arch, files] of Object.entries(result)) {
    console.log(`Prepared win32/${arch}: ${files.releases}, ${files.packages.length} package(s)`);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  runCli();
}
