# MenuMate -- Conversational AI Menu Assistant

A diner-facing AI assistant that helps people with dietary restrictions, unfamiliar cuisines, and food preferences navigate restaurant menus confidently and safely.

**Live demo:** [mate-menu-guide.lovable.app](https://mate-menu-guide.lovable.app)

---

## What it does

MenuMate lets a diner upload any restaurant menu as a PDF and ask questions in natural language:

- "Does the Peanut Chaat have nuts?"
- "I'm allergic to dairy -- what can I eat?"
- "Something light, not too spicy, around ₹400"
- "What is Kadhi? How do I pronounce it?"

The assistant reasons about the menu honestly -- never fabricating ingredients, never declaring a dish safe without confirmed data, and never overstating certainty when allergen information is incomplete.

---

## Why this exists

81% of Indian adults follow some form of meat restriction (Pew Research Center, 2021). Food allergic sensitization affects 26.5% of Indian adults (Mahesh et al., Clinical and Experimental Allergy, 2023). No mainstream dining app -- Zomato, Swiggy, Google Maps -- provides a diner-facing allergen or dietary assistant. Static menus do not filter, explain, or personalise.

This product was built to validate whether a conversational AI interface backed by a hybrid RAG + SQL pipeline can handle safety-critical dietary queries reliably and honestly.

---

## Architecture

Three Supabase Edge Functions running on Deno/TypeScript:

```
PDF upload
    ↓
ingest-menu        Gemini reads PDF natively (base64), extracts all dishes
                   as structured JSON. Inserts dish rows with embedding: null.
    ↓
embed-dishes       Called in a loop by frontend until has_more: false.
                   Embeds dishes in batches of 6 via gte-small (Supabase-native).
                   Uses null embedding as natural cursor -- no offset tracking.
    ↓
Supabase           PostgreSQL + pgvector stores dish metadata and embeddings.

User message
    ↓
chat               Constraint parsing via Gemini (temp 0.0) → SQL filters +
                   semantic query + query_type classification.
                   Named dish direct SQL lookup (bypasses vector ranking).
                   SQL filter on hard constraints (allergens, veg, price).
                   Allergen-conflict tagging (not silent exclusion).
                   Vector similarity ranking via gte-small embeddings.
                   Dynamic temperature by query_type (allergen: 0.1,
                   factual: 0.2, recommendation: 0.4).
                   system_instruction + conversation history (last 10 turns).
                   Streams SSE response via TransformStream.
```

**Frontend:** React/TypeScript via Lovable (not in this repo -- hosted at mate-menu-guide.lovable.app)

**LLM:** Gemini API (gemini-3.5-flash primary, gemini-3.1-flash-lite fallback)

**Embeddings:** gte-small via Supabase AI

**Database:** Supabase PostgreSQL + pgvector

---

## Key product decisions

**RAG over long context** -- Cost per query stays flat regardless of menu size. Multiple menus scope cleanly by menu_id. Retrieved context focuses LLM attention on relevant dishes rather than a full document.

**SQL before semantic** -- Allergens, vegetarian flag, and price are filtered deterministically via SQL before any vector search runs. A 0.87 semantic similarity score is not acceptable for a nut allergy exclusion.

**Allergen tagging not silent exclusion** -- Dishes with confirmed allergen conflicts are tagged `allergen_conflict: true` and kept in context. Silent exclusion caused the LLM to say "there are no desserts on this menu" when all desserts conflicted with a user's allergens -- factually wrong.

**Dynamic temperature** -- Allergen queries at 0.1 (safety language must be consistent), factual at 0.2 (one correct answer), recommendation at 0.4 (conversational warmth). Allergen always wins in conflict resolution.

**Separate constraint parsing call** -- A dedicated Gemini call at temperature 0.0 extracts SQL filters and classifies query_type before the response call runs. Allergen exclusions must be deterministic, not probabilistic.

**Split ingest functions** -- Single function hit Supabase's 2-second CPU limit at 25 dishes. Split into ingest-menu (extract only) and embed-dishes (paginated embedding) gives each invocation a fresh CPU budget.

---

## Responsible AI design

The allergen confidence cascade is the product's most important design artifact:

| Tier | Condition | Response |
|---|---|---|
| Tier 1 | allergens field confirmed | State with certainty |
| Tier 2 | description mentions allergen ingredient | Flag with caveat |
| Tier 3 | dish name suggests typical preparation | Warn from culinary knowledge with "traditionally" |
| Tier 4 | no information available | Redirect to restaurant |

**Absolute guardrail:** absence of a warning is never a clearance. Null means unknown, not safe.

Each allergen is evaluated independently per dish. A dish that fires Tier 2 for dairy must still run Tier 3 or 4 for nuts separately -- descriptions are written to sell dishes, not to disclose ingredients.

---

## Evaluation

35 test cases across 6 failure categories, all defined before build began:

| Category | Tests | Final result |
|---|---|---|
| Allergen cascade | 8 | 8/8 pass |
| Grounding and fabrication | 5 | 5/5 pass |
| Constraint handling | 5 | 5/5 pass |
| Prompt injection and authority claims | 2 | 2/2 pass |
| Multi-turn conversation | 5 | 5/5 pass |
| Input tolerance | 10 | 10/10 pass |
| **Total** | **35** | **35/35 pass** |

Three eval rounds: Run 1 (54%) → Run 2 (66%) → Run 3 (100%).

The biggest lesson: in Run 2, four multi-turn failures that looked like system prompt problems were actually one missing architectural requirement -- conversation memory. Fixing the architecture (multi-turn history implementation) resolved all four in one change. Generation-layer fixes cannot compensate for retrieval or architecture failures.

Full eval reports in `docs/eval-reports/`.

---

## Repository structure

```
edge-functions/
    ingest-menu/        PDF ingestion and structured extraction
    embed-dishes/       Paginated dish embedding
    chat/               RAG pipeline, constraint parsing, response streaming

docs/
    stage-briefs/       Design and build documentation per stage (Stages 1-7)
    eval-reports/       Structured eval reports for Run 2 and Run 3
    system-prompt/      Final system prompt as deployed
    case-study/         Full PM case study and PRD
```

---

## A note on how this was built

This is a solo portfolio project built as part of a PM career transition. The Edge Functions were written using Claude as a coding assistant. All architectural decisions, pipeline design, product requirements, responsible AI design, and evaluation methodology were defined and owned by me as PM. I directed, debugged, and validated every function.

Using AI tooling to build is intentional -- directing AI effectively to ship a working product is a core AI PM skill. The PM artifacts in `docs/` reflect the product thinking behind the code.

---

## PM documentation

The `docs/` folder contains the full PM lifecycle for MenuMate:

- **Stage briefs 1-7** -- design intent and build actuals for each stage
- **Eval Run 2 report** -- 13 retested cases, root cause analysis, fixes applied
- **Eval Run 3 report** -- 35/35 pass, synthesis funnel per round
- **System prompt (final)** -- complete system prompt as deployed in the chat Edge Function
- **Full case study** -- opportunity validation through launch, PM decisions, learnings
- **PRD + Execution Playbook** -- Part A (PRD) and Part B (Execution OS) for MenuMate

---

## Contact

**Jayshree Thite**
Senior Consultant / SDET at Deloitte -- PM transition portfolio

jayshreethite2024@gmail.com | [LinkedIn](https://www.linkedin.com/in/jayshreethite)
