# TikTok Video Automation

Original TikTok video automation app: it researches **trend signals** from approved sources, generates **original video ideas**, creates videos through the **ViewMax** connector, saves every video as a **draft for manual review**, and uploads approved videos through **TikTok's official Content Posting API**.

**What this app deliberately does NOT do:**

- It never downloads, reposts, or re-uploads other creators' videos.
- It never copies other creators' captions — trends are inspiration only.
- It never automates the TikTok website or bypasses logins, CAPTCHAs, rate limits, or anti-bot systems. Uploads use the documented official API with your own OAuth token, or a clearly-labeled mock adapter.

## Pipeline

```
trends  →  score  →  ideas  →  ViewMax video job  →  poll  →  download MP4
   →  draft (thumbnail + metadata)  →  MANUAL REVIEW  →  schedule  →  upload  →  result saved
```

## Quick start (mock mode — no credentials needed)

```bash
npm install
cp .env.example .env          # MOCK_MODE=true is the default in the example
npm run trends                # 1. collect + score trend signals
npm run ideas                 # 2. generate original video ideas
npm run create-video          # 3. create one video (mock ViewMax job + placeholder MP4)
npm run review                # 4. see pending drafts
npm run review -- --approve 1 # 5. approve draft #1
npm run upload                # 6. "upload" (mock: prints what would happen)
```

In mock mode the app generates fake trends, fake ideas, a placeholder video job, a sample draft, and skips the real TikTok upload while printing exactly what would happen.

## All commands

| Command | What it does |
|---|---|
| `npm run trends` | Collect trend signals from approved sources, score them 0–100, save to SQLite |
| `npm run ideas` | Generate original video ideas from saved trends (`-- --limit 10`) |
| `npm run create-video` | Create one video through ViewMax (`-- --idea 3` for a specific idea) |
| `npm run create-batch` | Create multiple videos via the job queue (`-- --count 5 --concurrency 2`) |
| `npm run review` | List pending drafts; `-- --approve/--reject/--regenerate/--edit <id>` |
| `npm run upload` | Upload approved drafts (due scheduled + unscheduled); `-- --now`, `-- --retry-failed` |
| `npm run schedule` | Assign posting slots to approved drafts; `-- --list` shows free slots |
| `npm run status` | Dashboard: table counts, job/draft/upload statuses, recent jobs |
| `npm run clean` | Remove rejected/stale drafts and failed-job files (`-- --days 30 --dry-run`) |

> Note: npm needs `--` before flags, e.g. `npm run review -- --approve 2`.

## Configuration (.env)

Copy `.env.example` to `.env`. Key variables:

| Variable | Purpose |
|---|---|
| `VIEWMAX_API_KEY`, `VIEWMAX_BASE_URL` | ViewMax video-generation API credentials |
| `TIKTOK_CLIENT_KEY/SECRET`, `TIKTOK_REDIRECT_URI`, `TIKTOK_ACCESS_TOKEN` | Official TikTok API app + OAuth token |
| `DATABASE_URL` | SQLite location (default `file:./data/app.db`) |
| `DEFAULT_NICHE` / `NICHES` | Content niche(s): `sports betting`, `finance`, `side hustles`, `real estate`, `ai tools`, `college life`, `fitness`, `local business marketing` |
| `DEFAULT_PRIVACY_STATUS` | `SELF_ONLY` (safe default), `PUBLIC_TO_EVERYONE`, … |
| `MAX_DAILY_UPLOADS` | Hard daily cap enforced at schedule + upload time |
| `REVIEW_REQUIRED` | `true` (default) — uploads need manual approval |
| `MIN_TREND_SCORE` | Only trends at/above this score become videos |
| `TIMEZONE`, `POSTING_TIMES` | Local posting slots for the scheduler |
| `TREND_CSV_PATH`, `RSS_FEEDS`, `GOOGLE_TRENDS_CSV_PATH` | Approved trend sources |
| `MOCK_MODE` | `true` = fully mocked; unset = auto (mock only when keys missing) |

Optional: copy `app.config.example.json` to `app.config.json` for manual trend input, custom scoring weights, active niches, and posting times.

## Running in mock mode

Set `MOCK_MODE=true` (the `.env.example` default). Everything works end-to-end locally: mock trends → real scoring → real idea generation → placeholder "MP4" written by the mock ViewMax client → real draft/review flow → mock upload that logs the exact API calls it would make. No network calls, no credentials, nothing published.

## Adding ViewMax credentials

1. Put `VIEWMAX_API_KEY` and `VIEWMAX_BASE_URL` in `.env`, set `MOCK_MODE=false` (or remove it).
2. The HTTP client lives in `src/connectors/viewmax/viewmaxClient.ts`. Endpoint paths and field names are marked with `TODO(real-api)` — align them with the official ViewMax docs when you receive them. The rest of the app only depends on the `ViewMaxConnector` interface, so nothing else changes.

## Connecting the TikTok API

1. Create an app at <https://developers.tiktok.com>, enable the **Content Posting API** product, and request the `video.publish` scope.
2. Complete the OAuth authorization-code flow with your `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, and `TIKTOK_REDIRECT_URI`; store the resulting user token as `TIKTOK_ACCESS_TOKEN`.
3. **Unaudited apps can only post `SELF_ONLY` (private)** — keep `DEFAULT_PRIVACY_STATUS=SELF_ONLY` until TikTok audits your app.
4. The client (`src/connectors/tiktok/tiktokClient.ts`) uses the documented direct-post flow: `POST /v2/post/publish/video/init/` → chunked `PUT` to the returned `upload_url` → poll `/v2/post/publish/status/fetch/`. The TikTok video/publish IDs are stored in the `uploads` table.

Scheduling note: the Content Posting API has no native schedule-time for direct posts, so scheduling is local — `npm run schedule` assigns slots, and `npm run upload` (run manually or from cron) publishes drafts whose slot is due.

## Reviewing and approving drafts

Every generated video becomes a draft with the video file, thumbnail, script, caption, hashtags, trend source, ViewMax job ID, and a suggested posting time (also exported as JSON under `storage/drafts/`).

```bash
npm run review                                  # list pending drafts
npm run review -- --show 2                      # full details for draft 2
npm run review -- --approve 2 --note "ship it"  # approve
npm run review -- --reject 3 --note "weak hook" # reject
npm run review -- --regenerate 4                # reject + re-open the idea for a new video
npm run review -- --edit 2 --caption "New caption" --hashtags finance,tips
```

Nothing uploads without approval unless you explicitly set `REVIEW_REQUIRED=false`.

## Scheduling & uploading

```bash
npm run schedule            # assign next free slots (respects MAX_DAILY_UPLOADS)
npm run schedule -- --list  # inspect upcoming slots
npm run upload              # publish approved drafts whose slot is due (or unscheduled ones)
npm run upload -- --now     # ignore slots and publish immediately
npm run upload -- --retry-failed
```

For hands-off posting, add a cron entry that runs `npm run upload` hourly — only due, approved, under-the-daily-cap drafts are ever published.

## Changing niches

Set `DEFAULT_NICHE` (or a comma-separated `NICHES`) in `.env`, or `activeNiches` in `app.config.json`. Niche profiles (keywords, base hashtags, audiences, disclaimers) live in `src/config/appConfig.ts` — add your own profile there for a custom niche.

## Trend scoring

Each trend gets a 0–100 score from weighted components: recency, niche match, search interest, relevance, content fit, competition (when the source reports it), and repeatability. Only trends at/above `MIN_TREND_SCORE` become videos. Weights are tunable in `app.config.json`.

## Safety & compliance

- **Copyright:** no reposting/downloading of other creators' videos (no code path exists for it); trend sources collect topic metadata only; music guidance always specifies licensed/royalty-free tracks. Use only assets you own or have rights to.
- **Claims:** banned phrases (“guaranteed winner”, “risk-free”, “lock of the day”, “get rich quick”, …) are auto-replaced; fake earnings claims, medical claims, and impersonation are hard blocks.
- **Disclaimers:** finance/betting/side-hustle/real-estate/fitness captions automatically carry a disclaimer (e.g. “Not financial advice.”, “21+. Gamble responsibly.”).
- **Spam:** hashtags are deduplicated, capped, and spam tags removed; `MAX_DAILY_UPLOADS` is enforced at both scheduling and upload time.
- **Attribution:** each draft stores its trend source (label + URL) internally.
- **Review:** manual approval is required by default; the final upload gate re-validates the caption.

## How to avoid copyright issues

1. Treat trends as **topics**, never as videos to copy — write your own hook/script (the idea generator already does).
2. Only use music ViewMax licenses or royalty-free tracks; never rip trending sounds you don't have rights to.
3. Only use b-roll/footage you own, generated, or licensed.
4. Don't re-upload watermarked or downloaded TikTok content — this app refuses to by design.
5. Keep the source attribution stored with each draft in case you ever need to show where an idea came from.

## Project structure

```
src/
  index.ts               entry point (init db/storage, dispatch CLI)
  config/    env.ts, appConfig.ts
  connectors/
    viewmax/ viewmaxClient.ts (HTTP + mock), viewmaxTypes.ts
    tiktok/  tiktokClient.ts (official API + mock), tiktokTypes.ts
  trends/    trendCollector.ts, trendScorer.ts, trendSources.ts
  ideas/     ideaGenerator.ts, scriptGenerator.ts, captionGenerator.ts
  videos/    videoJobService.ts (queue), draftService.ts, thumbnailService.ts
  uploads/   uploadService.ts, scheduleService.ts
  db/        database.ts, migrations.ts, schema.ts
  cli/       commands.ts
  utils/     logger.ts, retry.ts, validators.ts, fileStorage.ts, queue.ts
  types/     index.ts
examples/    trends.example.csv, idea.example.json,
             viewmax-request.example.json, tiktok-upload.example.json
```

## Storage

SQLite (better-sqlite3) at `DATABASE_URL` with tables `trends`, `ideas`, `video_jobs`, `drafts`, `uploads`, `settings`, `logs` — all with `created_at`/`updated_at` (maintained by triggers). Migrations run automatically on startup (`src/db/migrations.ts`). Video files land in `storage/videos/`, thumbnails in `storage/thumbnails/`, draft JSON exports in `storage/drafts/`.

The `video_jobs` table doubles as a durable queue: jobs left `queued` by a crash are resumed by the next `create-batch` run.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
```
