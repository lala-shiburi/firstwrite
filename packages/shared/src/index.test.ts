import { describe, expect, it } from 'vitest';
import {
  ianaTimezoneSchema,
  localDateSchema,
  localTimeSchema,
  registerRequestSchema,
  updateSettingsRequestSchema,
  upsertEntryRequestSchema,
} from './index.js';

describe('@firstwrite/shared schemas', () => {
  it('validates IANA timezones accurately', () => {
    expect(ianaTimezoneSchema.safeParse('Africa/Johannesburg').success).toBe(true);
    expect(ianaTimezoneSchema.safeParse('UTC').success).toBe(true);
    expect(ianaTimezoneSchema.safeParse('America/New_York').success).toBe(true);
    expect(ianaTimezoneSchema.safeParse('Not/A_Timezone').success).toBe(false);
    expect(ianaTimezoneSchema.safeParse('').success).toBe(false);
  });

  it('validates YYYY-MM-DD local dates', () => {
    expect(localDateSchema.safeParse('2026-11-15').success).toBe(true);
    expect(localDateSchema.safeParse('2026-11-15T00:00:00Z').success).toBe(false);
    expect(localDateSchema.safeParse('15-11-2026').success).toBe(false);
  });

  it('validates local times (HH:MM and HH:MM:SS)', () => {
    expect(localTimeSchema.safeParse('07:00').success).toBe(true);
    expect(localTimeSchema.safeParse('18:30:00').success).toBe(true);
    expect(localTimeSchema.safeParse('25:00').success).toBe(false);
  });

  it('validates registration and entry upsert payloads', () => {
    const validReg = registerRequestSchema.safeParse({
      email: 'writer@example.com',
      password: 'correct-horse-battery-staple',
      timezone: 'Africa/Johannesburg',
    });
    expect(validReg.success).toBe(true);

    const shortPw = registerRequestSchema.safeParse({
      email: 'writer@example.com',
      password: 'short',
    });
    expect(shortPw.success).toBe(false);

    const validEntry = upsertEntryRequestSchema.safeParse({
      content: 'Three pages of morning stream-of-consciousness thoughts.',
    });
    expect(validEntry.success).toBe(true);
  });

  it('rejects unknown properties on strict updateSettingsRequestSchema', () => {
    const res = updateSettingsRequestSchema.safeParse({
      dailyWordGoal: 1000,
      unexpectedField: true,
    });
    expect(res.success).toBe(false);
  });
});
