import { addDays, format } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { env } from '../config/env';
import { getAppConfig } from '../config/appConfig';
import {
  countScheduledOnDay,
  countUploadsOnDay,
  getUploadForDraft,
  insertUpload,
  listDrafts,
} from '../db/database';
import { audit, logger } from '../utils/logger';

/**
 * Local scheduling. POSTING_TIMES (e.g. "09:00,13:00,19:00") are interpreted
 * in the configured TIMEZONE and converted to UTC instants. The TikTok
 * Content Posting API has no native schedule-time for direct posts, so
 * `npm run upload` publishes drafts whose scheduled time has arrived.
 */

/** All future posting slots (UTC ISO) for the next `daysAhead` days. */
export function upcomingSlots(daysAhead = 7): string[] {
  const config = getAppConfig();
  const tz = env.TIMEZONE;
  const slots: string[] = [];
  const nowUtc = new Date();
  const todayInTz = toZonedTime(nowUtc, tz);

  for (let day = 0; day < daysAhead; day += 1) {
    const date = format(addDays(todayInTz, day), 'yyyy-MM-dd');
    for (const time of config.postingTimes) {
      const slotUtc = fromZonedTime(`${date} ${time}`, tz);
      if (slotUtc.getTime() > nowUtc.getTime()) {
        slots.push(slotUtc.toISOString());
      }
    }
  }
  return slots.sort();
}

/** Next free slot that respects the daily upload cap. Returns UTC ISO. */
export function previewNextSlot(): string | undefined {
  const config = getAppConfig();
  for (const slot of upcomingSlots(14)) {
    const day = slot.slice(0, 10);
    const used = countScheduledOnDay(day) + countUploadsOnDay(day);
    if (used < config.maxDailyUploads) return slot;
  }
  return undefined;
}

export interface ScheduleResult {
  scheduled: { draftId: number; scheduledAt: string }[];
  skipped: { draftId: number; reason: string }[];
}

/**
 * Assign posting slots to approved drafts that don't have one yet.
 * Respects MAX_DAILY_UPLOADS per calendar day.
 */
export function scheduleApprovedDrafts(): ScheduleResult {
  const config = getAppConfig();
  const result: ScheduleResult = { scheduled: [], skipped: [] };
  const approved = listDrafts({ status: 'approved' });

  if (!approved.length) {
    logger.warn('No approved drafts to schedule. Approve drafts with "npm run review -- --approve <id>".');
    return result;
  }

  // Track per-day usage as we assign so one run distributes across days.
  const usage = new Map<string, number>();
  const slots = upcomingSlots(30);

  for (const draft of approved) {
    const existing = getUploadForDraft(draft.id!);
    if (existing && existing.status === 'scheduled') {
      result.skipped.push({ draftId: draft.id!, reason: `already scheduled for ${existing.scheduledAt}` });
      continue;
    }
    if (existing && existing.status === 'uploaded') {
      result.skipped.push({ draftId: draft.id!, reason: 'already uploaded' });
      continue;
    }

    const slot = slots.find((s) => {
      const day = s.slice(0, 10);
      const used =
        (usage.get(day) ?? 0) + countScheduledOnDay(day) + countUploadsOnDay(day);
      return used < config.maxDailyUploads;
    });
    if (!slot) {
      result.skipped.push({ draftId: draft.id!, reason: 'no free slot in the next 30 days' });
      continue;
    }

    const day = slot.slice(0, 10);
    usage.set(day, (usage.get(day) ?? 0) + 1);
    slots.splice(slots.indexOf(slot), 1);

    insertUpload({
      draftId: draft.id!,
      privacyStatus: env.DEFAULT_PRIVACY_STATUS,
      status: 'scheduled',
      scheduledAt: slot,
    });
    result.scheduled.push({ draftId: draft.id!, scheduledAt: slot });
  }

  audit('info', 'Scheduling finished', {
    scheduled: result.scheduled.length,
    skipped: result.skipped.length,
  });
  return result;
}
