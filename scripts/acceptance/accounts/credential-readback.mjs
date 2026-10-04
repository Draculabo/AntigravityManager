import path from 'node:path';

/** Read the selected official store and the private expected account without exporting secrets. */
export function createCredentialReadback({ library, Database, config, home }) {
  return {
    async readTarget(target) {
      const executablePath =
        target === 'classic' ? config.antigravity_executable : config.antigravity_ide_executable;
      const storage = await library.resolveClientAccountStorage(target, { executablePath });
      if (storage !== 'sqlite') {
        return library.readClientAccountToken(target);
      }
      const database = new Database(
        path.join(home, `client-${target}/User/globalStorage/state.vscdb`),
        { readonly: true },
      );
      try {
        const row = database
          .prepare('SELECT value FROM ItemTable WHERE key = ?')
          .get('antigravityUnifiedStateSync.oauthToken');
        return row
          ? library.ProtobufUtils.extractOAuthTokenDetailsFromUnifiedState(
              Buffer.from(row.value, 'base64'),
            )
          : null;
      } finally {
        database.close();
      }
    },
    async expectedAccount(id) {
      const database = new Database(path.join(home, '.antigravity-agent/cloud_accounts.db'), {
        readonly: true,
      });
      try {
        const row = database.prepare('SELECT email, token_json FROM accounts WHERE id = ?').get(id);
        return { email: row.email, token: JSON.parse(row.token_json) };
      } finally {
        database.close();
      }
    },
  };
}
