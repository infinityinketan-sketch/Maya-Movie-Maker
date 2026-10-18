# Maya — All in 1 movie maker

Type an idea, get a finished short film. Maya writes the story, designs the characters, draws a storyboard you approve, films every shot with AI video, scores it, and cuts it together — on an Android phone (iPhone later from the same code).

## How a film is made

| Step | What happens | Model | Credits (default prices) |
|---|---|---|---|
| 1 Story | Idea → title, characters, scenes, shot list with dialogue | Claude Sonnet 5.5 | 11–27 per story (15 s–2 min film) |
| 2 Cast | One reference look per character, reused in every shot | Nano Banana 2.1 (Gemini) | 14 per character |
| 3 Storyboard | One still frame per shot; you approve before any video is paid for | Nano Banana 2.1 | 14 per frame |
| 4 Film | Each approved frame becomes a 4/6/8 s clip with native dialogue and sound | Veo 3.1 Lite / Fast / Pro via fal.ai | 53–845 per shot |
| Music | One instrumental score, looped under the film | Lyria 2 via fal.ai | 27 |
| Final cut | Shots joined in order with the score | fal.ai FFmpeg compose | 4 per minute |

1 credit sells for ₹1. Every action costs **API price × 3** in credits (rounded up), so even a user who spends every credit through Google Play (18% GST + 15% Play fee) leaves a profit. Failed jobs refund automatically. See `backend/src/pricing.ts` and the tests in `backend/test/pricing.test.ts`.

## Repository

```
supabase/   Postgres schema, row-level security, credit ledger functions, SQL tests
backend/    Cloudflare Worker API (Hono): auth, charged jobs, AI providers, queue, webhooks, Google Play checks
mobile/     Expo React Native app (Android first): login, film studio, storyboard, player, wallet
```

```
App ──▶ Worker API ──▶ charge credits ──▶ Queue ──▶ Claude / Gemini (direct)
 ▲           │                                   └──▶ fal.ai (video, music, cut) ──webhook──▶ Worker ──▶ R2
 └── Supabase realtime (status of every shot, wallet balance)
```

- The app only **reads** its own rows from Supabase (row-level security). Everything that costs money goes through the Worker, which charges credits *before* calling a provider and refunds on any failure.
- Idle cost is about $31/month (Supabase Pro + Workers Paid + domain). Everything else is pay-per-use.

## Commands

```bash
# database tests (needs local Postgres binaries)
supabase/tests/run.sh

# backend
cd backend && npm install
npm test            # pricing, plan parsing, render timeline, webhook signatures
npm run typecheck
npm run dev         # local worker (needs .dev.vars)

# app
cd mobile && npm install
npx tsc --noEmit && npx eslint src
npx expo start      # with a development build on your phone
```

Full first-time setup — accounts, keys, deploy, Play Store — is in **[SETUP.md](SETUP.md)**.
