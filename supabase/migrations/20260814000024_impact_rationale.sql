-- ============================================================================
-- nestle-scm — articles.impact_rationale: the forcing function for grading
--
-- Favourability was grading the TONE OF THE ARTICLE rather than the impact on
-- Nestlé. Measured on 161 coded rows, "PSA Antwerp adds new STS crane at
-- Noordzee Terminal" and "T-Mining joins DCSA+ to advance Secure Container
-- Release standards" both sat at 'Very favourable' — the top of the scale —
-- while neither changes anything about moving a Nestlé container. At the other
-- end, "MSC fined $6 million over Charleston vessel incident" (bad for MSC,
-- irrelevant to Nestlé) shared 'Very unfavourable' with "Typhoon Dolphin
-- Deepens China Port Congestion, Stranding 2.4M TEUs".
--
-- This column is the fix, and it is a fix by construction rather than by
-- instruction. The coding call must now name — in one sentence, BEFORE it
-- grades — the specific lane, port, carrier service or cost that the event
-- affects. A crane at Antwerp has no Nestlé lane to name, so it cannot reach an
-- extreme grade however upbeat the headline reads. Asking the model to "be
-- stricter" would not have achieved that; requiring evidence does.
--
-- It is also the only part of the grade a curator can check. "Very
-- unfavourable, relevance 95" is a claim; "Chinese port congestion is holding
-- 2.4M TEUs, directly delaying Nestlé's Asia-origin export lanes" is a claim
-- with a reason attached, readable by someone with no media-measurement
-- background. It is displayed in the panel and available to the newsletter for
-- that reason.
--
-- Nullable, and no CHECK: the write path is code, and rows coded before this
-- migration legitimately have none until they are re-coded. The backfill
-- (npm run recode) populates every previously-coded row.
-- ============================================================================

alter table public.articles add column impact_rationale text;

comment on column public.articles.impact_rationale is
  'One sentence naming the specific Nestlé AOA lane, port, carrier service or cost this article affects — written by the coding pass BEFORE it grades, as the forcing function that keeps favourability about impact rather than tone. Empty is not a valid coded state: no nameable impact means Neutral with relevance under 20.';

-- ---------------------------------------------------------------------------
-- ai_relevance_score has existed since migration 0001 and has never been
-- written by anything (161/161 NULL at the time of this migration). It now
-- carries MAGNITUDE, separated from the DIRECTION that ai_sentiment carries.
--
-- That separation is the substance of this change. A typhoon stranding 2.4M
-- TEUs and a $6m fine on a carrier are both "unfavourable-ish" in tone, and
-- are 95 and 5 apart in what they mean for Nestlé. With only a five-point
-- direction field to express both, every judgement collapsed towards the
-- extremes — 42% of the corpus sat at 'Very unfavourable' — and the field
-- ranked nothing.
-- ---------------------------------------------------------------------------
comment on column public.articles.ai_relevance_score is
  'Magnitude, 0-100: how much this matters to Nestlé AOA container movement. Separate axis from ai_sentiment, which carries direction only. Anchors: <20 no identifiable lane impact; 20-39 indirect; 40-59 a used lane, modest effect; 60-79 material and measurable; 80+ severe disruption to a primary lane.';

comment on column public.articles.ai_sentiment is
  'Direction only — one of the five favourability tiers, judged against Nestlé AOA container movement, NOT the tone of the article and NOT whether the news is good for the carrier, port or vendor it is about. Magnitude lives in ai_relevance_score. Default is Neutral; the grade moves off it only when impact_rationale can name what changes.';

-- Ranking the week's stories is "most severe first", which is an
-- ai_relevance_score sort over a period of active coded rows.
create index articles_relevance_idx
  on public.articles (ai_relevance_score desc nulls last)
  where coded_status = 'coded' and status = 'active';
