import { getAppConfig, getNicheProfile } from '../config/appConfig';
import type { SceneBreakdown, TrendSignal } from '../types';

/**
 * Template-driven script generation. Produces ORIGINAL scripts inspired by a
 * trend topic — never copied from other creators' videos or captions.
 *
 * Structure follows the video assembly rules:
 *   scene 0: strong hook (~2s)
 *   scenes 1-3: short content beats (2-4s each) with a pattern interrupt
 *   final scene: clear CTA
 */

export interface GeneratedScript {
  hook: string;
  script: string;
  scenes: SceneBreakdown[];
  onScreenText: string[];
  voiceoverText: string;
  brollInstructions: string[];
  estimatedDurationSec: number;
}

/** Deterministic template pick so re-runs are stable for the same topic. */
export function hashPick<T>(items: readonly T[], seed: string, salt = 0): T {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const index = Math.abs(h) % items.length;
  return items[index]!;
}

const HOOK_TEMPLATES = [
  'Stop scrolling — {topic} in under 30 seconds.',
  'Nobody explains {topic} this simply.',
  "Here's what most people get wrong about {topic}.",
  'I tested {topic} so you don\'t have to.',
  '3 things to know about {topic} before everyone else.',
] as const;

const BEAT_TEMPLATES = [
  {
    beats: [
      'First: the one thing that actually matters about {topic}.',
      'Second: the mistake almost everyone makes here.',
      'Third: the simple way to start today.',
    ],
    label: 'three-point list',
  },
  {
    beats: [
      "Here's the problem: most people approach {topic} completely backwards.",
      'What works instead is starting small and staying consistent.',
      'A quick example of how that looks in real life.',
    ],
    label: 'problem-solution-example',
  },
  {
    beats: [
      'Myth: {topic} is complicated or only for experts.',
      'Reality: the basics fit in one short video.',
      'Try this one step this week and see the difference.',
    ],
    label: 'myth-vs-reality',
  },
] as const;

const PATTERN_INTERRUPTS = [
  'punch-in zoom + text slam',
  'hard cut to b-roll',
  'color flash + emoji overlay',
  'whip-pan transition',
  'freeze frame with arrow annotation',
] as const;

const BROLL_LIBRARY: Record<string, string[]> = {
  finance: ['phone showing a budgeting app', 'coins stacking timelapse', 'notebook with a written plan'],
  'sports betting': ['stadium crowd wide shot', 'stats dashboard on a laptop', 'notepad with a staking plan'],
  'side hustles': ['laptop at a kitchen table', 'packing an order for shipping', 'calendar with blocked hours'],
  'real estate': ['walkthrough of a bright apartment', 'keys handed over', 'spreadsheet of monthly costs'],
  'ai tools': ['screen recording of the tool in action', 'split screen before/after', 'timer counting down'],
  'college life': ['campus walking shot', 'desk study setup', 'whiteboard checklist'],
  fitness: ['gym setup shot', 'form demonstration close-up', 'water bottle + towel detail'],
  'local business marketing': ['storefront exterior', 'owner greeting a customer', 'phone showing reviews page'],
};

export function generateScript(trend: TrendSignal): GeneratedScript {
  const config = getAppConfig();
  const rules = config.videoRules;
  const profile = getNicheProfile(trend.niche);
  const topic = trend.topic;

  const hook =
    trend.suggestedHook && trend.suggestedHook.length > 10
      ? trend.suggestedHook
      : hashPick(HOOK_TEMPLATES, topic).replace('{topic}', topic.toLowerCase());

  const beatSet = hashPick(BEAT_TEMPLATES, topic, 7);
  const cta = trend.suggestedCta || `Follow for more ${trend.niche} in 30 seconds a day.`;
  const brollOptions = BROLL_LIBRARY[trend.niche.toLowerCase()] ?? [
    'relevant close-up detail shot',
    'hands-on demonstration',
    'clean desk setup shot',
  ];

  const scenes: SceneBreakdown[] = [];
  let index = 0;

  scenes.push({
    index: index++,
    durationSec: rules.minSceneSec,
    description: `Hook — direct to camera, high energy: "${hook}"`,
    onScreenText: shortText(hook),
    voiceover: hook,
    broll: 'none — face to camera or bold title card',
    patternInterrupt: 'text slam on beat 1',
  });

  beatSet.beats.forEach((beatTemplate, i) => {
    const line = beatTemplate.replace('{topic}', topic.toLowerCase());
    scenes.push({
      index: index++,
      durationSec: Math.min(rules.maxSceneSec, rules.minSceneSec + 1 + (i % 2)),
      description: `Beat ${i + 1} (${beatSet.label}): ${line}`,
      onScreenText: shortText(line),
      voiceover: line,
      broll: brollOptions[i % brollOptions.length]!,
      patternInterrupt: hashPick(PATTERN_INTERRUPTS, topic, i),
    });
  });

  scenes.push({
    index: index++,
    durationSec: rules.minSceneSec + 1,
    description: `CTA — clear ask: "${cta}"`,
    onScreenText: shortText(cta),
    voiceover: cta,
    broll: 'end card with handle and follow button animation',
    patternInterrupt: 'zoom-out + subscribe/follow pointer',
  });

  const voiceoverText = scenes.map((s) => s.voiceover).join(' ');
  const script = scenes
    .map((s) => `[Scene ${s.index + 1} — ${s.durationSec}s] ${s.voiceover}`)
    .join('\n');
  const estimatedDurationSec = Math.min(
    rules.maxDurationSec,
    Math.max(rules.minDurationSec, scenes.reduce((sum, s) => sum + s.durationSec, 0)),
  );

  return {
    hook,
    script,
    scenes,
    onScreenText: scenes.map((s) => s.onScreenText),
    voiceoverText,
    brollInstructions: scenes.map((s) => `Scene ${s.index + 1}: ${s.broll}`),
    estimatedDurationSec,
  };
}

/** On-screen text should be scannable: keep it to ~7 words. */
function shortText(line: string): string {
  const words = line.replace(/["""]/g, '').split(/\s+/);
  return words.length <= 7 ? words.join(' ') : `${words.slice(0, 7).join(' ')}…`;
}

export function musicGuidanceFor(trend: TrendSignal): string {
  const moods: Record<string, string> = {
    finance: 'upbeat lo-fi or light percussion, licensed/royalty-free only',
    'sports betting': 'energetic stadium-style beat, licensed/royalty-free only',
    'side hustles': 'motivational mid-tempo beat, licensed/royalty-free only',
    'real estate': 'clean corporate groove, licensed/royalty-free only',
    'ai tools': 'futuristic synth pulse, licensed/royalty-free only',
    'college life': 'bright pop instrumental, licensed/royalty-free only',
    fitness: 'high-BPM workout track, licensed/royalty-free only',
    'local business marketing': 'friendly acoustic rhythm, licensed/royalty-free only',
  };
  return (
    moods[trend.niche.toLowerCase()] ??
    'neutral upbeat instrumental, licensed/royalty-free only'
  );
}
