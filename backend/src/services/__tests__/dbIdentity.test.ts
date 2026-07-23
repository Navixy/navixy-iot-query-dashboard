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

// MR !61 round 4 (note 56582): postgresql: is a NON-SPECIAL scheme to the WHATWG
// URL parser, so new URL() hands the hostname back as an opaque string — case,
// trailing root dot and numeric IPv4 shorthand all preserved (bracketed IPv6 is
// the one form the parser canonicalizes for every scheme). DNS and inet_aton
// collapse those spellings onto ONE endpoint, so before the fix each spelling
// minted its own pool key and its own 20/min rate-limit bucket.
describe('hostname canonicalization — DNS-equivalent spellings are one endpoint', () => {
  const key = (url: string) => settingsPoolKeyForUrl(url);

  it('folds hostname case: DNS is case-insensitive', () => {
    expect(key('postgresql://app:pw@DB.TENANT-A.EXAMPLE:5432/meta'))
      .toBe(key('postgresql://app:pw@db.tenant-a.example:5432/meta'));
    expect(key('postgresql://app:pw@Db.Tenant-A.Example:5432/meta'))
      .toBe(key('postgresql://app:pw@db.tenant-a.example:5432/meta'));
  });

  it('strips the trailing root dot: db.example. resolves exactly as db.example', () => {
    expect(key('postgresql://app:pw@db.tenant-a.example.:5432/meta'))
      .toBe(key('postgresql://app:pw@db.tenant-a.example:5432/meta'));
  });

  it('canonicalizes numeric IPv4 spellings the way inet_aton connects them', () => {
    const dotted = key('postgresql://app:pw@127.0.0.1:5432/meta');
    expect(key('postgresql://app:pw@127.1:5432/meta')).toBe(dotted); // short form
    expect(key('postgresql://app:pw@0x7f.0.0.1:5432/meta')).toBe(dotted); // hex part
    expect(key('postgresql://app:pw@0177.0.0.1:5432/meta')).toBe(dotted); // octal part
    expect(key('postgresql://app:pw@2130706433:5432/meta')).toBe(dotted); // 32-bit int
  });

  it('collapses IPv6 spellings and IPv4-mapped IPv6 onto the endpoint', () => {
    // Bracketed IPv6 arrives pre-canonicalized from new URL() for every scheme —
    // pinned here so a parser change cannot silently reopen the mint.
    expect(key('postgresql://app:pw@[0:0:0:0:0:0:0:1]:5432/meta'))
      .toBe(key('postgresql://app:pw@[::1]:5432/meta'));
    expect(key('postgresql://app:pw@[2001:DB8::5]:5432/meta'))
      .toBe(key('postgresql://app:pw@[2001:db8:0:0:0:0:0:5]:5432/meta'));
    // ::ffff:a.b.c.d reaches the IPv4 stack — one endpoint with the dotted quad.
    expect(key('postgresql://app:pw@[::ffff:127.0.0.1]:5432/meta'))
      .toBe(key('postgresql://app:pw@127.0.0.1:5432/meta'));
    expect(key('postgresql://app:pw@[::FFFF:10.0.0.7]:5432/meta'))
      .toBe(key('postgresql://app:pw@10.0.0.7:5432/meta'));
  });

  it('never folds what Postgres matches byte-for-byte: user and database case split', () => {
    const base = key('postgresql://app:pw@db.tenant-a.example:5432/meta');
    expect(key('postgresql://APP:pw@db.tenant-a.example:5432/meta')).not.toBe(base);
    expect(key('postgresql://app:pw@db.tenant-a.example:5432/META')).not.toBe(base);
  });

  it('leaves non-address numeric names alone — finer is always safe', () => {
    // 300 > 255 and five labels both fall outside inet_aton's grammar; they are
    // (dead) DNS names, not addresses, and keep their spelling.
    expect(key('postgresql://app:pw@300.0.0.1:5432/meta'))
      .toBe('settings:app@300.0.0.1:5432/meta');
    expect(key('postgresql://app:pw@1.2.3.4.5:5432/meta'))
      .toBe('settings:app@1.2.3.4.5:5432/meta');
    // A doubled trailing dot is not valid DNS either — distinct, untouched.
    expect(key('postgresql://app:pw@db.example..:5432/meta'))
      .toBe('settings:app@db.example..:5432/meta');
  });
});
