import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['0501234567', '+966501234567'],
    ['050 123 4567', '+966501234567'],
    ['+966501234567', '+966501234567'],
    ['00966501234567', '+966501234567'],
    ['966501234567', '+966501234567'],
    ['+966 50-123-4567', '+966501234567'],
    ['+447911123456', '+447911123456'],
  ])('normalises %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '12345', '+966123', '0401234567', '+1', '05012345678901234567890'])('rejects %s', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(501234567 as unknown)).toBeNull();
  });

  it('uses the configured default region for national numbers', () => {
    expect(normalizePhone('07911123456', 'GB')).toBe('+447911123456');
  });
});
