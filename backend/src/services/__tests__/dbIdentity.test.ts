import { describe, it, expect } from '@jest/globals';
import { parsePostgresUrl, settingsPoolKey, settingsPoolKeyForUrl } from '../dbIdentity.js';
import { CustomError } from '../../middleware/errorHandler.js';

// The canonical settings-DB identity (MR !61 round 3, note 56573). These tests pin
// the contract at its construction site; chatStore.memory.test.ts pins the same
// properties through tenantKeyFor, the never-throw consumer on the rate-limit path.
// The pool cache in DatabaseService.getClientSettingsPool consumes settingsPoolKey
// directly — one construction site, so pool key and tenant key cannot drift.

describe('settingsPoolKeyForUrl — one identity per physical database', () => {
  const base = 'postgresql://app:pw@db.tenant-a.example:5432/meta';

  it('is the normalized user@host:port/database, never the password', () => {
    const key = settingsPoolKeyForUrl(base);
    expect(key).toBe('settings:app@db.tenant-a.example:5432/meta');
    expect(key).not.toContain('pw');
  });

  it('drops query parameters — application_name spellings collapse (the bypass)', () => {
    expect(settingsPoolKeyForUrl(`${base}?application_name=1`)).toBe(settingsPoolKeyForUrl(base));
    expect(settingsPoolKeyForUrl(`${base}?application_name=2`)).toBe(settingsPoolKeyForUrl(base));
    expect(settingsPoolKeyForUrl(`${base}?sslmode=require`)).toBe(settingsPoolKeyForUrl(base));
  });

  it('ignores the password — rotation keeps the identity (as the pool cache does)', () => {
    expect(settingsPoolKeyForUrl('postgresql://app:new-pw@db.tenant-a.example:5432/meta'))
      .toBe(settingsPoolKeyForUrl(base));
  });

  it('applies the same host/port normalization the pool uses', () => {
    // Outside Docker localhost → 127.0.0.1; jest runs outside Docker.
    expect(settingsPoolKeyForUrl('postgresql://app:pw@localhost:5432/meta'))
      .toBe(settingsPoolKeyForUrl('postgresql://app:pw@127.0.0.1:5432/meta'));
    expect(settingsPoolKeyForUrl('postgresql://app:pw@db.tenant-a.example/meta')).toBe(
      settingsPoolKeyForUrl('postgresql://app:pw@db.tenant-a.example:5432/meta'),
    );
  });

  it('splits on user, host and database — real tenants stay isolated', () => {
    const key = settingsPoolKeyForUrl(base);
    expect(settingsPoolKeyForUrl('postgresql://other:pw@db.tenant-a.example:5432/meta')).not.toBe(key);
    expect(settingsPoolKeyForUrl('postgresql://app:pw@db.tenant-b.example:5432/meta')).not.toBe(key);
    expect(settingsPoolKeyForUrl('postgresql://app:pw@db.tenant-a.example:5432/other')).not.toBe(key);
  });

  it('throws CustomError 400 on unparseable input, like parsePostgresUrl always has', () => {
    expect(() => settingsPoolKeyForUrl('not-a-postgres-url')).toThrow(CustomError);
    try {
      settingsPoolKeyForUrl('not-a-postgres-url');
    } catch (e) {
      expect((e as CustomError).statusCode).toBe(400);
    }
  });
});

describe('settingsPoolKey — the template DatabaseService keys its pool cache with', () => {
  it('formats settings:user@host:port/database from a parsed config', () => {
    const config = parsePostgresUrl('postgresql://app:pw@db.tenant-a.example:6432/meta');
    expect(settingsPoolKey(config)).toBe('settings:app@db.tenant-a.example:6432/meta');
  });
});
