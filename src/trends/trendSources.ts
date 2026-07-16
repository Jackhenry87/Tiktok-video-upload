import axios from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import { env } from '../config/env';
import { getAppConfig, getNicheProfile } from '../config/appConfig';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import type { TrendSignal } from '../types';

/**
 * Trend sources — approved signal sources ONLY.
 *
 * Every source here collects *metadata* (topics, interest levels, headlines),
 * never video files or other creators' captions. There is deliberately no
 * code path that downloads, reposts, or re-uploads anyone else's content.
 */

export interface TrendSource {
  label: string;
  collect(): Promise<TrendSignal[]>;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

function defaultsForNiche(niche: string): Pick<
  TrendSignal,
  'suggestedVideoLengthSec' | 'suggestedVisualStyle' | 'suggestedCta'
> {
  return {
    suggestedVideoLengthSec: 21,
    suggestedVisualStyle: 'bold captions, fast cuts, vertical 9:16',
    suggestedCta: `Follow for more ${niche} tips`,
  };
}

// ---------------------------------------------------------------------------
// 1. Manual trend input (app.config.json -> manualTrends)
// ---------------------------------------------------------------------------

export class ManualConfigSource implements TrendSource {
  label = 'manual-config';

  async collect(): Promise<TrendSignal[]> {
    const config = getAppConfig();
    return config.manualTrends
      .filter((t) => t.topic)
      .map((t) => {
        const niche = t.niche ?? config.defaultNiche;
        return {
          topic: t.topic!,
          category: t.category ?? 'education',
          niche,
          suggestedHook: t.suggestedHook ?? `You need to hear about ${t.topic}`,
          suggestedCaption: t.suggestedCaption ?? '',
          suggestedHashtags: t.suggestedHashtags ?? [],
          suggestedVideoLengthSec:
            t.suggestedVideoLengthSec ?? defaultsForNiche(niche).suggestedVideoLengthSec,
          suggestedVisualStyle:
            t.suggestedVisualStyle ?? defaultsForNiche(niche).suggestedVisualStyle,
          suggestedCta: t.suggestedCta ?? defaultsForNiche(niche).suggestedCta,
          estimatedStrength: t.estimatedStrength ?? 60,
          competitionLevel: t.competitionLevel,
          sourceLabel: this.label,
          sourceUrl: t.sourceUrl,
          dateFound: t.dateFound ?? todayIso(),
        };
      });
  }
}

// ---------------------------------------------------------------------------
// 2. User-provided trend CSV
// ---------------------------------------------------------------------------

/** Minimal CSV parser that handles quoted fields and commas inside quotes. */
export function parseCsv(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);

  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return data.map((cells) =>
    Object.fromEntries(keys.map((k, idx) => [k, (cells[idx] ?? '').trim()])),
  );
}

export class CsvFileSource implements TrendSource {
  label = 'csv-file';

  constructor(private readonly filePath: string) {}

  async collect(): Promise<TrendSignal[]> {
    const resolved = path.resolve(process.cwd(), this.filePath);
    if (!(await fs.pathExists(resolved))) {
      logger.warn(`Trend CSV not found at ${resolved}, skipping.`);
      return [];
    }
    const content = await fs.readFile(resolved, 'utf8');
    const records = parseCsv(content);
    const config = getAppConfig();

    return records
      .filter((r) => r.topic)
      .map((r) => {
        const niche = r.niche || config.defaultNiche;
        const defaults = defaultsForNiche(niche);
        return {
          topic: r.topic!,
          category: r.category || 'education',
          niche,
          suggestedHook: r.hook || `The ${r.topic} trend explained in 20 seconds`,
          suggestedCaption: r.caption || '',
          suggestedHashtags: (r.hashtags || '')
            .split(/[;|]/)
            .map((t) => t.trim())
            .filter(Boolean),
          suggestedVideoLengthSec:
            Number(r.video_length_sec) || defaults.suggestedVideoLengthSec,
          suggestedVisualStyle: r.visual_style || defaults.suggestedVisualStyle,
          suggestedCta: r.cta || defaults.suggestedCta,
          estimatedStrength: Math.min(100, Math.max(0, Number(r.strength) || 50)),
          competitionLevel: r.competition ? Number(r.competition) : undefined,
          sourceLabel: this.label,
          sourceUrl: r.source_url || undefined,
          dateFound: r.date_found || todayIso(),
        };
      });
  }
}

// ---------------------------------------------------------------------------
// 3. RSS feeds (user-approved feeds only)
// ---------------------------------------------------------------------------

export class RssFeedSource implements TrendSource {
  label = 'rss-feed';

  constructor(private readonly feedUrls: string[]) {}

  async collect(): Promise<TrendSignal[]> {
    const config = getAppConfig();
    const signals: TrendSignal[] = [];

    for (const url of this.feedUrls) {
      try {
        const xml = await withRetry(
          async () => {
            const res = await axios.get<string>(url, {
              timeout: 15_000,
              responseType: 'text',
              headers: { 'User-Agent': 'tiktok-video-automation/1.0 (trend research)' },
            });
            return res.data;
          },
          { label: `RSS fetch ${url}`, retries: 2 },
        );

        for (const item of extractRssItems(xml).slice(0, 10)) {
          const niche = matchNiche(item.title, config.activeNiches) ?? config.defaultNiche;
          const defaults = defaultsForNiche(niche);
          signals.push({
            topic: item.title,
            category: 'news',
            niche,
            suggestedHook: `Everyone's talking about this: ${truncate(item.title, 60)}`,
            suggestedCaption: '',
            suggestedHashtags: [],
            ...defaults,
            estimatedStrength: 55,
            sourceLabel: this.label,
            sourceUrl: item.link || url,
            dateFound: item.pubDate ? item.pubDate.slice(0, 10) : todayIso(),
          });
        }
      } catch (err) {
        logger.warn(`RSS feed failed (${url}): ${(err as Error).message} — skipping.`);
      }
    }
    return signals;
  }
}

interface RssItem {
  title: string;
  link?: string;
  pubDate?: string;
}

/** Lightweight RSS/Atom item extraction without an XML dependency. */
export function extractRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = decodeXml(
      firstMatch(block, /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) ?? '',
    ).trim();
    if (!title) continue;
    const link =
      firstMatch(block, /<link[^>]*href="([^"]+)"/i) ??
      decodeXml(firstMatch(block, /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) ?? '').trim();
    const pubDateRaw =
      firstMatch(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ??
      firstMatch(block, /<updated[^>]*>([\s\S]*?)<\/updated>/i);
    let pubDate: string | undefined;
    if (pubDateRaw) {
      const parsed = new Date(pubDateRaw.trim());
      if (!Number.isNaN(parsed.getTime())) pubDate = parsed.toISOString();
    }
    items.push({ title, link: link || undefined, pubDate });
  }
  return items;
}

function firstMatch(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1];
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function matchNiche(text: string, activeNiches: string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const nicheName of activeNiches) {
    const profile = getNicheProfile(nicheName);
    if (profile.keywords.some((k) => lower.includes(k))) return nicheName;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 4. Google Trends CSV export (manual download — no scraping)
// ---------------------------------------------------------------------------

/**
 * Google Trends has no official public API. Instead of scraping, the user
 * exports a CSV from trends.google.com ("interest over time" or "related
 * queries") and points GOOGLE_TRENDS_CSV_PATH at it.
 * Expected columns (flexible): query/topic, value/interest.
 */
export class GoogleTrendsCsvSource implements TrendSource {
  label = 'google-trends-csv';

  constructor(private readonly filePath: string) {}

  async collect(): Promise<TrendSignal[]> {
    const resolved = path.resolve(process.cwd(), this.filePath);
    if (!(await fs.pathExists(resolved))) {
      logger.warn(`Google Trends CSV not found at ${resolved}, skipping.`);
      return [];
    }
    const content = await fs.readFile(resolved, 'utf8');
    const records = parseCsv(content);
    const config = getAppConfig();

    return records
      .map((r) => {
        const topic = r.query || r.topic || r.term || '';
        if (!topic) return undefined;
        const interest = Number(r.value ?? r.interest ?? r.score ?? 50);
        const niche = matchNiche(topic, config.activeNiches) ?? config.defaultNiche;
        return {
          topic,
          category: 'search-trend',
          niche,
          suggestedHook: `Searches for "${topic}" are spiking — here's why it matters`,
          suggestedCaption: '',
          suggestedHashtags: [],
          ...defaultsForNiche(niche),
          estimatedStrength: Math.min(100, Math.max(0, Number.isFinite(interest) ? interest : 50)),
          sourceLabel: this.label,
          sourceUrl: 'https://trends.google.com',
          dateFound: todayIso(),
        } as TrendSignal;
      })
      .filter((t): t is TrendSignal => Boolean(t));
  }
}

// ---------------------------------------------------------------------------
// 5. TikTok Creative Center (placeholder — official access only)
// ---------------------------------------------------------------------------

/**
 * TikTok Creative Center (https://ads.tiktok.com/business/creativecenter)
 * publishes trending hashtags/songs for advertisers. There is no public API,
 * and this app will NOT scrape it — scraping would violate TikTok's terms.
 *
 * TODO(real-api): if you obtain official/partner API access to Creative
 * Center data, implement the fetch here and return real signals. Until then
 * this source stays disabled and simply explains itself.
 */
export class TikTokCreativeCenterSource implements TrendSource {
  label = 'tiktok-creative-center';

  async collect(): Promise<TrendSignal[]> {
    logger.info(
      'TikTok Creative Center source is disabled (no official API access configured). ' +
        'Browse ads.tiktok.com/business/creativecenter manually and add findings via ' +
        'app.config.json manualTrends or a trend CSV.',
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// 6. Mock source (MOCK_MODE)
// ---------------------------------------------------------------------------

const MOCK_TOPICS: Record<string, { topic: string; category: string; strength: number }[]> = {
  finance: [
    { topic: 'The 50/30/20 budget rule challenge', category: 'education', strength: 78 },
    { topic: 'High-yield savings accounts explained', category: 'education', strength: 71 },
    { topic: 'What compound interest does in 10 years', category: 'education', strength: 66 },
  ],
  'sports betting': [
    { topic: 'Bankroll management for casual bettors', category: 'sports', strength: 74 },
    { topic: 'How betting odds actually work', category: 'education', strength: 69 },
  ],
  'side hustles': [
    { topic: 'Weekend side hustles you can start with $0', category: 'business', strength: 80 },
    { topic: 'Selling digital templates online', category: 'business', strength: 72 },
  ],
  'real estate': [
    { topic: 'House hacking your first property', category: 'finance', strength: 75 },
  ],
  'ai tools': [
    { topic: '3 AI tools that save an hour a day', category: 'technology', strength: 84 },
    { topic: 'Automating your inbox with AI', category: 'technology', strength: 70 },
  ],
  'college life': [
    { topic: 'Dorm room setups under $100', category: 'lifestyle', strength: 76 },
  ],
  fitness: [
    { topic: 'The 20-minute hotel room workout', category: 'fitness', strength: 73 },
  ],
  'local business marketing': [
    { topic: 'Getting more Google reviews the right way', category: 'business', strength: 68 },
  ],
};

export class MockTrendSource implements TrendSource {
  label = 'mock';

  async collect(): Promise<TrendSignal[]> {
    const config = getAppConfig();
    const niches = config.activeNiches.length ? config.activeNiches : [config.defaultNiche];
    const signals: TrendSignal[] = [];

    for (const niche of niches) {
      const topics = MOCK_TOPICS[niche] ?? [
        { topic: `Beginner mistakes in ${niche}`, category: 'education', strength: 65 },
        { topic: `${niche} tips nobody talks about`, category: 'education', strength: 60 },
      ];
      for (const t of topics) {
        signals.push({
          topic: t.topic,
          category: t.category,
          niche,
          suggestedHook: `Stop scrolling — ${t.topic.toLowerCase()} in 20 seconds`,
          suggestedCaption: '',
          suggestedHashtags: [],
          ...defaultsForNiche(niche),
          estimatedStrength: t.strength,
          competitionLevel: 40 + ((t.topic.length * 7) % 40),
          sourceLabel: this.label,
          sourceUrl: undefined,
          dateFound: todayIso(),
        });
      }
    }
    logger.info(`[mock] Generated ${signals.length} fake trend signals`);
    return signals;
  }
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

export function buildSources(mock: boolean): TrendSource[] {
  if (mock) return [new MockTrendSource(), new ManualConfigSource()];

  const sources: TrendSource[] = [new ManualConfigSource(), new TikTokCreativeCenterSource()];
  if (env.TREND_CSV_PATH) sources.push(new CsvFileSource(env.TREND_CSV_PATH));
  if (env.RSS_FEEDS.length) sources.push(new RssFeedSource(env.RSS_FEEDS));
  if (env.GOOGLE_TRENDS_CSV_PATH) {
    sources.push(new GoogleTrendsCsvSource(env.GOOGLE_TRENDS_CSV_PATH));
  }
  return sources;
}
