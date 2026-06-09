const PACKAGE_ALLOWED_ROOT_ENTRIES = [
  '.vite',
  'dist',
  'images',
  'node_modules',
  'package.json',
  'resources',
] as const;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const allowedRootPattern = PACKAGE_ALLOWED_ROOT_ENTRIES.map((entry) => escapeRegExp(entry)).join(
  '|',
);

const PACKAGE_PRUNE_NODE_MODULES = [
  '@apm-js-collab/code-transformer',
  '@esbuild/win32-x64',
  '@icons-pack/react-simple-icons',
  '@radix-ui/react-avatar',
  '@radix-ui/react-checkbox',
  '@radix-ui/react-dialog',
  '@radix-ui/react-dropdown-menu',
  '@radix-ui/react-icons',
  '@radix-ui/react-label',
  '@radix-ui/react-navigation-menu',
  '@radix-ui/react-popover',
  '@radix-ui/react-portal',
  '@radix-ui/react-presence',
  '@radix-ui/react-primitive',
  '@radix-ui/react-select',
  '@radix-ui/react-slot',
  '@radix-ui/react-switch',
  '@radix-ui/react-tabs',
  '@radix-ui/react-toast',
  '@radix-ui/react-toggle',
  '@radix-ui/react-toggle-group',
  '@radix-ui/react-tooltip',
  '@radix-ui/react-use-callback-ref',
  '@radix-ui/react-use-controllable-state',
  '@radix-ui/react-use-effect-event',
  '@radix-ui/react-use-escape-keydown',
  '@radix-ui/react-use-layout-effect',
  '@radix-ui/react-use-rect',
  '@radix-ui/react-use-size',
  '@radix-ui/rect',
  '@rollup/rollup-win32-x64-gnu',
  '@rollup/rollup-win32-x64-msvc',
  '@tanstack/history',
  '@tanstack/query-core',
  '@tanstack/react-query',
  '@tanstack/react-router',
  '@tanstack/react-router-devtools',
  '@tanstack/router-core',
  '@tanstack/router-devtools-core',
  '@tanstack/router-generator',
  '@tanstack/router-plugin',
  '@tanstack/router-utils',
  '@tanstack/store',
  '@tanstack/virtual-file-routes',
  'code-inspector-plugin',
  'date-fns',
  'esbuild',
  'i18next-browser-languagedetector',
  'lucide-react',
  'react',
  'react-dom',
  'react-i18next',
  'rollup',
] as const;

const packagePruneNodeModulesPattern = new RegExp(
  `^/node_modules/(?:${PACKAGE_PRUNE_NODE_MODULES.map((entry) => escapeRegExp(entry)).join('|')})(?:/|$)`,
);

export const packageRootAllowlistIgnorePattern = new RegExp(
  `^/(?!(${allowedRootPattern})(?:/|$))[^/]+(?:/|$)`,
);

export const packageIgnorePatterns = [
  packageRootAllowlistIgnorePattern,
  /^\/node_modules\/\.cache(?:\/|$)/,
  // Source maps are uploaded to Sentry during build and should not ship in the app payload.
  /^\/.*\.map$/,
  packagePruneNodeModulesPattern,
];

export function shouldIgnorePackagePath(packagePath: string) {
  const normalizedPath = packagePath.replace(/\\/g, '/');
  const rootedPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;

  return packageIgnorePatterns.some((pattern) => pattern.test(rootedPath));
}
