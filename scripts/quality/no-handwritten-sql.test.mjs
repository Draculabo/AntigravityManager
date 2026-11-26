import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const productionPath = 'src/modules/sql-guard-example.ts';
const auditInitializer = 'src/modules/proxy-gateway/audit/traffic-audit-database.ts';
const acceptanceScript = 'scripts/acceptance/accounts/credential-readback.mjs';

async function violations(source, filePath = productionPath) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.equal(result.fatalErrorCount, 0);
  return result.messages
    .filter((message) => message.ruleId === 'agm/no-handwritten-sql')
    .map(({ messageId }) => messageId);
}

test('SQLite reads and expressions use the Drizzle query builder', async () => {
  assert.deepEqual(
    await violations(`
      import { eq, sql as expression } from 'drizzle-orm';
      orm.select({ name: users.name, bytes: expression<number>\`length(\${users.name})\` })
        .from(users)
        .where(eq(users.id, id))
        .prepare();
    `),
    [],
  );
});

test('SQLite statements cannot bypass the Drizzle query builder through string methods', async () => {
  assert.deepEqual(
    await violations(`
      import Native from 'better-sqlite3';
      const sqlite = new Native(':memory:');
      const renamed = sqlite;
      const statement = 'SELECT name FROM users WHERE id = ?';
      connection.prepare<[number]>(statement);
      db.prepare(sqlStringIdentifier);
      db.exec(sqlStringIdentifier);
      orm.get('SELECT name FROM users');
      renamed.prepare(dynamicSql);
      sqlite.pragma('SELECT name FROM users');
    `),
    ['query', 'query', 'query', 'query', 'query', 'query'],
  );
});

test('Drizzle aliases and nested projections cannot execute handwritten SQL statements', async () => {
  assert.deepEqual(
    await violations(`
      import { sql as query } from 'drizzle-orm';
      import * as drizzle from 'drizzle-orm';
      const queryAlias = query;
      const queryText = query.raw(sourceText);
      drizzle.sql.raw(sourceText);
      queryAlias.raw(sourceText);
      orm.select({ user: query<number>\`(SELECT name FROM users)\` });
      orm.run(drizzle.sql\`DELETE FROM users\`);
      orm.run(query\`VALUES (1)\`);
    `),
    ['raw', 'raw', 'raw', 'query', 'query', 'query'],
  );
});

test('the historical initializer can execute its bundled migration assets', async () => {
  assert.deepEqual(
    await violations(
      `
        import migration from './migrations/v7-bootstrap.sql?raw';
        import unregistered from './migrations/another.sql?raw';
        db.exec(migration);
        db.prepare('VACUUM INTO ?').run(destination);
        db.pragma('user_version');
        db.exec(unregistered);
        db.exec(migration + '; DELETE FROM accounts');
        db.exec('ALTER TABLE accounts ADD COLUMN field TEXT');
        db.prepare('UPDATE accounts SET field = ?').run(value);
      `,
      auditInitializer,
    ),
    ['query', 'query', 'query', 'query'],
  );
  assert.deepEqual(
    await violations(`
      import migration from './migrations/v7-bootstrap.sql?raw';
      db.exec(migration);
    `),
    ['query'],
  );
});

test('scripts and test sources reject newly written SQL', async () => {
  for (const filePath of [
    'scripts/acceptance/example.mjs',
    'src/tests/unit/example.test.ts',
    'src/modules/example.spec.ts',
  ]) {
    assert.deepEqual(
      await violations("database.prepare('SELECT * FROM accounts').get();", filePath),
      ['query'],
    );
  }
});

test('existing scripts allow only the inventoried calls and occurrence counts', async () => {
  const existing = "database.prepare('SELECT email, token_json FROM accounts WHERE id = ?')";
  assert.deepEqual(await violations(existing, acceptanceScript), []);
  assert.deepEqual(await violations(`${existing}; ${existing};`, acceptanceScript), ['query']);
  assert.deepEqual(await violations(existing.replace('email, ', ''), acceptanceScript), ['query']);
});

test('the iterator can prepare Drizzle output but still rejects handwritten SQL', async () => {
  const compiledQuery = `
    const { sql, params } = query.toSQL();
    database.prepare<unknown[]>(sql).iterate(...params);
  `;
  assert.deepEqual(await violations(compiledQuery), ['query']);
  assert.deepEqual(
    await violations(
      compiledQuery + "database.prepare('SELECT * FROM accounts').iterate();",
      'src/shared/persistence/database/iterate-sqlite-query.ts',
    ),
    ['query'],
  );
});
