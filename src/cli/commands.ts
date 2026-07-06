import { Command } from 'commander';
import { env, isTikTokConfigured, isViewMaxConfigured, reviewRequired } from '../config/env';
import { getAppConfig } from '../config/appConfig';
import { collectTrends } from '../trends/trendCollector';
import { generateIdeas } from '../ideas/ideaGenerator';
import { createBatch, createVideo, getStatusSummary } from '../videos/videoJobService';
import {
  approveDraft,
  cleanOldDrafts,
  editDraft,
  listPendingDrafts,
  regenerateDraft,
  rejectDraft,
} from '../videos/draftService';
import { scheduleApprovedDrafts, upcomingSlots } from '../uploads/scheduleService';
import { retryFailedUploads, uploadApprovedDrafts } from '../uploads/uploadService';
import { getDraft, listDrafts } from '../db/database';
import { logger } from '../utils/logger';

/* eslint-disable no-console */

function banner(): void {
  const mock = env.MOCK_MODE === true;
  const lines = [
    `mode: ${mock ? 'MOCK (no real API calls)' : 'auto/real'}`,
    `viewmax: ${isViewMaxConfigured() ? 'configured' : 'NOT configured'}`,
    `tiktok: ${isTikTokConfigured() ? 'configured' : 'NOT configured'}`,
    `review required: ${reviewRequired() ? 'yes' : 'NO (auto-approve!)'}`,
    `niches: ${getAppConfig().activeNiches.join(', ')}`,
  ];
  console.log(`\n┌─ tiktok-video-automation ─ ${lines.join(' | ')}\n`);
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n✖ ${message}\n`);
  process.exitCode = 1;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('tiktok-bot')
    .description(
      'Original TikTok video automation — trend research, idea generation, ' +
        'ViewMax video creation, manual review, official-API uploads.',
    )
    .version('1.0.0');

  // -------------------------------------------------------------- trends ---
  program
    .command('trends')
    .description('Collect trend signals from approved sources, score and save them')
    .action(async () => {
      banner();
      try {
        const result = await collectTrends();
        console.log(
          `Collected ${result.collected} signal(s): ${result.saved} new, ` +
            `${result.skippedDuplicates} duplicate(s) skipped, ` +
            `${result.aboveMinScore} at/above min score ${getAppConfig().minTrendScore}.`,
        );
        for (const t of result.trends.slice(0, 10)) {
          console.log(
            `  #${t.id}  [${String(t.score).padStart(3)}] ${t.topic} ` +
              `(${t.niche} · ${t.sourceLabel})`,
          );
        }
        if (result.saved > 10) console.log(`  … and ${result.saved - 10} more`);
        console.log('\nNext: npm run ideas');
      } catch (err) {
        fail(err);
      }
    });

  // --------------------------------------------------------------- ideas ---
  program
    .command('ideas')
    .description('Generate original video ideas from saved trends')
    .option('-l, --limit <n>', 'max ideas to generate', '5')
    .action(async (opts: { limit: string }) => {
      banner();
      try {
        const result = await generateIdeas(Number(opts.limit) || 5);
        console.log(`Generated ${result.generated} idea(s), ${result.blocked} blocked by compliance.`);
        for (const idea of result.ideas) {
          console.log(`\n  Idea #${idea.id}: ${idea.title}`);
          console.log(`    hook:     ${idea.hook}`);
          console.log(`    caption:  ${idea.caption}`);
          console.log(`    hashtags: ${idea.hashtags.map((h) => `#${h}`).join(' ')}`);
          console.log(`    duration: ~${idea.estimatedDurationSec}s · scenes: ${idea.scenes.length}`);
          console.log(`    why:      ${idea.selectionReason}`);
        }
        console.log('\nNext: npm run create-video');
      } catch (err) {
        fail(err);
      }
    });

  // -------------------------------------------------------- create-video ---
  program
    .command('create-video')
    .description('Create one video through ViewMax (next ready idea, or --idea <id>)')
    .option('-i, --idea <id>', 'specific idea id')
    .action(async (opts: { idea?: string }) => {
      banner();
      try {
        const jobId = await createVideo(opts.idea ? Number(opts.idea) : undefined);
        if (jobId !== undefined) {
          console.log(`\nVideo job ${jobId} completed. Next: npm run review`);
        }
      } catch (err) {
        fail(err);
      }
    });

  // -------------------------------------------------------- create-batch ---
  program
    .command('create-batch')
    .description('Create multiple videos through ViewMax using the job queue')
    .option('-c, --count <n>', 'number of videos', '3')
    .option('--concurrency <n>', 'parallel jobs', '2')
    .action(async (opts: { count: string; concurrency: string }) => {
      banner();
      try {
        const result = await createBatch(
          Number(opts.count) || 3,
          Number(opts.concurrency) || 2,
        );
        console.log(`\nBatch finished: ${result.processed} succeeded, ${result.failed} failed.`);
        console.log('Next: npm run review');
      } catch (err) {
        fail(err);
      }
    });

  // -------------------------------------------------------------- review ---
  program
    .command('review')
    .description('Show pending drafts; approve / reject / regenerate / edit them')
    .option('-a, --approve <id>', 'approve a draft')
    .option('-r, --reject <id>', 'reject a draft')
    .option('-g, --regenerate <id>', 'reject and queue the idea for a new video')
    .option('-e, --edit <id>', 'edit a draft (use with --caption / --hashtags)')
    .option('--caption <text>', 'new caption for --edit')
    .option('--hashtags <list>', 'comma-separated hashtags for --edit')
    .option('-n, --note <text>', 'review note')
    .option('-s, --show <id>', 'show full detail for one draft')
    .action(async (opts: Record<string, string | undefined>) => {
      banner();
      try {
        if (opts.approve) {
          const d = approveDraft(Number(opts.approve), opts.note);
          console.log(`Approved draft #${d.id}. Next: npm run schedule (or npm run upload)`);
          return;
        }
        if (opts.reject) {
          const d = rejectDraft(Number(opts.reject), opts.note);
          console.log(`Rejected draft #${d.id}.`);
          return;
        }
        if (opts.regenerate) {
          const d = regenerateDraft(Number(opts.regenerate), opts.note);
          console.log(`Draft #${d.id} flagged for regeneration — run npm run create-video.`);
          return;
        }
        if (opts.edit) {
          const hashtags = opts.hashtags
            ? opts.hashtags.split(',').map((h) => h.trim()).filter(Boolean)
            : undefined;
          if (!opts.caption && !hashtags) {
            throw new Error('--edit needs --caption and/or --hashtags');
          }
          const d = editDraft(Number(opts.edit), { caption: opts.caption, hashtags });
          console.log(`Edited draft #${d.id}.`);
          console.log(`  caption:  ${d.caption}`);
          console.log(`  hashtags: ${d.hashtags.map((h) => `#${h}`).join(' ')}`);
          return;
        }
        if (opts.show) {
          const d = getDraft(Number(opts.show));
          if (!d) throw new Error(`Draft ${opts.show} not found`);
          console.log(JSON.stringify(d, null, 2));
          return;
        }

        const pending = listPendingDrafts();
        if (!pending.length) {
          console.log('No drafts pending review.');
          const others = listDrafts({ limit: 5 });
          if (others.length) {
            console.log('Recent drafts:');
            for (const d of others) {
              console.log(`  #${d.id} [${d.status}] ${d.caption.slice(0, 60)}`);
            }
          }
          return;
        }
        console.log(`${pending.length} draft(s) pending review:\n`);
        for (const d of pending) {
          console.log(`  Draft #${d.id}`);
          console.log(`    video:      ${d.videoPath}`);
          console.log(`    thumbnail:  ${d.thumbnailPath ?? '-'}`);
          console.log(`    caption:    ${d.caption}`);
          console.log(`    hashtags:   ${d.hashtags.map((h) => `#${h}`).join(' ')}`);
          console.log(`    source:     ${d.trendSource}`);
          console.log(`    viewmax id: ${d.viewmaxJobId ?? '-'}`);
          console.log(`    suggested:  ${d.suggestedPostTime ?? '-'}`);
          console.log('');
        }
        console.log('Approve:    npm run review -- --approve <id>');
        console.log('Reject:     npm run review -- --reject <id>');
        console.log('Regenerate: npm run review -- --regenerate <id>');
        console.log('Edit:       npm run review -- --edit <id> --caption "..." --hashtags a,b');
      } catch (err) {
        fail(err);
      }
    });

  // -------------------------------------------------------------- upload ---
  program
    .command('upload')
    .description('Upload approved drafts to TikTok (due scheduled ones + unscheduled)')
    .option('-d, --draft <id>', 'upload a specific approved draft')
    .option('--now', 'ignore scheduled times and upload immediately')
    .option('--retry-failed', 'retry previously failed uploads')
    .action(async (opts: { draft?: string; now?: boolean; retryFailed?: boolean }) => {
      banner();
      try {
        const result = opts.retryFailed
          ? await retryFailedUploads()
          : await uploadApprovedDrafts({
              draftId: opts.draft ? Number(opts.draft) : undefined,
              now: Boolean(opts.now),
            });
        for (const u of result.uploaded) {
          console.log(
            `✔ Draft #${u.draftId} uploaded — publish_id=${u.publishId}` +
              (u.videoId ? ` video_id=${u.videoId}` : ''),
          );
        }
        for (const s of result.skipped) {
          console.log(`- Draft #${s.draftId} skipped: ${s.reason}`);
        }
        for (const f of result.failed) {
          console.log(`✖ Draft #${f.draftId} failed: ${f.error}`);
        }
        if (!result.uploaded.length && !result.skipped.length && !result.failed.length) {
          console.log('Nothing to upload.');
        }
      } catch (err) {
        fail(err);
      }
    });

  // ------------------------------------------------------------ schedule ---
  program
    .command('schedule')
    .description('Assign posting slots to approved drafts (respects MAX_DAILY_UPLOADS)')
    .option('--list', 'just show upcoming free slots')
    .action(async (opts: { list?: boolean }) => {
      banner();
      try {
        if (opts.list) {
          console.log(`Upcoming slots (${env.TIMEZONE}):`);
          for (const slot of upcomingSlots(7)) console.log(`  ${slot}`);
          return;
        }
        const result = scheduleApprovedDrafts();
        for (const s of result.scheduled) {
          console.log(`✔ Draft #${s.draftId} scheduled for ${s.scheduledAt}`);
        }
        for (const s of result.skipped) {
          console.log(`- Draft #${s.draftId} skipped: ${s.reason}`);
        }
        if (result.scheduled.length) {
          console.log('\nRun "npm run upload" once a slot is due (e.g. via cron).');
        }
      } catch (err) {
        fail(err);
      }
    });

  // -------------------------------------------------------------- status ---
  program
    .command('status')
    .description('Show all video job statuses and pipeline counts')
    .action(async () => {
      banner();
      try {
        const s = getStatusSummary();
        console.log('Tables:');
        for (const [table, count] of Object.entries(s.tables)) {
          console.log(`  ${table.padEnd(12)} ${count}`);
        }
        console.log('\nVideo jobs by status:', JSON.stringify(s.jobCounts));
        console.log('Drafts by status:    ', JSON.stringify(s.draftCounts));
        console.log('Uploads by status:   ', JSON.stringify(s.uploadCounts));
        if (s.jobs.length) {
          console.log('\nRecent jobs:');
          for (const j of s.jobs) {
            console.log(
              `  job #${j.id} [${j.status}] idea=${j.ideaId} ` +
                `viewmax=${j.viewmaxJobId ?? '-'} ${j.error ? `error=${j.error.slice(0, 60)}` : ''}`,
            );
          }
        }
      } catch (err) {
        fail(err);
      }
    });

  // --------------------------------------------------------------- clean ---
  program
    .command('clean')
    .description('Clean rejected/failed drafts and jobs older than N days')
    .option('--days <n>', 'age threshold in days', '14')
    .option('--dry-run', 'show what would be removed without deleting')
    .action(async (opts: { days: string; dryRun?: boolean }) => {
      banner();
      try {
        const days = Number.isFinite(Number(opts.days)) ? Math.max(0, Number(opts.days)) : 14;
        const result = await cleanOldDrafts(days, Boolean(opts.dryRun));
        console.log(
          `${opts.dryRun ? '[dry-run] ' : ''}Removed ${result.draftsRemoved} draft(s), ` +
            `cleaned files for ${result.jobsMarked} failed job(s).`,
        );
      } catch (err) {
        fail(err);
      }
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
  logger.flush?.();
}
