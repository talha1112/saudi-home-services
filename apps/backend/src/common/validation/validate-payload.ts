import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { badRequestWith } from '../errors/api-error.js';

/**
 * Validates a payload that did not come through the HTTP ValidationPipe (a WebSocket message).
 * Same rules as the global pipe: unknown properties are rejected, nothing is echoed back
 * except the names of the fields that failed (a message may hold private text or coordinates).
 */
export function validatePayload<T extends object>(type: new () => T, raw: unknown): T {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequestWith('VALIDATION_FAILED', 'The payload must be an object', { fields: [] });
  }
  const instance = plainToInstance(type, raw, { enableImplicitConversion: false });
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    throw badRequestWith('VALIDATION_FAILED', 'The payload is not valid', { fields: errors.map((e) => e.property) });
  }
  return instance;
}
