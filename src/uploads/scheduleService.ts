import { addDays, format } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { env } from '../config/env';
import { getAppConfig } from '../config/appConfig';
import {
  getUploadForDraft,
  insertUpload,
  listDrafts,
  listUploads,
} from '../db/database';
import { audit, logger } from '../utils/logger';

/**
 * Local scheduling. POSTING_TIMES (e.g. "09:00,13:00,19:00") are interpreted
 * in the configured TIMEZONE and converted to UTC instants. The TikTok
 * Content Posting API has no native schedule-time for direct posts, so
 * `npm run upload` publishes drafts whose scheduled time has arrived.
 *
 * IMPORTANT: the MAX_DAILY_UPLOADS cap is bucketed by *local* calendar day
 * (in TIMEZONE), not UTC day — a 19:00 Chicago slot lands on the next UTC
 * day but still counts against the same local day.
 */

/** Calendar-day key (yyyy-MM-dd) of a UTC instant in the configured TZ. */
export function localDayKey(utcIso: string | Date): string {
  const date = typeof utcIso === 'string' ? new Date(utcIso) : utcIso;
  return format(toZonedTime(date, env.TIMEZONE), 'yyyy-MM-dd');
}

/**
 * Uploads-per-local-day usage map from existing rows:
 * scheduled rows count by their slot, uploaded rows by when they happened.
 */
export function dailyUsage(): Map<string, number> {
  const usage = new Map<string, number>();
  for (const u of listUploads({ limit: 5000 })) {
    let stamp: string | undefined;
    if (u.status === 'scheduled') stamp = u.scheduledAt;
    else if (u.status === 'uploaded' || u.status === 'uploading') {
      stamp = u.uploadedAt ?? u.scheduledAt;
    }
    if (!stamp) continue;
    const day = localDayKey(stamp);
    usage.set(day, (usage.get(day) ?? 0) + 1);
  }
  return usage;
}

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
  const usage = dailyUsage();
  for (const slot of upcomingSlots(14)) {
    if ((usage.get(localDayKey(slot)) ?? 0) < config.maxDailyUploads) return slot;
  }
  return undefined;
}

export interface ScheduleResult {
  scheduled: { draftId: number; scheduledAt: string }[];
  skipped: { draftId: number; reason: string }[];
}

/**
 * Assign posting slots to approved drafts that don't have one yet.
 * Respects MAX_DAILY_UPLOADS per local calendar day.
 */
export function scheduleApprovedDrafts(): ScheduleResult {
  const config = getAppConfig();
  const result: ScheduleResult = { scheduled: [], skipped: [] };
  const approved = listDrafts({ status: 'approved' });

  if (!approved.length) {
    logger.warn('No approved drafts to schedule. Approve drafts with "npm run review -- --approve <id>".');
    return result;
  }

  // One usage snapshot, updated in memory as we assign (rows are inserted
  // immediately, so re-querying would double-count what we just placed).
  const usage = dailyUsage();
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

    const slotIndex = slots.findIndex(
      (s) => (usage.get(localDayKey(s)) ?? 0) < config.maxDailyUploads,
    );
    if (slotIndex === -1) {
      result.skipped.push({ draftId: draft.id!, reason: 'no free slot in the next 30 days' });
      continue;
    }
    const slot = slots[slotIndex]!;
    const day = localDayKey(slot);
    usage.set(day, (usage.get(day) ?? 0) + 1);
    slots.splice(slotIndex, 1);

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
