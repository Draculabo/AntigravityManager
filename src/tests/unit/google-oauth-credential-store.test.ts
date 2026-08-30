import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeGoogleOAuthCredentials } from '@/modules/cloud-account/persistence/googleOAuthCredentialStore';

describe('writeGoogleOAuthCredentials', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-oauth-store-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('writes the OAuth cache in the Gemini CLI wire format', () => {
    writeGoogleOAuthCredentials(
      {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_timestamp: 1_900_000_000,
        id_token: 'id-token',
        email: 'active@example.com',
      },
      { geminiDir: workDir },
    );

    expect(JSON.parse(fs.readFileSync(path.join(workDir, 'oauth_creds.json'), 'utf-8'))).toEqual({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expiry_date: 1_900_000_000_000,
      id_token: 'id-token',
      scope: [
        'openid',
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
        'https://www.googleapis.com/auth/aicode',
      ].join(' '),
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, 'google_accounts.json'), 'utf-8')),
    ).toEqual({
      active: 'active@example.com',
      old: [],
    });
    expect(fs.readdirSync(workDir).sort()).toEqual(['google_accounts.json', 'oauth_creds.json']);
  });

  it('moves the previous active account into old without duplicates', () => {
    fs.writeFileSync(
      path.join(workDir, 'google_accounts.json'),
      JSON.stringify({
        active: 'previous@example.com',
        old: ['older@example.com', 'active@example.com'],
      }),
    );

    writeGoogleOAuthCredentials(
      {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_timestamp: 1_900_000_000,
        email: 'active@example.com',
      },
      { geminiDir: workDir },
    );

    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, 'google_accounts.json'), 'utf-8')),
    ).toEqual({
      active: 'active@example.com',
      old: ['older@example.com', 'previous@example.com'],
    });
  });

  it('does not replace either credential file when the account index is malformed', () => {
    const oauthPath = path.join(workDir, 'oauth_creds.json');
    const accountsPath = path.join(workDir, 'google_accounts.json');
    fs.writeFileSync(oauthPath, 'previous oauth');
    fs.writeFileSync(accountsPath, '{not json');

    expect(() =>
      writeGoogleOAuthCredentials(
        {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expiry_timestamp: 1_900_000_000,
          email: 'active@example.com',
        },
        { geminiDir: workDir },
      ),
    ).toThrow(/google_accounts\.json/i);

    expect(fs.readFileSync(oauthPath, 'utf-8')).toBe('previous oauth');
    expect(fs.readFileSync(accountsPath, 'utf-8')).toBe('{not json');
  });
});
