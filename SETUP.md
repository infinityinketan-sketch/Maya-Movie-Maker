# Setup guide

From zero to the app running on your phone, then on the Play Store. Do the steps in order; each one lists exactly which values to copy where. Never commit keys — this repo is **public**.

**Where each value goes**

| Value | Put it in |
|---|---|
| Supabase URL, anon (publishable) key, Worker URL | `mobile/.env` (public, bundled into the app) |
| Supabase service role key, Anthropic, Gemini, fal.ai keys, Google service account | Cloudflare Worker secrets (`npx wrangler secret put …`) |

---

## 1. Supabase (database + login) — free while building, $25/month in production

1. Create a project at supabase.com (region: Mumbai `ap-south-1`).
2. **Database:** open *SQL Editor*, paste and run each file in `supabase/migrations/` in name order (`…0001_init.sql`, `…0002_director.sql`, `…0003_shop_ads.sql`, `…0004_order_advance.sql`, `…0005_video_value_tier.sql`). (Or with the CLI: `supabase link` then `supabase db push`.)
3. **Login by email code:** *Authentication → Sign In / Providers → Email*: enable Email, keep "Confirm email" on.
   *Authentication → Emails → Templates → Magic Link*: replace the body so it shows the code, e.g.
   `<h2>Your Maya login code</h2><p style="font-size:28px"><b>{{ .Token }}</b></p>`
   (the app asks for the code; it does not use the link).
4. For real users, set up custom SMTP (*Authentication → Emails → SMTP*), e.g. Resend's free tier — Supabase's built-in mail is rate-limited.
5. **Realtime:** *Database → Publications → supabase_realtime*: check that `projects`, `shots`, `characters`, `jobs`, `wallets` are on (the migration adds them).
6. Copy from *Project Settings → API*: **Project URL**, **anon / publishable key**, **service_role / secret key**.

Upgrade to Pro before launch: free projects pause after a week without traffic.

## 2. AI provider keys — pay per use, no monthly fee

| Provider | Used for | Where |
|---|---|---|
| Anthropic | Story + shot list | console.anthropic.com → API keys. Add ~$10 credit. |
| Google AI Studio (Gemini) | Character looks + storyboard frames | aistudio.google.com → Get API key. Enable billing on the project (image models are paid-only). |
| fal.ai | Video (Veo 3.1), music (Lyria 2), final cut | fal.ai → Keys. Add ~$20 credit. |

Set a monthly spend limit or alert in each console.

## 3. Cloudflare (API, queue, media storage) — $5/month

```bash
cd backend
npm install
npx wrangler login
npx wrangler r2 bucket create maya-media
npx wrangler queues create maya-jobs
```

1. **Public media URL:** Cloudflare dashboard → R2 → `maya-media` → Settings → *Custom Domains* → connect e.g. `media.yourdomain.com` (needs a domain on Cloudflare). For testing only, you can enable the `r2.dev` public URL instead.
2. Edit `backend/wrangler.toml` `[vars]`: set `MEDIA_PUBLIC_BASE` to that URL, `GOOGLE_PLAY_PACKAGE` if you change the app id.
3. Add secrets (each command asks for the value):
   ```bash
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put FAL_KEY
   ```
4. Deploy: `npx wrangler deploy`. It prints the Worker URL, e.g. `https://maya-api.<you>.workers.dev`.
5. Put that URL in `PUBLIC_API_BASE` in `wrangler.toml` (fal.ai sends results to `<url>/v1/webhooks/fal`) and deploy again.
6. Check: open `<worker url>/v1/catalog` — you should see the credit prices.

The Workers Paid plan ($5/month) is needed for Queues.

## 4. Run the app on your phone

The app uses Google Play billing, so it runs in a **development build**, not Expo Go.

```bash
cd mobile
npm install
cp .env.example .env      # fill in Supabase URL + anon key + Worker URL
npx eas-cli@latest login  # free Expo account
npx eas-cli@latest build --profile development --platform android
```

Install the APK it gives you on your phone, then `npx expo start` on your computer and open the project from the dev build.

**Give yourself test credits** (until Play billing is live), in Supabase SQL Editor:

```sql
select public.grant_credits(
  (select id from auth.users where email = 'you@example.com'),
  2000, 'grant', 90, null, null, 'test credits');
```

**Unlock the Director tools for yourself** (they normally unlock with the first purchase):

```sql
update public.profiles set director_access = true
where id = (select id from auth.users where email = 'you@example.com');
```

Run `supabase/migrations/20261018000002_director.sql` after the first migration (step 1) if you set up the database before this feature existed.

**Turn on the shop-ad studio for your account:**

```sql
update public.profiles set role = 'operator'
where id = (select id from auth.users where email = 'you@example.com');
```

**First test film:** 15 seconds, Draft quality, vertical. Costs roughly 11 (story) + 14 per character + 14 per frame + 80 per shot ≈ 300 credits ≈ $1 of API spend.

## 5. Google Play (credit packs) — $25 one-time

1. Play Console → create app, package `com.maya.moviemaker`.
2. Build and upload: `npx eas-cli@latest build --profile production --platform android`, then upload the `.aab` to an *Internal testing* track (or `eas submit`).
3. *Monetize → Products → In-app products* → create these four (managed, consumable), activate them:

   | Product ID | Price |
   |---|---|
   | `maya_credits_100` | ₹99 |
   | `maya_credits_500` | ₹499 |
   | `maya_credits_1000` | ₹999 |
   | `maya_credits_5500` | ₹4,999 |

   Prices and credit amounts must match `CREDIT_PACKS` in `backend/src/pricing.ts`.
4. **Server verification:** Google Cloud console → create a service account → create a JSON key. Play Console → *Users and permissions* → invite the service account email → grant *View financial data* and *Manage orders and subscriptions* for this app. Then:
   ```bash
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # paste the whole JSON file
   ```
5. Add your Gmail as a *License tester* (Setup → License testing) so test purchases are free.

## 6. Before you publish

- [ ] Privacy policy and terms pages (required by Play) → set `EXPO_PUBLIC_PRIVACY_URL` and `EXPO_PUBLIC_TERMS_URL`.
- [ ] Play *Data safety* form: email address, user content (prompts, generated media), purchase history; data is deletable in-app (Settings → Delete my account).
- [ ] Play *AI-generated content* policy: the app has provider safety filters and the story prompt refuses real people and copyrighted characters; add an in-app "Report" link to your support email if Play asks.
- [ ] App icon and splash: replace the files in `mobile/assets/images/`.
- [ ] Spend alerts set on Anthropic, Google and fal.ai.

## Things to check on the first live run

These depend on provider behaviour that can only be confirmed with real keys:

1. **Final cut audio.** The final cut uses fal.ai's FFmpeg compose with the shot videos as one track and the music as another. Confirm the shots' own dialogue/sound is kept in the output. If it is dropped, tell me and I'll switch the cut to a small FFmpeg render service.
2. **Gemini image model id.** `GEMINI_IMAGE_MODEL` defaults to `gemini-nano-banana-2.1`. If storyboard frames fail with "model not found", set it to `gemini-3.1-flash-image` in `wrangler.toml`.
3. **HD Value vs Standard.** Film the same 3 shots on HD Value (LTX-2, $0.06/s) and Standard (Veo 3.1 Fast, $0.15/s): switch the film's quality and re-take — each shot screen shows the new and previous take together. If LTX-2 keeps faces, frames and Marathi/Hindi dialogue well enough, use it as your default HD.
4. **Dialogue language.** Veo speaks Hindi and other Indian languages unevenly; try a Hindi and an English shot before promising languages in the store listing.

## Changing prices

All prices live in `backend/src/pricing.ts` (provider unit prices, `USD_INR`, `CREDIT_MARKUP` in `wrangler.toml`). Run `npm test` after any change: the tests fail if any credit pack could lose money when every credit is spent through Google Play.
