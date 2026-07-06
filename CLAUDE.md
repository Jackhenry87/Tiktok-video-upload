# CLAUDE.md — Tiktok-video-upload

Project memory for Claude Code. Global defaults live in `~/.claude/CLAUDE.md`;
this file adds the rules specific to this repo.

## What this project is

An original-content TikTok automation app: researches trend signals,
generates video ideas, creates videos through the ViewMax connector, saves
drafts for **manual human review**, and uploads approved videos through
**TikTok's official API**. The repo is currently an empty scaffold (README
only) — establish structure as code lands and record it here.

## Hard rules

- **Official TikTok API only** (Content Posting API). Never automate the
  TikTok web/app UI, and never bypass authentication, rate limits, CAPTCHAs,
  or other platform protections.
- **Human-in-the-loop is a feature, not a bug**: videos are saved as drafts
  for manual review before upload. Never add an auto-publish path that skips
  owner approval unless the owner explicitly asks for one.
- Original content only. No engagement manipulation (fake likes/follows/
  views), no spam posting, no scraping in violation of TikTok's terms.
- Respect API rate limits and TikTok's developer terms; back off on 429s.
- OAuth tokens and API credentials go in `.env` (gitignored) or the deploy
  platform's secret store — never committed, printed, or logged.

## Conventions (until code establishes its own)

- Keep the pipeline stages separate and independently testable:
  trend research → idea generation → video creation (ViewMax) → draft
  storage → review → upload.
- Add tests alongside the first real modules; wire up lint/typecheck early.
- Update `README.md` when the pipeline's public behavior changes.
