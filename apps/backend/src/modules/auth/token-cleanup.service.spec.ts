import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { buildAuthServices } from '../../testing/harness.js';
import { testConfigService } from '../../testing/test-support.js';
import { TokenCleanupService } from './token-cleanup.service.js';

describe('TokenCleanupService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is disabled in the test environment (no timers are created)', () => {
    const { sessions } = buildAuthServices();
    const service = new TokenCleanupService(testConfigService(), sessions);
    const spy = jest.spyOn(globalThis, 'setInterval');
    service.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('swallows and logs failures instead of crashing the process', async () => {
    const { sessions } = buildAuthServices();
    jest.spyOn(sessions, 'purgeStale').mockRejectedValue(new Error('db down'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(new TokenCleanupService(testConfigService(), sessions).run()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
