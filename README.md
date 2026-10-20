# Maya — All in 1 movie maker

Type an idea, get a finished short film. Maya writes the story, designs the characters, draws a storyboard you approve, films every shot with AI video, scores it, and cuts it together — on an Android phone (iPhone later from the same code).

## How a film is made

| Step | What happens | Model | Credits (default prices) |
|---|---|---|---|
| 1 Story | Idea → title, characters, scenes, shot list with dialogue (films up to 5 minutes) | Claude Sonnet 5.5 | 11–55 per story (15 s–5 min film) |
| 2 Cast | One reference look per character, reused in every shot | Nano Banana 2.1 (Gemini) | 14 per character |
| 3 Storyboard | One still frame per shot; you approve before any video is paid for | Nano Banana 2.1 | 14 per frame |
| 4 Film | Each approved frame becomes a 4/6/8 s clip with native dialogue and sound | Draft: Veo 3.1 Lite 720p · HD Value: LTX-2 1080p · Standard: Veo 3.1 Fast · Premium: Veo 3.1 (all via fal.ai) | 53–845 per shot (6 s shot: 80 / 96 / 238 / 634) |
| Music | One instrumental score, looped under the film | Lyria 2 via fal.ai | 27 |
| Final cut | Shots joined in order with the score | fal.ai FFmpeg compose | 4 per minute |

### Director tools (paid members)

Unlocked automatically by the first credit-pack purchase.

| Tool | What it does | Credits |
|---|---|---|
| Camera library | 42 shot sizes, angles, moves, lenses and lighting set-ups, each explained ("low angle = power or menace") and turned into the right words for the video model | free |
| Ask the Director | Three ways to shoot one shot, matched to the shots before and after, with why each works; one tap applies it | 7 |
| Director's review | Notes on the whole shot list (establishing shots, variety, angles, 180° rule, dialogue coverage, pacing, AI-video pitfalls), applied per note or all at once | 6–24 by shot count (16 for 10 shots) |

The same film-craft rules also guide the story writer for every user, so first drafts already plan varied, motivated shots.

### Shop-ad studio (operator account)

For selling done-for-you ads to local businesses over WhatsApp. Visible only to accounts with the `operator` role.

1. **New order:** customer name and WhatsApp number, shop name and type, area, offer, occasion (Diwali, Ganpati, Gudi Padwa…), Marathi/Hindi/English, length (15/20/30 s), quality, price. Add a photo of the real shop or product. The form shows your API cost and profit before you start.
2. **Studio:** Maya writes an ad-shaped script (hook → shop and happy customers → owner saying the offer and shop name). The shop photo is a reference in every storyboard frame. Film, add music and cut as usual.
3. **Poster:** a WhatsApp Status poster with the shop name, offer and contact written in Devanagari or Latin script, built from the shop photo (14 credits).
4. **Advance first:** no free work. An order waits as *Waiting for advance* until at least 50% of the price is recorded; the server refuses to start the script before that. One tap sends the customer a WhatsApp message asking for the advance.
5. **Deliver:** send the Reel and poster files, or open the customer's WhatsApp chat with the links and the balance due. Mark delivered and fully paid; the orders screen totals received and still to collect.

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
