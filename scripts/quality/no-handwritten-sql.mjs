import { createHash } from 'node:crypto';
import path from 'node:path';
import existingSql from './existing-sql.json' with { type: 'json' };

const queryMethods = new Set(['all', 'exec', 'get', 'pragma', 'prepare', 'run', 'values']);
const statements =
  /\b(?:SELECT\s+|WITH\s+(?:RECURSIVE\s+)?[\w"]+\s+AS\b|(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\b|UPDATE\s+[^;]+?\s+SET\b|DELETE\s+FROM\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|INDEX)\b|CREATE\s+(?:(?:TEMP|TEMPORARY|UNIQUE)\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\b|EXPLAIN\s+|PRAGMA\s+|VACUUM\b)/i;
const standaloneStatement =
  /^\s*(?:\(\s*)*(?:VALUES\s*\(|(?:ANALYZE|ATTACH|BEGIN|COMMIT|DETACH|REINDEX|RELEASE|ROLLBACK|SAVEPOINT)\b)/i;
const driverStatement = /^(?:VACUUM(?:\s+INTO\s+\?)?|PRAGMA\s+[\w()=\s]+)\s*;?$/i;
const auditInitializer = 'src/modules/proxy-gateway/audit/traffic-audit-database.ts';
const auditMigrations = new Set([
  './migrations/v5-attempt-usage.sql?raw',
  './migrations/v6-attempt-identity.sql?raw',
  './migrations/v7-attempt-timing.sql?raw',
  './migrations/v7-bootstrap.sql?raw',
]);
const streamingAdapter = 'src/shared/persistence/database/iterate-sqlite-query.ts';

function memberName(node) {
  if (node.type !== 'MemberExpression') {
    return undefined;
  }
  if (node.computed) {
    return node.property.type === 'Literal' ? node.property.value : undefined;
  }
  return node.property.name;
}

function findDefinition(sourceCode, node) {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) {
      return variable.defs.length === 1 ? variable.defs[0] : undefined;
    }
  }
  return undefined;
}

function importSource(definition) {
  return definition?.type === 'ImportBinding' ? definition.parent.source.value : undefined;
}

function constInitializer(definition) {
  return definition?.type === 'Variable' && definition.parent.kind === 'const'
    ? definition.node.init
    : undefined;
}

function isDrizzleImport(definition) {
  return /^drizzle-orm(?:\/|$)/.test(importSource(definition) ?? '');
}

function isDrizzleSql(sourceCode, node, visited = new Set()) {
  if (!node || visited.has(node)) {
    return false;
  }
  visited.add(node);
  if (node.type === 'Identifier') {
    const definition = findDefinition(sourceCode, node);
    return (
      (isDrizzleImport(definition) && definition.node.imported?.name === 'sql') ||
      isDrizzleSql(sourceCode, constInitializer(definition), visited)
    );
  }
  if (memberName(node) === 'sql' && node.object.type === 'Identifier') {
    const definition = findDefinition(sourceCode, node.object);
    return isDrizzleImport(definition) && definition.node.type === 'ImportNamespaceSpecifier';
  }
  return false;
}

function textOf(node, sourceCode, visited = new Set()) {
  if (!node || visited.has(node)) {
    return '';
  }
  visited.add(node);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? node.value : '';
    case 'TemplateLiteral':
      return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join(' ? ');
    case 'TaggedTemplateExpression':
      return textOf(node.quasi, sourceCode, visited);
    case 'BinaryExpression':
      if (node.operator === '+') {
        const left = textOf(node.left, sourceCode, visited);
        const right = textOf(node.right, sourceCode, visited);
        return (left || '?') + (right || '?');
      }
      return '';
    case 'Identifier': {
      const definition = findDefinition(sourceCode, node);
      return textOf(constInitializer(definition), sourceCode, visited);
    }
    default:
      return '';
  }
}

function isAuditMigration(sourceCode, argument) {
  if (argument.type !== 'Identifier') {
    return false;
  }
  const definition = findDefinition(sourceCode, argument);
  return (
    definition?.node.type === 'ImportDefaultSpecifier' &&
    auditMigrations.has(importSource(definition))
  );
}

function isSqlStatement(text) {
  return statements.test(text) || standaloneStatement.test(text);
}

function isDatabaseReceiver(sourceCode, node, visited = new Set()) {
  if (!node || visited.has(node)) {
    return false;
  }
  visited.add(node);
  const name = node.type === 'Identifier' ? node.name : memberName(node);
  if (typeof name === 'string' && /^(?:db|database|raw|connection|orm|\$client)$/i.test(name)) {
    return true;
  }
  if (node.type === 'Identifier') {
    const definition = findDefinition(sourceCode, node);
    return isDatabaseReceiver(sourceCode, constInitializer(definition), visited);
  }
  if (node.type === 'NewExpression' && node.callee.type === 'Identifier') {
    const module = importSource(findDefinition(sourceCode, node.callee));
    return module === 'better-sqlite3' || module === 'node:sqlite';
  }
  return false;
}

function isCompiledQuery(sourceCode, argument) {
  if (argument.type !== 'Identifier') {
    return false;
  }
  const definition = findDefinition(sourceCode, argument);
  const declaration = definition?.node;
  return (
    definition?.type === 'Variable' &&
    definition.parent.kind === 'const' &&
    declaration.id.type === 'ObjectPattern' &&
    declaration.id.properties.some(
      (property) =>
        property.type === 'Property' &&
        !property.computed &&
        property.key.name === 'sql' &&
        property.value.name === argument.name,
    ) &&
    declaration.init?.type === 'CallExpression' &&
    memberName(declaration.init.callee) === 'toSQL' &&
    declaration.init.arguments.length === 0
  );
}

export const noHandwrittenSql = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      query: 'Use the Drizzle query builder for SQLite statements.',
      raw: 'Bind values and use typed Drizzle columns in SQLite expressions.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const filename = path.relative(context.cwd, context.physicalFilename).split(path.sep).join('/');
    const remaining = new Map(Object.entries(existingSql[filename] ?? {}));
    const report = (node, messageId) => {
      if (remaining.size > 0) {
        const fingerprint = createHash('sha256')
          .update(sourceCode.getText(node).replace(/\r\n/g, '\n'))
          .digest('hex');
        const available = remaining.get(fingerprint) ?? 0;
        if (available > 0) {
          if (available === 1) {
            remaining.delete(fingerprint);
          } else {
            remaining.set(fingerprint, available - 1);
          }
          return;
        }
      }
      context.report({ node, messageId });
    };
    return {
      MemberExpression(node) {
        if (memberName(node) === 'raw' && isDrizzleSql(sourceCode, node.object)) {
          report(node, 'raw');
        }
      },
      TaggedTemplateExpression(node) {
        if (isDrizzleSql(sourceCode, node.tag) && isSqlStatement(textOf(node.quasi, sourceCode))) {
          report(node, 'query');
        }
      },
      CallExpression(node) {
        const method = memberName(node.callee);
        const argument = node.arguments[0];
        if (!queryMethods.has(method) || !argument) {
          return;
        }
        const text = textOf(argument, sourceCode).trim();
        if (
          argument.type === 'TaggedTemplateExpression' &&
          isDrizzleSql(sourceCode, argument.tag) &&
          isSqlStatement(text)
        ) {
          return;
        }
        const databaseReceiver = isDatabaseReceiver(sourceCode, node.callee.object);
        const rawPrepare =
          method === 'prepare' && (databaseReceiver || node.typeArguments !== undefined);
        const rawExec = method === 'exec' && databaseReceiver;
        if (
          (rawPrepare ||
            rawExec ||
            statements.test(text) ||
            (databaseReceiver && standaloneStatement.test(text))) &&
          !driverStatement.test(text) &&
          !(rawPrepare && filename === streamingAdapter && isCompiledQuery(sourceCode, argument)) &&
          !(
            method === 'exec' &&
            filename === auditInitializer &&
            isAuditMigration(sourceCode, argument)
          )
        ) {
          report(node, 'query');
        }
      },
    };
  },
};
