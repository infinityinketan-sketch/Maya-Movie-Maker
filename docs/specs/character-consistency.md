# Spec: Character consistency and costly-retake prevention

Status: proposed · Owner: Ketan · Oct 2026

## Problem

A paid video shot can come back with a character who changes partway through. Example from testing: a shot where the man kneels, bows with his face to the ground and lifts his head again. When the face returned, the model invented a new person. The 8 s Veo 3.1 shot was wasted, and a retake costs the same again.

Each shot costs 53–845 credits, so one bad shot can wipe out the margin on a whole film. Maya must catch risky shots **before** video credits are spent, and save what it can **after**.

## What already exists (keep)

- **Cast:** one reference look per character, reused in every storyboard frame (Nano Banana 2.1).
- **Storyboard approval:** the user approves a still frame before any video is paid for.
- **Image-to-video:** every tier (`backend/src/pricing.ts` → `VIDEO_MODELS`) starts from the approved frame through `image_url`.
- **Result checks** (`backend/src/reliability.ts`): real MP4, sound, length, aspect ratio.

The gap: nothing checks whether a shot's *action* is likely to break a face, and nothing checks the face in the finished clip.

## 1. Character sheet (upgrade Cast)

- Generate **3 views per character**: front, profile, three-quarter. Today there is one.
- Store a short **identity text** per character (age, build, hair, face, clothes, marks). The story writer fills it; the user can edit it.
- The identity text is inserted **in full** into every storyboard and video prompt for shots that include that character. No placeholders, no user copy-paste.
- Price: 3 images instead of 1 → 42 credits per character instead of 14 (same ×3 rule).

## 2. Shot risk checker (before storyboard)

Runs on every shot after the story is written and again whenever a shot is edited. It uses deterministic rules first, then a Claude pass for anything the rules miss. It is free to the user and folded into the story price.

| Risk | Example | Default fix |
|---|---|---|
| **Face hidden then revealed** | bowing and rising, turning away and back, walking behind a tree | End the shot while the face is hidden; the next shot starts with the face visible |
| **Close contact between characters** | hugs, touching feet, fighting | Shoot from one side, or split into two shots |
| **More than one big action** | walks in, kneels, bows, sits up in 8 s | One action per shot; split the rest |
| **Big camera move around a character** | 180° orbit, crane over head | Locked-off or slow push-in |
| **Lighting or setting change on a character** | walks from sunlight into a dark hut | Cut on the change |
| **Character enters from off-screen** | person appears mid-shot | Character in frame from the first frame |

Output per shot: `risk: low | medium | high`, the reasons, and a suggested rewrite.

- **High** risk: the storyboard button says "Fix shot first". The user can apply the rewrite in one tap or override with a confirm dialog ("This shot often changes the face. Retakes cost credits.").
- **Medium:** a warning chip on the shot card.
- The same rules are added to the story-writer prompt and to *Director's review* (`director.ts`), so most risky shots are never written.

Data: add `risk_level`, `risk_reasons jsonb`, `risk_override boolean` to `shots`.

## 3. Start and end frames

- For shots with a character, send the approved storyboard frame as the **start frame** (already done).
- Where the model supports it, also send an **end frame**: either the next shot's storyboard frame (for continuous action) or a second still of the same shot. This pins the face at both ends. Check fal.ai support for each tier before turning it on. Veo 3.1 and LTX-2 differ.
- For continuous action between shots, the next shot can start from the **last frame of the previous finished clip** instead of its storyboard frame. The user picks this per shot ("Continue from last shot").

## 4. Identity check after generation

After the existing result checks pass:

1. Pull one frame per second from the clip.
2. Detect faces and compare each against the character sheet with a face-embedding model (self-hosted or a cheap fal.ai endpoint; cost must stay under 1 credit per shot).
3. Store a per-second score. A score below the threshold means **drift** at that second.

What happens on drift:

| Where drift starts | Action |
|---|---|
| After ≥ 75% of the shot (e.g. second 6 of 8) | **Trim** to the last good second and keep the shot. No retake needed. |
| Earlier | Mark the shot *Face changed*, show the user where, and offer: keep anyway, keep the trimmed part, or retake. |

Trimming is done in the final cut (the timeline already trims to shot length), so it costs nothing extra.

## 5. Retakes and margin

Identity drift is **not** a provider failure, so it does not trigger an automatic refund. Rules:

- A retake is a new paid generation at the normal price. This keeps the "no free deliverables" rule and the no-loss rule.
- The UI always shows the retake price before the user confirms.
- Shop-ad orders: the operator's quoted price should include one expected retake per 3 shots. The order form's cost and profit estimate adds this buffer (`ads.ts`).

**Open decision for Ketan:** should high-risk shots that the user *did not* override and that still drift get a partial credit back? The ×3 markup can absorb it, but it is a cost at zero margin for that shot. Default in this spec: no.

## 6. Build order

1. Risk rules in the story writer and Director's review prompts (prompt-only change, no schema).
2. Risk checker + `shots` columns + storyboard gating in the app.
3. Identity text inserted into every prompt; 3-view character sheet.
4. Identity check + auto-trim.
5. End-frame and continue-from-last-frame support per tier.
6. Retake buffer in the shop-ad cost estimate.

## Tests

- Risk rules: fixtures for each row of the risk table, including the bowing shot from testing (must be flagged high and rewritten to end while bowed).
- Prompt builder: every character in a shot has its full identity text in both the storyboard and video prompts.
- Drift handling: synthetic score series → correct trim point or *Face changed* state.
- Pricing: character sheet = 3 images; retake price equals the original shot price; the shop-ad estimate includes the buffer.
