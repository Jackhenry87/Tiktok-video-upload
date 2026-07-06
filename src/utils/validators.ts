import { getAppConfig, getNicheProfile } from '../config/appConfig';
import type { ComplianceIssue, ComplianceResult, VideoIdea } from '../types';

/**
 * Safety & compliance validation.
 *
 * Rules enforced here:
 *  - No guaranteed-outcome / misleading claims ("lock", "risk-free",
 *    "guaranteed winner", "get rich quick", ...). Banned phrases are
 *    auto-replaced with safer wording and reported as 'fix' issues.
 *  - No fake earnings claims (specific $ amounts framed as guaranteed/easy).
 *  - No medical claims ("cure", "miracle", rapid-weight-loss promises).
 *  - No impersonation ("official", "I am <celebrity>" patterns).
 *  - Finance / betting / fitness content must carry a disclaimer.
 *  - Hashtags: capped count, no spam tags, deduplicated.
 *
 * Note: this app never downloads or reposts other creators' videos —
 * that rule is structural (there is no code path for it), and trend sources
 * only collect *signals* (topics/metadata), never video files.
 */

const EARNINGS_CLAIM =
  /(make|earn|profit)\s+\$?\d[\d,]*(\s*(per|a|\/)\s*(day|week|month|hour))?\s*(guaranteed|easily|effortlessly|on autopilot|risk[- ]?free)/i;

const MEDICAL_CLAIM =
  /(cure[sd]?\s+(cancer|diabetes|anxiety|depression)|miracle\s+(cure|pill|supplement)|lose\s+\d+\s*(lbs|pounds|kg)\s+in\s+\d+\s*(days?|weeks?))/i;

const IMPERSONATION =
  /\b(i\s+am\s+(elon musk|mrbeast|the\s+irs|tiktok\s+support)|official\s+(tiktok|irs|government)\s+account)\b/i;

const BETTING_GUARANTEE =
  /\b(lock\s+(of|for)\s+the\s+(day|week|night)|guaranteed\s+(winner|pick|cover)|can'?t\s+miss\s+(bet|parlay)|free\s+money\s+(bet|pick))\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scan text for banned phrases and auto-replace with safe alternatives. */
export function sanitizeText(text: string): { text: string; issues: ComplianceIssue[] } {
  const config = getAppConfig();
  const issues: ComplianceIssue[] = [];
  let output = text;

  for (const phrase of config.bannedPhrases) {
    // Word boundaries so "cures" never matches inside "epicures", etc.
    const pattern = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi');
    if (pattern.test(output)) {
      const replacement = config.phraseReplacements[phrase.toLowerCase()] ?? '';
      output = output.replace(pattern, replacement);
      issues.push({
        severity: 'fix',
        rule: 'banned-phrase',
        detail: `Replaced banned phrase "${phrase}" with "${replacement || '(removed)'}"`,
      });
    }
  }
  return { text: output.replace(/\s{2,}/g, ' ').trim(), issues };
}

/** Validate free text against claim rules (no rewriting). */
export function checkClaims(text: string): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  if (EARNINGS_CLAIM.test(text)) {
    issues.push({
      severity: 'block',
      rule: 'fake-earnings-claim',
      detail: 'Specific earnings framed as guaranteed/easy are not allowed.',
    });
  }
  if (MEDICAL_CLAIM.test(text)) {
    issues.push({
      severity: 'block',
      rule: 'medical-claim',
      detail: 'Medical cure or rapid-weight-loss claims are not allowed.',
    });
  }
  if (IMPERSONATION.test(text)) {
    issues.push({
      severity: 'block',
      rule: 'impersonation',
      detail: 'Content must not impersonate people or organizations.',
    });
  }
  if (BETTING_GUARANTEE.test(text)) {
    issues.push({
      severity: 'block',
      rule: 'guaranteed-betting-claim',
      detail: 'Guaranteed betting outcomes ("lock", "can\'t miss") are not allowed.',
    });
  }
  return issues;
}

/** Niches whose captions must include a disclaimer. */
const DISCLAIMER_NICHES = new Set([
  'sports betting',
  'finance',
  'side hustles',
  'real estate',
  'fitness',
]);

export function requiredDisclaimer(niche: string): string {
  if (!DISCLAIMER_NICHES.has(niche.toLowerCase())) return '';
  return getNicheProfile(niche).disclaimer;
}

/** Ensure the caption carries the niche disclaimer (appends when missing). */
export function ensureDisclaimer(caption: string, niche: string): {
  caption: string;
  added: boolean;
} {
  const disclaimer = requiredDisclaimer(niche);
  if (!disclaimer || caption.includes(disclaimer)) {
    return { caption, added: false };
  }
  return { caption: `${caption.trim()} ${disclaimer}`.trim(), added: true };
}

/** Normalize hashtags: strip '#', dedupe, drop spam tags, cap the count. */
export function cleanHashtags(hashtags: string[]): {
  hashtags: string[];
  issues: ComplianceIssue[];
} {
  const config = getAppConfig();
  const issues: ComplianceIssue[] = [];
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const raw of hashtags) {
    const tag = raw.replace(/^#/, '').trim().replace(/\s+/g, '');
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (config.spammyHashtags.includes(lower)) {
      issues.push({
        severity: 'fix',
        rule: 'spammy-hashtag',
        detail: `Removed spam hashtag #${tag}`,
      });
      continue;
    }
    if (seen.has(lower)) continue;
    seen.add(lower);
    cleaned.push(tag);
  }

  if (cleaned.length > config.videoRules.maxHashtags) {
    issues.push({
      severity: 'fix',
      rule: 'hashtag-limit',
      detail: `Trimmed hashtags from ${cleaned.length} to ${config.videoRules.maxHashtags}`,
    });
  }
  return { hashtags: cleaned.slice(0, config.videoRules.maxHashtags), issues };
}

/**
 * Full compliance pass over a video idea. Sanitizes what it can, blocks what
 * it can't. Returns the (possibly modified) idea plus all issues found.
 */
export function validateIdea(idea: VideoIdea): {
  idea: VideoIdea;
  result: ComplianceResult;
} {
  const issues: ComplianceIssue[] = [];

  // Sanitize the scenes FIRST — the ViewMax video request is built from
  // scenes[], so cleaning only the flat script/voiceover strings would let
  // banned phrases (e.g. from a user-supplied trend hook) reach the video.
  const scenes = idea.scenes.map((scene) => {
    const vo = sanitizeText(scene.voiceover);
    const ost = sanitizeText(scene.onScreenText);
    const desc = sanitizeText(scene.description);
    const broll = sanitizeText(scene.broll);
    issues.push(...vo.issues, ...ost.issues, ...desc.issues, ...broll.issues);
    return { ...scene, voiceover: vo.text, onScreenText: ost.text, description: desc.text, broll: broll.text };
  });

  // Rebuild the derived strings from the sanitized scenes so they can never
  // diverge from what the video will actually contain.
  const scriptPass = {
    text: scenes
      .map((s) => `[Scene ${s.index + 1} — ${s.durationSec}s] ${s.voiceover}`)
      .join('\n'),
    issues: [] as ComplianceIssue[],
  };
  const voPass = { text: scenes.map((s) => s.voiceover).join(' '), issues: [] as ComplianceIssue[] };
  const hookPass = sanitizeText(idea.hook);
  const captionPass = sanitizeText(idea.caption);
  issues.push(...hookPass.issues, ...captionPass.issues);

  const disclaimered = ensureDisclaimer(captionPass.text, idea.niche);
  if (disclaimered.added) {
    issues.push({
      severity: 'fix',
      rule: 'disclaimer',
      detail: `Appended required disclaimer for niche "${idea.niche}"`,
    });
  }

  const tagPass = cleanHashtags(idea.hashtags);
  issues.push(...tagPass.issues);

  // Hard blocks are evaluated on the sanitized text — if a blocking claim
  // still remains after sanitization, the idea is rejected. Scene text is
  // included so nothing block-worthy can hide in the video itself.
  const combined = [
    scriptPass.text,
    hookPass.text,
    disclaimered.caption,
    voPass.text,
    ...scenes.map((s) => `${s.description} ${s.onScreenText}`),
  ].join('\n');
  issues.push(...checkClaims(combined));

  const blocked = issues.some((i) => i.severity === 'block');
  const deduped = issues.filter(
    (issue, idx) =>
      issues.findIndex((i) => i.rule === issue.rule && i.detail === issue.detail) === idx,
  );
  const updated: VideoIdea = {
    ...idea,
    scenes,
    onScreenText: scenes.map((s) => s.onScreenText),
    brollInstructions: scenes.map((s) => `Scene ${s.index + 1}: ${s.broll}`),
    script: scriptPass.text,
    hook: hookPass.text,
    caption: disclaimered.caption,
    voiceoverText: voPass.text,
    hashtags: tagPass.hashtags,
    complianceNotes: deduped.map((i) => `[${i.severity}] ${i.rule}: ${i.detail}`),
  };

  return { idea: updated, result: { ok: !blocked, issues: deduped } };
}

/** Final gate right before an upload happens. */
export function validateUploadText(caption: string, niche: string): ComplianceResult {
  const issues = checkClaims(caption);
  const disclaimer = requiredDisclaimer(niche);
  if (disclaimer && !caption.includes(disclaimer)) {
    issues.push({
      severity: 'block',
      rule: 'disclaimer-missing',
      detail: `Caption must include the disclaimer for niche "${niche}": "${disclaimer}"`,
    });
  }
  return { ok: !issues.some((i) => i.severity === 'block'), issues };
}
