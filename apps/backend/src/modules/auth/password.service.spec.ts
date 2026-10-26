import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await service.hash('correct horse battery 9');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse');
    expect(await service.verify(hash, 'correct horse battery 9')).toBe(true);
    expect(await service.verify(hash, 'wrong password 123')).toBe(false);
  });

  it('salts: the same password hashes differently', async () => {
    expect(await service.hash('same-password-123')).not.toBe(await service.hash('same-password-123'));
  });

  it('treats a malformed stored hash as a failed check, not a crash', async () => {
    expect(await service.verify('not-a-hash', 'whatever12345')).toBe(false);
  });

  it.each([
    ['short1!', 'at least 12'],
    ['onlylettershereonly', 'mix letters'],
    ['123456789012345', 'mix letters'],
    ['aaaaaaaaaaaa1', 'repetitive'],
    ['x'.repeat(129) + '1', 'at most 128'],
  ])('rejects the weak password %s', (password, message) => {
    expect(() => service.assertAcceptable(password)).toThrow(message);
  });

  it('rejects a password containing the email name', () => {
    expect(() => service.assertAcceptable('Johnsmith-2026-ok', { email: 'johnsmith@example.com' })).toThrow('email');
  });

  it('accepts a good password', () => {
    expect(() => service.assertAcceptable('tr0ub4dor&three-horses')).not.toThrow();
  });
});
