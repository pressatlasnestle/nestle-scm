# Media Intelligence platform — "sorting and coding" brief: findings

**What this is.** A read of the CARMA-lineage Media Intelligence brief set in
`Software_Modules`, extracting *only* the sorting/coding content — taxonomy design,
inclusion/exclusion logic, gate/AND/OR structure, coding schemes, source
classification, and relevance judgement — and comparing it against what
`nestle-scm` already implements.

Architecture, tech stack, wireframes, UI layout, keyboard navigation and bug lists
in the source documents are **out of scope for this pass** and are not summarised
here, even where they sit in the middle of a section that is otherwise in scope.

**No recommendations.** This document is "what does the brief say, and how does it
compare". What to change comes after.

---

## Source documents read

| Document | Role |
|---|---|
| `R2 Files/05_Final Check/TOPIC VALIDATION.docx` | The sorting brief proper — coding designation rules, topic assignment validation, coding restrictions |
| `R1 Files/03_Research Module/03_Software_Research Module.docx` | The research/coding brief — per-article coding screens, auto-assignment intent, favourability model |
| `R1 Files/02_Client Project/02_Software_Client_Project Module (1).docx` | Project setup — where the codebook, target media list and region logic are *defined* |
| `R1 Files/01_Media Module/01_Software Brief_Employee and Media DB (1).docx` | Media universe — media records, aliasing, circulation, import/export |
| `R1 Files/04_QC Module/04_QC Module.docx` | QC — exclude/include, duplicates, mass coding, merges |
| `R2 Files/09_Project Creation/Amazon India_CARMA Research Matrix_24.02.2023.docx` | A live, filled-in codebook |
| `R2 Files/05_Final Check/Meesho_CARMA Research Matrix_29 Mar 23.docx` | A second live codebook |
| `R1 Files/03_Research Module/01_Additional points_Research Module.docx`, `.../02_Additional points_Client_Project_30 July.docx`, `.../01_Additional points_Employee and Media DB_23 June 2021.docx` | Client review comments carrying rule corrections |
| `R3 Power BI Tests/20 Mar 23_Test/*.xlsx` | The realised output shape (see Outputs) |

### Note on the `nestle-scm` baseline used

The prompt pointed at `docs/schema-brief.md` for the gate/tier/priority/match_type/
cluster shape. **That file does not contain them** — it documents `keywords` as
`id / keyword / is_active / added_by / created_at` and `sources` without
`tier`/`priority`. It predates migrations `0009`–`0021`.

The comparison below is therefore made against the **code and migrations**, which are
authoritative:

- `supabase/migrations/20260810000010_source_keyword_taxonomy_columns.sql` — adds
  `sources.tier / priority / content_type / region / handling_notes` and
  `keywords.gate / cluster / match_type`
- `supabase/migrations/20260810000009_...` — `keywords.list_type`, `articles.matched_negative_keywords`
- `supabase/migrations/20260811000017_keyword_variations.sql` — `keywords.variations`
- `supabase/migrations/20260811000018_...` — `articles.keyword_mention_count`, `articles.source_channel`
- `src/lib/ingestion/match.ts` — the two-gate matcher itself

`schema-brief.md` being stale is itself worth knowing, since it is described in its
own header as "the locked contract for the database".

---

## The single most important structural finding

The brief and `nestle-scm` do not disagree about how to sort articles. **They are
solving two different problems, and each one's mechanism is the other's blind spot.**

| | Brief | `nestle-scm` |
|---|---|---|
| What decides an article is in scope | **The media universe.** "once the media universe for a project is capped and setup the feed (rss/csv), it will simply ignore all articles from media other than the capped set. This is a very important function" | **The keywords.** Gate 1 AND Gate 2 over headline + body (`match.ts:300-304`) |
| What keywords do | Highlight terms in the reading pane; filter which articles get pulled into a *batch* | Gate capture entirely |
| What decides an article's meaning | A human coder assigning numbered codes from a project codebook | Nothing yet — `ai_*` columns exist, nothing writes them |
| Sentiment | Deterministic additive point model over coded fields | `ai_sentiment` column, unimplemented |

In the brief, **keywords never gate capture.** Read literally, the brief's only
inclusion gate is source membership; everything downstream is classification by a
person. In `nestle-scm`, source membership is the *loose* filter (whole-universe
mode admits everything not explicitly negative) and keywords are the *tight* one.

That inversion is the frame for everything below.

---

## 1. Already implemented

### 1.1 Capped media universe → `sources.list_type` + `app_settings.universe_mode`

The brief's most emphatic sorting rule is a source-membership gate:

> "what we would want is a default access to entire media universe. If we need to
> restrict the media list for a project, then we can do that either by bulk feeding
> the media ids or have a selection menu."
> "once the media universe for a project is capped and setup the feed (rss/csv), it
> will simply ignore all articles from media other than the capped set."

This is implemented almost exactly, including the two-mode framing:

```
src/lib/ingestion/run.ts:65-66
positive_only takes list_type='positive' only; whole_universe takes
everything except list_type='negative'. Defaults to whole_universe when the ...
```

```
src/lib/ingestion/run.ts:112-113
  ? query.eq("list_type", "positive")
  : query.or("list_type.is.null,list_type.neq.negative");
```

The brief's "default access to entire media universe" is `whole_universe`; its
"capped set" is `positive_only`. The Research Module's harder rule — "the system
will not allow you to enter or select a Media ID that does not match the media from
the project's target media list" — is the same constraint expressed at coding time
rather than fetch time.

### 1.2 Media tiering → `sources.tier` / `sources.priority`

> "Ad Hoc Grouping: Use to create a grouping of media. For example, you can group
> media into tiers or other types of specialized categories. This step would
> eliminate the need to create media groups within Business Objects or other data
> mining software or in the media db itself"

`sources.tier` and `sources.priority` exist and carry exactly this
(`'T1 - Core ocean freight'`, `'PR wires'`, `'Critical'`..`'Block'`), alongside
`content_type` and `region`. One caveat, stated plainly: the migration says
"no matching logic reads them yet", and that is still true except for
`run.ts:89-98`, which reads `tier` only to detect the single value
`'Alerts - Google standing search'` and route it to the `google_alerts` channel.
**Tier and priority are stored and displayed; they do not affect sorting.**

### 1.3 Exact-phrase vs. loose matching → `keywords.match_type`

The brief distinguishes match modes in the batch-assembly keyword filter:

> "a single keyword: microsoft"
> "a string of keywords separated by commas, the system will search for each of the
> keywords (same as using OR): microsoft, windows, office, vista"
> "an exact phrase, indicated by quotation marks: "bill gates""

`keywords.match_type` carries `'Exact phrase' | 'Stem / partial' | 'Entity'` and
`compileVariant()` (`match.ts:126-139`) executes them. The brief's OR-across-commas
is `nestle-scm`'s OR-within-a-gate. The brief's quoted exact phrase is the default
non-stem branch.

### 1.4 Exclude vs. delete, and permanence → `articles.status`

The QC brief separates the two:

> "Exclude Articles: We can exclude articles, not required during QC process but
> will be available in the database, and will show up during BO Queries"
> "Include Articles: We can include, excluded articles using this function"

and TOPIC VALIDATION marks article deletion as `Soft Delete`. `nestle-scm` has
`articles.status` in `('active','excluded','deleted')`, curate-role exclude/include,
bulk exclude in the Articles panel, and soft delete with a permanent tombstone —
`schema-brief.md:124` "Found, `status` in `('excluded','deleted')` → **skip entirely,
never resurrect.**"

The brief's re-include path implies exclusion is *not* permanent there; ours is
reversible by an admin editing status, but re-ingestion will never resurrect. Close
enough to call implemented, with that nuance noted.

### 1.5 Duplicate identification → `articles.dedup_key`

> "LIST OF POSSIBLE DUPLICATES: This function is used to identify possible duplicate
> articles. Not sure about the algorithm used"

`nestle-scm` dedups on a normalized `headline + media + published_date + byline`
fingerprint at ingest. Same goal; see §3.6 for where the two diverge.

### 1.6 Term variants and separator spellings → `keywords.variations` + matcher normalisation

The brief repeatedly asks for variant tolerance — media names ("Economic Times",
"Economic Times (Delhi)", "The Economic Times" → one Media ID), wildcard search
(`PC%MAGAZINE` matching `PCMAGAZINE.COM` / `PC MAGAZINE` / `PC-MAGAZINE`), and
regional/translated headlines. For *keywords*, `nestle-scm` covers this well:
`variations` for non-derivable synonyms, and `joinWithSeparatorVariants()`
(`match.ts:104-110`) making "container ship" / "container-ship" / "containership"
one term. For *media names*, it does not — see §2.9.

---

## 2. Described in the brief, not built

This is the bulk of the brief. `nestle-scm` has no coding layer at all; the brief is
almost entirely about one.

### 2.1 The codebook: Topic Category → Topic → Sub-Topic

A three-level numbered taxonomy, defined per project:

- **Issue Category** (renamed **Topic Category**) with a Sequence Number that is
  unique and drives export sort order
- **Issue** (renamed **Topic**) inside it, carrying a numeric code
- **Sub-Issue** under an Issue — "for an issue 'management team' sub-issues might
  include 'Bill Gates' and 'Steve Ballmer'"

`nestle-scm` has `keywords.cluster` as a single flat thematic grouping string
("Chokepoints & routing", "Ports - Asia"). That is one level, unnumbered, and it
groups *matching terms*, not *classification codes*. There is no code, no category
object, no sequence, no hierarchy.

The live matrices show the taxonomy in use — 46 numbered News Themes for Amazon
India, grouped under headed categories (PLACEMENT, STORY TYPE, ARTICLE DYNAMICS,
COMPETITIVE PROMINENCE, NEWS THEMES, MESSAGES).

### 2.2 Coding designation — the mandatory/cardinality rules

The core of TOPIC VALIDATION. Four settings per category:

| Designation | Rule |
|---|---|
| `Not Mandatory` | may code zero, one, or several from the category |
| `Mandatory, code only ONE Topic` | "must code one and only one Topic from the category. They will receive an error alert if they fail to code a required topic" |
| `Mandatory, multiple Topics possible` | "must code at least one Topic from the category but can code several" |
| `Mandatory Upon Condition: Topics =` | category becomes mandatory *if* one or more nominated other topics are coded; then itself either code-one or code-many |

The conditional form is an explicit **OR trigger**: "If you add multiple topics, the
system will make the category mandatory for coding if any one of the multiple topics
is coded."

The client flags these as non-negotiable:

> "All of above conditions are mandatory, as they help us eliminate several QC
> steps…like mandatory cleanup, conditional cleanup, etc, - therefore important"

The matrices apply them: `PLACEMENT (Mandatory, code only one)`,
`COMPETITIVE PROMINENCE (Mandatory, code only one)`,
`NEWS THEMES (Mandatory, Code as many)`, `CHARTERS (Code only one)`,
`SPOKESPEOPLE (Code when quoted)`.

Nothing in `nestle-scm` corresponds. Its only cardinality rule is the two-gate AND.

### 2.3 Linked codes — auto-coding one code from another

> "Coding for an issue can be linked to the coding of another issue, so that when the
> current issue is coded, another linked issue is automatically coded by the system.
> For example, you might want to link an issue 'Bill Gates' to an issue 'management'"

Explicitly **directional**:

> "the issue link operates in one direction only … You can however, apply the link in
> both directions by setting the link in the issue setup for both of the issues"

Messages link into issues the same way ("link a message 'Company has strong earnings'
to an issue 'earnings/finances'"). Not built.

### 2.4 Inter-code exclusion rules

The matrices carry exclusion logic *between codes* — a genuine inclusion/exclusion
structure that has no counterpart in `nestle-scm`:

- `34. Counterfeit products (Don't code #26)`
- `36. Job cuts / layoffs (Don't code #27)`
- `37. Job creation (Don't code #27)`
- `39. Regulatory/ CCI/ investigations (Code for action from all regulatory bodies + don't code #31)`
- `40. Policy (… + don't code #31)`
- `42. Company response (for reputational stories ONLY)`
- `36. Festive Sale Event (when 502 is coded, then #42 is not to be coded)` (Meesho)

And the inverse — mandatory co-coding:

- `32. Festive Sale Event (added Sept 21 – to be coded additionally with 42 if the event is any 'Festive Sale'`
- `31. Sale Event (… all other sale events will be coded with issue #42 …)`

Plus a scope condition on entity eligibility:

- `Corporate (wef Jan 2023) (Etsy, Shopify, Ebay) [only code if Ecommerce exports is mentioned in headline/first paragraph]`

That last one is the brief's one genuine *positional* relevance rule — in-scope only
if the topic appears in headline or first paragraph. `nestle-scm` has one positional
rule (`match.ts:329`, Gate 1 anchor in the headline rescues an exclusion hit), but it
is a different rule serving a different purpose.

### 2.5 Coding restrictions and multiplicity

- **Multiple Coding**: "permit researchers to code the issue multiple times within a
  single article … if a client wants to track how many times a certain branding
  phrase, URL or spokesperson appears within a story"
- **Entity restriction**: "restrict coding for the category to certain competitors …
  to a single competitor or to multiple competitors" — and the client's addition:
  "an issue category can be made mandatory for only one or a set of competitors only.
  Current CARMA system allows us to make a Category mandatory across all competitors,
  but we cannot restrict it for a few."
- **Hide Category / Hide Issue / Hide Message / Hide Competitor**: obsolete codes
  retire without deleting coded history
- **Validity guard**: "A Topic can only be entered, if it's a part of the Project, and
  it has a valid description field. If Description field is empty, it cannot be
  entered, and the system will throw up an error."
- **Deletion guard**: codes can only be deleted if never coded; the client tightens
  this to "should not allow anyone other than Administrator to delete"

### 2.6 The favourability / rating model

A deterministic additive scoring model, fully specified:

| Component | Points |
|---|---|
| Front Page | ± 5 |
| Size (>= 1000 words) | ± 5 |
| Visual | ± 5 |
| Headline | ± 5 |
| Sources | ± 20 |
| Messages | ± 20 |
| Tonality | ± 5 |
| Circulation (high circulation / priority media set) | ± 5 |

with a **base of 50**, corrected in the review comments:

> "There is an issue with ratings calculation as well…..default should be 50, and any
> addition or subtraction should happen thereafter. So for the following calculation,
> rating should be 50+20 = 70 and not 20"

and a sign rule driven by a single coder input:

> "For positive tonality, +5 across applicable/available indices, For Neutral, they
> will be not applicable, For negative, -5 across applicable/available indices"

with precedence between coded data and feed data:

> "We would prefer aforementioned indices to be primarily populated from issues data.
> Only where issues are not capturing the aforementioned indices (during project
> setup), such data should get picked up from the feed."

and a scoping rule: "rating will auto populate only for competitors, for which Issues
have been coded."

Note the **Circulation ±5** row — this is the brief's only place where *source tier
feeds the relevance/favourability score numerically*. `nestle-scm` stores
`sources.tier`/`priority` but never scores with them.

`articles.ai_relevance_score` and `ai_sentiment` are declared in
`src/types/database.types.ts` and written by nothing.

### 2.7 Auto-assignment of topics from feed signals

The brief's own automation ambition, and the closest thing in it to `nestle-scm`'s matcher:

> "Auto assigning of Topics: This function is presently not available in the current
> coding system. However, based on uploaded feeds and its content (rss/csv), would
> like to explore possibility that certain elements from the feeds auto assign a
> correlating topic code. For instance
> **Keywords**: Those indicated in a project to be highlighted during the Project setup phase
> **Headline**: If tracked Competitor name is in headline
> **Visual**: This information is provided under 'Image' indexing by media monitoring
> **Front Page**: This information is provided under 'Page no' indexing"

and the two-panel keyword design:

> "There can be two keyword panels: 'Topic Keyword' panel that accept keywords that
> get highlighted within the article. **'Theme Keyword' panel that has ability to
> search earmarked content using Boolean cartridges and then assign a topic code based
> upon the most prominent cartridge.**"

The bolded sentence is the brief's only Boolean-matching structure for
classification, and it is *ranked* — "most prominent cartridge" wins, one topic code
out. `nestle-scm` has no ranked/winner-take-one matching; every gate hit is recorded
in `matched_keywords` and none of them is designated primary.

### 2.8 Article-level classification dimensions

Not built, and not representable in the current schema:

- **Article Type**: Editorial, News Piece, Opinion, Letter to Editor, Brief, Feature,
  Blog, Microblog, Reader Comment, Message Board/Forum, Consumer Generated Video,
  Video Post
- **Placement**: Headline / Prominent / Passing
- **Competitive Prominence**: Solus Story / More prominent / Equally Prominent / Less Prominent
- **Story Type** (Amazon): Proactive / Reputational Issues / Other Mentions
- **Origin of Coverage** (Meesho): Proactive / Spontaneous / Third-party generated
- **Article Dynamics**: Front page / Visual-Graphic / Industry expert
- **Charters** (Meesho): Corporate / Consumer / Seller / Tech
- **Influencer type**, captured as a prefix on the source name:
  `P` Partner, `A` Analyst/Expert/Academic/Think Tank, `G` Government/Political/
  Regulator, `T` Trade/Business Association, `N` NGO, `CU` Customer, `TU` Trade Union,
  `U` Others, `M` Media — e.g. `P-Ajit Nambiar-BPL-Chairman-Fav`
- **Bias** on every source/influencer, constrained in review to exactly three values:
  "It will accept only three inputs; Fav, Neu, Unf….whereas currently, anything can be
  entered in this field"
- **Source Type**, a per-project list, mandatory per coded source, justified as
  replacing code proliferation: "This eliminates the need for issues corresponding to
  'spokesperson quoted' or 'financial analyst quoted' … and guarantees that a source
  type is selected for every single source"

### 2.9 Media aliasing to a single Media ID

> "Media names can have variations across different vendors, e.g. Economic Times,
> Economic Times (Delhi), The Economic Times, etc. All these are variations of
> Economic Times Delhi Edition. So rather than having 3 different Media IDs, we will
> require only one Media ID."

with the vendor's answer: "we will use Alias name for Media's to handle duplication."

`nestle-scm` has no source alias. `articles.media` is free text and
`dedup_key` is a hash over normalized `headline + media + published_date + byline` —
so the same story arriving with two spellings of the outlet name produces **two
different fingerprints and two rows**. `keywords.variations` solves this problem for
terms; nothing solves it for outlets.

### 2.10 Region definition with explicit AND/OR

The brief's clearest AND/OR specification, and it is about source classification:

> "If you select multiple criterion in a single definition screen – for example,
> City=Washington, State=District of Columbia, Postal Code=200036 – the system will
> only associate media that meet **all** of the criteria with the region. If each of
> these defining criteria were entered individually, the system would associate media
> that met **any one** of the criteria."

So: AND within a definition row, OR across definition rows — a user-composed
sum-of-products over `City / State / Postal Code / Country`.
`sources.region` in `nestle-scm` is a single free-text label
(`'Global'`, `'India / South Asia'`, `'Middle East'`) with no defining criteria and
no operator structure.

### 2.11 Re-grouping and ad hoc grouping

- **Re-Group**: move a code between categories after the fact — "Important function,
  as we need to recategorize topics – either because the team may have wrongly placed
  or client requests"
- **Ad Hoc Grouping**: a *second, overlapping* grouping axis for issues, messages,
  competitors and media that "does not impact an issue's assigned issue category. It
  creates a grouping outside the issue category framework that can be queried"

`keywords.cluster` is a single string — one axis, no second overlapping grouping, and
regrouping means editing each row.

### 2.12 Coding-time validation and QC operations

- Error alerts on unmet mandatory/linked requirements at save time
- Mid-flight settings changes surface as errors on already-coded articles: "if you
  change an existing category to make it mandatory, and a researcher is in the middle
  of coding a batch, they will start to generate errors on previously coded articles"
- **Mass Coding**: "Only one entity can be coded at once, wrt topic with validation.
  Only project codes (topic code/ message codes) will come in the dropdown"; keyed by
  a comma-separated list of Article IDs
- **Duplicate coding across entities**, then per-entity add/remove
- Bylines / Sources / Linked Content / Reader Comments / Media **cleanup and merge**
  panels, with the rule that Copy/Paste updates everything *except* Bias

---

## 3. Implemented differently — divergences to flag

### 3.1 What gates capture: source membership vs. keyword AND

Stated in full at the top. The brief gates on the capped media universe and treats
keywords as a reading aid and a batch filter. `nestle-scm` gates on
`Gate 1 AND Gate 2` and treats source membership as the loose outer filter. Neither
version is presented here as the right one.

### 3.2 The word "exclusion" means different things

- **Brief**: exclusion is *between codes* — "Don't code #26" — and separately,
  QC-time article exclusion by a human. There is no term whose presence removes an
  article from the corpus.
- **`nestle-scm`**: `GATE_EXCLUSION` / `list_type='negative'` terms suppress the whole
  article at ingest, unless a Gate 1 anchor appears in the headline
  (`match.ts:319-332`), with the count logged to
  `ingestion_runs.articles_suppressed_exclusion`.

Same word, different object. Worth not conflating when the two systems are reconciled.

### 3.3 Positive/negative polarity is on different things

The brief has **positive and negative *messages*** — paired client-narrative codes
coded per entity, with the review note that "positive and negative messages are
arranged sequentially, just like issues. Whereas in our current system, it assigns
the same code to positive and negative message". It has **no** positive/negative
source list; source scoping is inclusion-only (target media list) plus tiers.

`nestle-scm` has `list_type` positive/negative on **sources** *and* on **keywords**,
and no message concept at all. `articles.matched_negative_keywords` is the nearest
analogue to a negative message and is explicitly a flag, never a blocker
(migration `0009`: "negative keywords never block capture").

### 3.4 AND/OR is user-composed vs. structurally fixed

The brief's Boolean structure is authored by the operator: comma = OR in batch
keywords, quotes = phrase, AND-within-row / OR-across-rows in region definitions,
OR-across-trigger-topics in conditional mandatory coding, "Boolean cartridges" in the
Theme Keyword panel.

`nestle-scm`'s is fixed in code: `(any Gate 1) AND (any Gate 2) AND NOT (exclusion
unless headline-anchored)`. Migration `0017` records a deliberate decision *against*
operator-authored patterns:

> "not a pattern language. Entries are literal terms. No wildcards, no regex, no
> admin-supplied quantifiers … a user-supplied nested quantifier is a
> catastrophic-backtracking (ReDoS) hazard"

This is a real divergence, and the reasoning on the `nestle-scm` side is explicit and
security-motivated — worth carrying into any reconciliation rather than treating the
brief's Boolean flexibility as a straightforward gap.

### 3.5 Sentiment: deterministic point model vs. LLM field

§2.6's additive model is computed from coded fields with a human tonality input, and
is auditable component by component. `nestle-scm` declares `ai_sentiment` and
`ai_relevance_score` for an LLM to fill and currently fills neither. These are not
the same mechanism, and the brief's version produces a defensible number the client
can be walked through.

### 3.6 Deduplication: ingest-time fingerprint vs. QC-time review

The brief dedups late and by hand — a QC panel that surfaces "possible duplicates"
filtered by employee, date range, or cross-coder, for a person to resolve. It also
expects *legitimate* near-duplicates: "If you are coding multiple versions of the same
article, such as a wire story that ran in multiple newspapers, code the article once,
and then click the Duplicate Previous Article" — i.e. the same story in ten
newspapers is ten valid coded rows, not one.

`nestle-scm` dedups early and automatically on `dedup_key`, which includes `media`,
so the same wire story in ten outlets *is* ten rows there too. The divergence is in
timing and reviewability, not in the rule — plus the alias problem in §2.9, which
makes the fingerprint fire inconsistently across vendor spellings.

### 3.7 Occurrence counting: client-meaningful vs. informational

The brief's **Multiple Coding** counts how many times a *message, branding phrase,
URL or spokesperson* appears, and that count is a client deliverable —
"track not just how many articles contained a message, but how many times a message
came across within an article."

`nestle-scm`'s `keyword_mention_count` counts *keyword* occurrences and migration
`0018` is emphatic that it is "Informational only — capture is still the two-gate
rule, and a count of 1 is as captured as a count of 40." Related idea, different
object, and different status in the deliverable.

---

## 4. Platform-level concepts that don't apply to a single vertical

These are real in the brief and correctly absent from `nestle-scm`. Listed so they
are not later mistaken for gaps.

- **Client → Project hierarchy.** "a client might be IBM, while projects under the
  client IBM could include IBM 2012 baseline, IBM DB2, IBM Asia Pacific, IBM CEO
  study". Every taxonomy object in the brief — categories, codes, messages, entities,
  source types, regions, target media list — is scoped *per project*. `nestle-scm`
  has exactly one implicit project.
- **Entity / Competitor dimension.** Coding is per (article × entity): issues,
  messages, sources, ratings and reader comments are all coded against a selected
  competitor, with duplicate-across-entities and per-entity restrictions. The Amazon
  matrix tracks four distinct entity sets (Corporate, Sellers, Operations, and a
  date-scoped export set). `nestle-scm` codes nothing per entity.
- **Project duplication and matrix export as a reuse mechanism.** Duplicate Project;
  Export a project matrix to Word + CSV for client sign-off.
- **Batch workflow and role separation.** Batches assigned to a named coder;
  submit-for-QC; QC panels; send-a-batch-back; mark/unmark QC complete; per-project
  employee assignment with roles Admin / Manager / Coder / QC Analyst. `nestle-scm`'s
  `read`/`curate`/`admin` is a much flatter model with no work-assignment concept.
- **Shared global media database.** "media records are used across all projects in all
  CARMA offices worldwide – so any changes you make to an existing media record can
  have a far-reaching impact." `sources` in `nestle-scm` is a single-tenant table.
- **System codes registry** — a master-admin-controlled list-of-values service
  (`MEDIA_TYPE`, `BIAS_CODE`, `ARTICLE_TYPE`, `COUNTRY`, `LANGUAGE`, `PROJECT_ROLE`,
  `INDUSTRY_CATEGORY`, …) shared across every project.
- **Multi-vendor feed ingestion with per-vendor field mapping.** "whenever a new
  vendor is added, different import fields can be manually assigned (similar to Zoho
  CRM import modules)", across Factiva XML/RTF, LexisNexis XML, CyberAlert XML, eNR
  XML, BurrellesLuce XML, Critical Mention RSS, Semantiks XML, Media Monitors RTF/CSV,
  plus OCR for scanned Hindi/English print clips.

### Scoping note — the brief describes a multi-vertical platform

Per instruction, flagging rather than resolving: **this brief is not a single-vertical
document.** The repository contains filled-in Research Matrices for Amazon India,
Meesho, Mahindra Lifespaces, Mahindra Logistics and Prime Video, each with its own
codebook, entity set and message framework. The brief's central design assumption is
that the taxonomy is *project-scoped data*, not application structure — categories,
codes, messages, entities, source types and target media lists are all created per
project through a setup UI.

`nestle-scm` is one vertical (ocean freight) with its taxonomy imported as rows into a
single `keywords` / `sources` pair. Reconciling "taxonomy as per-project configuration"
against "taxonomy as the application's single dataset" is the larger scoping question,
and is deliberately left open here.

---

## 5. Outputs — the deliverable shape

Called out separately because the output layer is where the coding scheme has to land,
and because the brief's outputs are concrete enough to serve as a template.

### 5.1 Realised output shape (from the Power BI test exports)

`R3 Power BI Tests/20 Mar 23_Test/` contains the actual exports. They are **flat,
denormalised, one file per coded object, all joined on `Article ID`** — Business
Objects queries feeding Power BI. Observed headers:

**`01_Baisc Data.xlsx` / `02_Issues Data.xlsx` — article grain**

```
Article ID | Media ID Number | Competitor Name | Article Date | Article Type |
Batch Date | Batch No | Circulation | City | Comments | Country | Created By |
Headline | Media Name | Month | Rating | Research Staff Member | Url
```

**`03_Byline Data.xlsx` — byline grain**

```
Affiliation | Article Date | Article Type | Batch Date | Batch No | Byline Name |
Comments | Competitor Name | Country | Created By | Headline | Media Name | Month |
Research Staff Member | Year | Article ID
```

**`04_Influencer Data.xlsx` — source/influencer grain**

```
Affiliation | Article Date | Article Type | Batch Date | Batch No | Bias | Comments |
Competitor Name | Country | Create Date | Created By | Headline | Media Name | Month |
Project Number | Source First Name | Source Last Name | Year | Article ID | Title
```

Three things worth reading off these directly:

1. **`Competitor Name` is on every row.** The output grain is (article × entity), not
   article. Values observed are `Video-Amazon`, `Video-Hotstar` — entity *and*
   charter fused into the label.
2. **`Bias` is a coded enum on the influencer row** — observed `FAVORABLE`, matching
   the Fav/Neu/Unf constraint in §2.8.
3. **`Source First Name` carries the influencer-type prefix** — observed value `P`,
   confirming the matrix instruction "INFLUENCERS (TO BE CAPTURED IN SOURCE FIRST
   NAME) … P - Partner". The type is encoded into a name field rather than its own
   column; that is a real modelling shortcut in the current output, not a
   transcription artefact.

Also present: `Rating` on the article row (the §2.6 score), `Circulation` (the ±5
input), `Batch No` / `Batch Date` / `Created By` / `Research Staff Member` (the
provenance the QC workflow needs).

### 5.2 Outputs specified in the brief text

| Output | Contents | Format |
|---|---|---|
| **Project coding matrix export** | "the project ID, competitor names (if applicable), issue codes and descriptions, and message codes and descriptions" — ordered by category Sequence Number | Word + CSV |
| **Media list export** (project) | "the Media ID, Name and Type, along with geographic data and record status" | Excel |
| **Media export** (global) | filtered by Media Status, Country, Media Type, minimum Circulation; multiple criteria AND together — "AUSTRALIA" and "MAGAZINES" exports Australian magazines | Excel |
| **Batch coding summary** | generated on Submit-for-QC, "allow you to quickly review key pieces of information for accuracy" before confirming | on-screen, pre-submit |
| **BO / data-mining queries** | the reason Ad Hoc Groupings exist at all — "can be queried using Business Objects or other data mining tools" | flat exports (§5.1) |
| **Crystal Reports** | must resolve multi-valued circulation: "any combination in the Crystal Reports should pick the latest circulation figure" | report |

### 5.3 Where `nestle-scm` stands on outputs

Classified against the four categories:

- **Already implemented (partial):** `reports` + `reports.stats_snapshot` — "frozen
  aggregates: counts by media, sentiment split, top keywords, most-repeated stories"
  — is a weekly-digest output with the same instinct as the batch summary, i.e. freeze
  aggregates before bodies are purged.
- **Not built:** every export above. There is no matrix export, no media list export,
  no flat per-object extract, and no per-entity output grain — `nestle-scm` has no
  entity dimension to group by.
- **Implemented differently:** `nestle-scm`'s output is a rendered HTML email digest
  (`reports.html_content`) plus a live dashboard; the brief's output is tabular
  extracts fed to an external BI tool. Different consumption model.
- **Platform-level:** `Project Number` on the influencer export, and the whole
  per-project extract framing, presume the multi-project hierarchy of §4.

---

## Summary table

| Brief concept | Status | Where |
|---|---|---|
| Capped media universe as the in/out gate | Implemented | `sources.list_type`, `app_settings.universe_mode`, `run.ts:112` |
| Media tiers / priority | Implemented (stored, not scored) | `sources.tier`, `sources.priority` |
| Exact phrase vs. loose match | Implemented | `keywords.match_type`, `match.ts:126` |
| Exclude / include / soft delete | Implemented | `articles.status` |
| Duplicate detection | Implemented (differently — §3.6) | `articles.dedup_key` |
| Term variants | Implemented | `keywords.variations`, `match.ts:104` |
| Topic Category → Topic → Sub-Topic codebook | Not built | — |
| Coding designation (mandatory / cardinality / conditional) | Not built | — |
| Linked codes (directional auto-coding) | Not built | — |
| Inter-code exclusion ("Don't code #26") | Not built | — |
| Multiple Coding / entity restriction / hide | Not built | — |
| Favourability model (base 50, ±5/±20 components) | Not built | `ai_relevance_score` declared, unwritten |
| Auto-assign topics from feed signals | Not built | — |
| Theme Keyword Boolean cartridges, most-prominent wins | Not built | — |
| Article Type / Placement / Prominence / Influencer type / Bias | Not built | — |
| Media aliasing to one Media ID | Not built | affects `dedup_key` — §2.9 |
| Region definitions with AND/OR | Not built | `sources.region` is a flat label |
| Re-group + overlapping ad hoc grouping | Not built | `keywords.cluster` is one flat axis |
| Keyword-gated capture (Gate 1 AND Gate 2) | **Not in the brief** | `match.ts:300-304` — see §3.1 |
| Exclusion as article suppression | Divergent | §3.2 |
| Positive/negative on sources and keywords | Divergent | §3.3 |
| Operator-authored Boolean | Divergent (deliberate) | §3.4, migration `0017` |
| LLM sentiment vs. point model | Divergent | §3.5 |
| Client → Project hierarchy, entities, batches, QC roles | Platform-level | §4 |
| Flat per-object BI extracts, per-project | Not built / platform-level | §5 |
