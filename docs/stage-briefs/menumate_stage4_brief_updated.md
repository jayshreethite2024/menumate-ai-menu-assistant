# MenuMate - Stage 4 Brief
## RAG Pipeline Design

*For interview use - PM case study reference*

---

## What Stage 4 Is

Stage 4 is the RAG (Retrieval-Augmented Generation) pipeline - the backbone of how MenuMate works. It covers two complete flows: ingestion (what happens when a diner uploads a menu PDF) and retrieval (what happens when a diner sends a message). Every product and architecture decision made in Stages 1–3 is operationalised here.

The pipeline answers the question a PM must always ask: how does the AI actually get the right information in front of the user, reliably and safely, every single time?

---

## Stack Decisions

### Why Lovable + Supabase, not Streamlit

The original V1 stack was Python/Streamlit - chosen for its all-in-one simplicity. The stack was revised after securing a free Lovable subscription (300 credits, 1 year access). Lovable generates a React/TypeScript frontend, which changes the architecture meaningfully.

Streamlit runs Python end-to-end - UI, backend logic, and data in the same environment. Lovable separates concerns: the frontend is React (runs in the browser), and all backend logic must run server-side. This is the correct architecture for a real product, and made Supabase Edge Functions the natural backend layer.

**The stack change is a portfolio upgrade, not a compromise.** The resulting architecture - React frontend, serverless backend, managed vector database - is production-grade, not a prototype.

### Final Stack

| Layer | Tool | Purpose |
|---|---|---|
| Frontend | Lovable (React/TypeScript) | UI - upload, chat, menu switcher |
| Backend | Supabase Edge Functions (Deno/TypeScript) | All server-side logic |
| Vector store + DB | Supabase (PostgreSQL + pgvector) | Persistent storage of chunks and vectors |
| Embedding model | gte-small (Supabase-native) | Text → vector conversion |
| LLM | Gemini 2.5 Flash (Google AI Studio free tier) | Response generation |

### Why gte-small replaced sentence-transformers

Sentence-transformers is a Python library. Supabase Edge Functions run on Deno (TypeScript). These are different language runtimes - TypeScript cannot import or execute Python libraries. gte-small is available natively within Supabase's infrastructure via API call, requires no Python runtime, and is free within Supabase's tier. The embedding quality is comparable for this use case.

### Why Gemini 2.5 Flash, not Claude Haiku

The Jio–Google Gemini partnership provides a consumer-facing Google AI Pro subscription - interface access, not API tokens. Google AI Studio has a separate free API tier with generous rate limits. Gemini 2.5 Flash is available on that tier. It has strong instruction-following capability appropriate for MenuMate's complex system prompt.

> **Build update - model strings in production:** The actual API model strings used are `gemini-3.5-flash` (primary) and `gemini-3.1-flash-lite` (fallback). Both are called with a fallback loop - if the primary returns 429 (rate limit) or 503 (unavailable), the function retries with the fallback model. Gemini 2.0 models (`gemini-2.0-flash`, `gemini-2.0-flash-lite` etc.) were shut down as of June 1, 2026 per Google's changelog.

The LLM choice is a swap-in: the pipeline architecture does not change if the model changes. For a production deployment where allergen safety is on the line, the selection criterion would shift from cost to instruction-following consistency - and that decision would be revisited explicitly.

---

### Why RAG, not Long Context

This was an explicit architectural decision. The alternative to RAG is the **long context approach** - attaching the entire menu PDF to every API call and letting the LLM read the whole thing directly, with no vectors, no embedding, and no retrieval step.

For MenuMate V1 with a single small menu of 40–100 dishes, long context would have been simpler to build - fewer moving parts, less code, faster to ship. Both Gemini and Claude support context windows large enough to hold an entire restaurant menu easily.

**Why RAG was chosen over long context:**

**Cost per query scales badly with long context.** Every message Priya sends would include the entire menu - 10,000–50,000 tokens per request. RAG sends only the 5 most relevant dish chunks - roughly 500 tokens of context per request. At free tier rate limits, full-menu context on every query exhausts the quota far faster.

**Multiple menus have no clean scoping mechanism in long context.** If a user has uploaded menus from several restaurants across sessions, long context has no way to scope answers to the active menu without sending all menus in every request. RAG scopes by menu_id - deterministic and clean.

**Attention dilution on larger menus.** LLMs pay uneven attention across long documents. A 50-dish menu is fine. A 200-dish menu with complex layouts causes the model to miss dishes buried in the middle. RAG surfaces only the relevant dishes, focusing LLM attention precisely.

**Latency.** Sending a full PDF on every message is slow. RAG retrieves 5 chunks in milliseconds and sends a compact prompt.

**The honest trade-off acknowledged:** For V1 specifically, long context would have produced equally good answers with significantly less build complexity. The choice of RAG is a deliberate trade-off - accepting higher build complexity now for an architecture that scales correctly, handles multiple menus cleanly, and reflects how production AI products with large or multiple documents are actually built.

---

## The Two Edge Functions

All backend logic lives in two Supabase Edge Functions. These are small TypeScript files that run on Supabase's global server network. They execute only when called - not continuously. No server management is required.

**`ingest-menu`** - called once when a user uploads a PDF
**`chat`** - called every time a user sends a message

> **Build update - three Edge Functions, not two:** The ingestion pipeline was split into two separate functions during build due to Supabase free tier CPU time limits (2-second budget per invocation). Running gte-small embeddings for 22+ dishes inside `ingest-menu` exceeded this limit and caused WORKER_RESOURCE_LIMIT errors. The final architecture has three functions:
> - **`ingest-menu`** - extracts dishes from PDF via Gemini, inserts all dish rows with `embedding: null`
> - **`embed-dishes`** - embeds dishes in paginated batches of 6 (3 per batch), called repeatedly by the frontend until `has_more: false`. Uses `.is('embedding', null)` as a natural cursor - no offset tracking needed.
> - **`chat`** - unchanged in purpose; significantly changed in implementation (see below)
>
> The split gives each invocation a fresh CPU budget. For a 22-dish menu, `embed-dishes` is called 4 times. Each call processes 6 dishes in 2 batches of 3.

---

## Edge Function 1: `ingest-menu`

### Complete flow

```
User uploads PDF (Lovable UI)
        ↓
Edge Function receives the PDF file
        ↓
Step 1: pdfjs-dist parses PDF → raw text string
        ↓
Step 2: Gemini API call → raw text converted to structured JSON
        (one object per dish - this is the chunking step)
        ↓
Step 3: For each dish in the JSON array:
        gte-small API call → dish text converted to vector
        Supabase DB insert → chunk + metadata + vector stored
        ↓
Edge Function returns: "Menu loaded successfully"
        ↓
Lovable UI shows: "Menu ready. Ask me anything."
```

> **Build update - actual ingest-menu flow:**
> ```
> User uploads PDF (Lovable UI)
>         ↓
> ingest-menu Edge Function receives PDF as form-data
>         ↓
> Step 1: PDF converted to base64 (safe chunked method)
>         ↓
> Step 2: Gemini API call - PDF sent as inline_data, Gemini reads
>         natively and returns structured JSON (one object per dish)
>         ↓
> Step 3: Existing menu with same restaurant_name deleted (Option B
>         duplicate prevention)
>         ↓
> Step 4: New menus row inserted
>         ↓
> Step 5: embedded_text built per dish; all dish rows inserted
>         with embedding: null
>         ↓
> Returns { success, menu_id, dishes_processed, dishes_inserted }
>         ↓
> Lovable immediately calls embed-dishes in a loop until has_more: false
>         ↓
> embed-dishes fetches 6 unembedded dishes, embeds via gte-small
>         in batches of 3, updates embedding column per dish
>         ↓
> Lovable shows: "[Restaurant] menu loaded! I've read through N dishes."
> ```

---

### Sub-problem 1: PDF Parsing

**Tool chosen:** pdfjs-dist (Mozilla's PDF rendering library, JavaScript-native)

A PDF is not a text file. It is a set of rendering instructions - each character stored as a coordinate, font, and size, not as part of a word or sentence. A PDF parser reads those coordinates and reconstructs meaningful text.

Menus are among the most structurally complex PDFs: multi-column layouts, decorative fonts, prices and descriptions scattered across the page. pdfjs-dist extracts the text layer from digitally-generated PDFs reliably. Scanned or image-only PDFs are out of scope for V1 - the vast majority of restaurant PDFs are digital.

Output of this step: a raw text string. Not structured. Not clean. A wall of mixed content - dish names, prices, descriptions, section headers, page numbers - in the order the parser encountered them.

> **Build update - PDF parsing approach changed to Gemini native reading:** pdfjs-dist was not used in the final implementation. Instead, the PDF is converted to base64 using a safe chunked conversion (`Array.from(bytes).map(byte => String.fromCharCode(byte)).join('')`) and sent directly to Gemini as an `inline_data` part with `mime_type: "application/pdf"`. Gemini reads the PDF natively - it understands layout, columns, and structure directly without a separate parsing step. This collapsed two steps (parse → chunk) into one Gemini call, and proved more robust to complex menu layouts than text extraction followed by LLM structuring. The spread operator (`...bytes`) was explicitly avoided as it causes stack overflows on large PDFs in Deno.

---

### Sub-problem 2: Chunking (LLM-assisted)

**Approach chosen:** LLM-assisted chunking via a single Gemini API call at ingestion time

**Why not rule-based chunking:**
Rule-based chunking writes logic that looks for patterns - price formats, capitalisation, line breaks - to identify where one dish ends and the next begins. This is brittle. Real menus are wildly inconsistent: prices on separate lines, descriptions before or after prices, two columns on one page, section headers with no consistent format. Every inconsistency requires a new rule. For a portfolio demo using a controlled menu, it works. For any arbitrary menu, it fails unpredictably.

**Why LLM-assisted chunking:**
The raw text from Step 1 is sent to Gemini with a structured extraction prompt. Gemini reads the messy text the way a human would - understanding layout, context, and intent - and returns a clean JSON array with one object per dish.

Chunking and structuring happen simultaneously in one API call, not as two separate steps. This collapses the pipeline.

**The allergen constraint in the extraction prompt:**
The Gemini prompt explicitly instructs: *"Only populate the allergens field if the menu text explicitly states it. Never infer allergens from dish names or descriptions."* This is responsible AI design applied at ingestion - the same principle that governs query-time allergen handling. Without this constraint, Gemini might helpfully infer that Kadhi contains dairy and populate the allergens field - silently elevating inferred data to the same confidence level as confirmed metadata. That is the most dangerous mistake this product could make.

**Output of this step:** a clean JSON array - one object per dish, all fields populated or null.

```json
[
  {
    "dish_name": "Kadhi",
    "category": "Starters",
    "price": 180,
    "is_veg": true,
    "allergens": null,
    "cooking_method": null,
    "spice_level": "medium",
    "description": "Yoghurt-based curry with pakoda",
    "description_source": "menu"
  }
]
```

---

### Sub-problem 3: Embedding

**Model:** gte-small via Supabase (384-dimension vectors)

An embedding model converts text into a vector - a list of numbers that represents meaning. Texts with similar meanings produce vectors that are mathematically close to each other. This is what makes semantic search possible: finding dishes that match a user's intent even when no exact words overlap.

**What gets embedded per dish:**
Dish name + description + available soft metadata, combined into one string:

```
"{dish_name} - {description}.
[Spice: {spice_level}.]
[Cooking: {cooking_method}.]
[Protein: {protein_level}.]
[Fat: {fat_level}.]
[Calories: {calories}.]"
```

Fields in brackets are included only if not null. Embedding the word "null" adds noise to the vector space.

**Why soft metadata is included in the embedded text:**
Spice level, cooking method, and nutritional fields are stored as SQL columns for exact filtering when present. They are also included in the embedded text because they are frequently null in real menus. When a field is null, SQL cannot use it - but the dish description often contains signals ("steamed", "light", "grilled") that carry the same meaning semantically. Embedding soft metadata when present, and relying on description signals when absent, gives semantic search the best available information in both cases.

**Why hard safety fields are not in the embedded text as source of truth:**
Allergens, is_veg, and price are stored as SQL columns only. These fields are exact and binary - they must be filtered deterministically, never approximated. A 0.87 semantic similarity score is not acceptable for an allergen exclusion. SQL gives a guaranteed yes/no; semantic search gives a probability.

**The embedded_text column:**
The string that was sent to gte-small is stored in a dedicated column alongside the vector. This serves two purposes: debugging (if retrieval produces wrong results, the embedded string can be inspected to understand why) and auditability (the ingestion logic is transparent and reviewable).

---

### Sub-problem 4: Storage

**Two tables in Supabase PostgreSQL + pgvector**

#### menus table

| Column | Type | Nullable | Purpose |
|---|---|---|---|
| id | uuid | No | Primary key - referenced as menu_id in dishes |
| restaurant_name | text | Yes | Extracted from PDF if present |
| uploaded_at | timestamp | No | Auto-generated |
| page_count | integer | Yes | Debugging - flags incomplete parses |

#### dishes table

| Column | Type | Nullable | Purpose |
|---|---|---|---|
| id | uuid | No | Primary key |
| menu_id | uuid | No | Foreign key to menus table |
| dish_name | text | No | |
| category | text | Yes | As-is from menu - no forced taxonomy |
| price | integer | Yes | In local currency |
| is_veg | boolean | Yes | |
| allergens | text[ ] | Yes | Explicit menu text only - never inferred |
| cooking_method | text | Yes | fried / grilled / steamed / tandoor / baked |
| is_fried | boolean | Yes | Derived from cooking_method |
| spice_level | text | Yes | mild / medium / hot |
| protein_level | text | Yes | high / moderate / low |
| fat_level | text | Yes | high / moderate / low |
| calories | integer | Yes | Only if on menu |
| available | boolean | Yes | |
| description | text | Yes | Menu-provided or AI-generated |
| description_source | text | No | "menu" or "ai_generated" |
| embedded_text | text | No | String sent to gte-small - for debugging |
| embedding | vector(384) | No | gte-small output |
| created_at | timestamp | No | Auto-generated |

**Why menu_id exists:**
Without menu_id, a search would scan all dishes from all menus ever uploaded. Every SQL filter and vector search is scoped to the active menu_id - dishes from other menus are invisible during a session.

**Why almost everything is nullable:**
Real menus are incomplete. A mandatory schema rejects real menus that don't provide every field. Nullable columns accept reality as it is. Missing data is stored as null - which the system prompt correctly interprets as unknown, not safe. The non-nullable columns are those that can always be guaranteed: id (database-generated), menu_id (always known), description_source (always determinable), embedded_text (always generated), embedding (always returned by gte-small), and created_at (database-generated).

**Menu switching:**
V1 supports switching between menus mid-session. The active menu_id is stored in React state in the Lovable frontend. When a user switches menus, the active menu_id updates and the chat history clears. Chat history is cleared on switch deliberately - mixing responses from two different menus in one conversation creates a trust problem. Clarity over continuity is the right trade-off here.

---

## Edge Function 2: `chat`

### Complete flow

```
User sends message (Lovable UI)
        ↓
Edge Function receives: message + active menu_id
        ↓
Step 1: Gemini API call → extract hard constraints + semantic query from message
        ↓
Step 2: gte-small API call → embed semantic query → query vector
        ↓
Step 3: SQL filter → narrow candidate pool using hard constraints
        ↓
Step 4: Vector similarity search → rank filtered candidates by semantic relevance
        ↓
Step 5: Build full prompt → system prompt + retrieved chunks + user message
        ↓
Step 6: Gemini API call → generate response
        ↓
Step 7: Stream response back to Lovable UI
```

> **Build update - actual chat function flow:**
> ```
> User sends message (Lovable UI)
>         ↓
> Edge Function receives: { message, menu_id, history }
> history = prior conversation turns (capped at last 10), sent by
> Lovable as prior turns only - NOT including the current message
>         ↓
> Step 1: Fetch restaurant_name from menus table
>         ↓
> Step 2: Gemini constraint parsing call (temp 0.0) →
>         { filters, semantic_query, query_type }
>         ↓
> Step 3: gte-small embeds semantic_query → query vector
>         ↓
> Step 4: Named dish detection - fetch all dish names for menu,
>         check if any appear in message text, direct SQL lookup
>         if match found (bypasses availability filter and vector
>         ranking - ensures named dishes always reach LLM context)
>         ↓
> Step 5: SQL filter (is_veg, price, cooking_method, available)
>         → candidateDishes
>         Allergen tagging: dishes with confirmed allergen conflict
>         tagged allergen_conflict: true rather than removed
>         (LLM sees dish but knows not to recommend it)
>         ↓
> Step 6: Vector similarity ranking within candidateDishes
>         Dynamic slice: 50 (full menu), 15 (multi-constraint or
>         nutritional), 5 (standard)
>         ↓
> Step 7: Merge named dish into context at position 0 if not
>         already present
>         ↓
> Step 8: Build contextBlock (all dish fields including
>         allergen_conflict flag)
>         ↓
> Step 9: Set temperature by query_type
>         ↓
> Step 10: Build Gemini request:
>          system_instruction: full system prompt (always in scope)
>          contents: [...historyContents, currentUserTurn]
>          currentUserTurn includes fresh contextBlock + message
>          historyContents maps prior turns to Gemini role format
>          (assistant → model)
>         ↓
> Step 11: Stream Gemini SSE response to Lovable via TransformStream
> ```

---

### Sub-problem 5: The Query Pipeline

#### Step 1 - Constraint parsing

Before embedding anything, the user's message is parsed into two parts: hard constraints (for SQL filtering) and a semantic query (for vector search).

This is a small Gemini API call - not the main response-generation call. It extracts structured values from natural language:

```
User message: "I have a nut allergy. Something vegetarian under ₹300."

Extracted:
{
  "filters": {
    "is_veg": true,
    "max_price": 300,
    "exclude_allergens": ["nuts"]
  },
  "semantic_query": "vegetarian dish under 300 rupees, nut allergy"
}
```

**Why a separate parsing call:**
SQL filters need structured values - you cannot pass "around ₹300" to a WHERE clause. More importantly, allergen exclusions must become deterministic SQL filters, not semantic preferences. Leaving allergen exclusion to vector similarity - a probabilistic operation - would be a safety failure. A 0.87 similarity score is not acceptable for a nut allergy exclusion.

This is the key responsible AI design decision in the query pipeline: *safety-critical constraints extracted from natural language are always converted to deterministic SQL filters before any probabilistic operation runs.*

#### Step 2 - Query embedding

The semantic_query string is embedded using gte-small, producing a 384-dimension query vector. The same model used at ingestion - consistency is what makes similarity comparison meaningful.

#### Step 3 - SQL filter

Hard constraints become a WHERE clause that narrows the candidate pool:

```sql
SELECT * FROM dishes
WHERE menu_id = 'active-menu-uuid'
AND is_veg = true
AND price < 300
AND (allergens IS NULL OR NOT allergens @> ARRAY['nuts'])
```

The allergen line includes null dishes - dishes with no allergen data are not silently excluded. Null means unknown, not safe. The allergen cascade in the system prompt handles null correctly at response time. Excluding every null-allergen dish would leave users with nothing to eat on most menus.

A pool of 40 dishes might reduce to 15 after this filter.

> **Build update - allergen exclusion changed from filtering to tagging:** The original design filtered out allergen-conflict dishes before the LLM saw them. This caused a silent exclusion problem: when ALL dishes in a requested category conflicted with the user's allergens, the LLM had no context for those dishes and incorrectly said the category didn't exist on the menu. The fix: allergen-conflict dishes are now tagged (`allergen_conflict: true`) and kept in the candidate set. The context block passes the tag to the LLM with the instruction to acknowledge the dish exists but explain it conflicts with the user's restrictions. The system prompt has an explicit rule: never say a category doesn't exist when it has been filtered out - instead acknowledge the category and explain why none can be recommended.

#### Step 4 - Vector similarity search

The query vector is compared against the embedding column of the 15 filtered dishes using cosine similarity. The top 5 most semantically relevant dishes are returned.

```sql
SELECT
  dish_name, category, price, is_veg,
  allergens, description, description_source,
  cooking_method, spice_level,
  1 - (embedding <=> $queryVector) as similarity
FROM dishes
WHERE menu_id = 'active-menu-uuid'
AND is_veg = true
AND price < 300
AND (allergens IS NULL OR NOT allergens @> ARRAY['nuts'])
ORDER BY embedding <=> $queryVector
LIMIT 5;
```

SQL first, semantic second - not the other way around. If semantic search ran first across all 40 dishes, it might return 5 semantically relevant dishes that include non-vegetarian or over-budget options. SQL first guarantees semantic search only ranks dishes the user can actually order.

#### Step 5 - Prompt construction

The Edge Function assembles the full prompt from three parts:

**Part 1 - System prompt (from Stage 3):** all product and safety rules, allergen cascade, null convention, self-check block.

**Part 2 - Retrieved context (injected here):** the 5 retrieved dish chunks, with all metadata fields. The grounding instruction - added to the system prompt at Stage 4 - tells the model to answer only from this context:

```
The following is the menu data retrieved for this query.
Answer only from this context. Do not use knowledge of
dishes not listed below. If a dish is not in this context,
it does not exist for this conversation.

MENU CONTEXT:
{retrieved_chunks}
```

**Part 3 - User message:** the original question, unmodified.

> **Build update - multi-turn architecture replaces single-turn prompt construction:** The final implementation uses Gemini's `system_instruction` field and a `contents` array rather than a single assembled prompt string.
>
> **system_instruction:** carries the full system prompt independently of the conversation history. Always in scope regardless of history length. Never falls out of context even after many turns.
>
> **contents:** an array of prior conversation turns (capped at last 10, mapped to Gemini role format where `assistant` → `model`) followed by the current user turn. The current user turn contains the fresh menu context block and the user's message. Menu context is injected fresh into every current turn - history carries the conversation, the context block carries the dish data.
>
> **Why this matters:** The original single-turn approach sent only the current message to Gemini with no conversation history. This made multi-turn tests structurally impossible - the model had no memory of prior turns, constraints stated earlier, or dishes just discussed. The `system_instruction` + `contents` architecture is what enables constraint persistence, short-reply resolution, and the pushback restatement rule to function correctly.
>
> **Frontend fix required:** Lovable was initially sending `history: updatedHistory` where `updatedHistory` included the current message already appended. This caused the current message to appear twice in the Gemini `contents` array - two consecutive user turns with no model turn between them - which Gemini rejected (EarlyDrop). The fix: Lovable sends `history: messages` (prior turns only, before the current message is appended).

#### Step 6 - LLM response generation

The assembled prompt is sent to Gemini 2.5 Flash. Gemini reads the system prompt rules, the retrieved dish data, and the user's question. It runs the allergen cascade internally as instructed, applies the null convention, checks description_source, and generates a grounded response.

#### Step 7 - Streaming

The response is streamed to Lovable - words sent as they are generated rather than waiting for the full response. Priya sees text appearing word by word. This feels faster and more conversational regardless of total generation time.

---

## Handling Nutritional Queries

Menus rarely include calorie data. Yet users ask "suggest something healthy" or "something low calorie." MenuMate handles this on a confidence spectrum, not by fabricating numbers:

**When calories are on the menu:** SQL filter on the calories column. Exact answer.

**When calories are absent but description is rich:** Descriptive words like "steamed", "light", "grilled", "low oil" embed meaningfully. Semantic search surfaces the right dishes through meaning, not numbers.

**When calories are absent and description is sparse:** AI-generated description at ingestion time (description_source = "ai_generated") adds culinary signals - "traditionally a light, low-fat dish." description_source is passed in the retrieved context, and the system prompt instructs the model to hedge: *"Idli is traditionally a light dish - I don't have specific nutritional data for this restaurant's preparation."*

The design principle: approximate guidance from descriptive meaning is appropriate for preference queries. Fabricated numbers are never appropriate. The system is always honest about the basis of its answer.

---

## Allergen Handling - Ingestion vs Query Time

A critical design separation that must be understood clearly:

**At ingestion time:** allergens field populated only from explicit menu text. Gemini's extraction prompt explicitly prohibits inference. The SQL column contains only confirmed data or null.

**At query time:** the allergen cascade in the system prompt runs over the retrieved chunks. Tier 3 - culinary knowledge inference - fires here, with explicit caveats. The LLM infers that Kadhi traditionally contains dairy not because the database says so, but because it knows this from training data.

This separation is intentional. If allergen inference ran at ingestion and populated the SQL column, inferred data would look identical to confirmed data. Any downstream system - or any future engineer - reading the database would have no way to distinguish a confirmed allergen from an inferred one. Keeping inference at query time, behind the cascade's caveat structure, means confidence level is always visible and honest.

---

## API Calls - Complete Map

MenuMate makes four distinct types of API calls:

| Call | From | To | When | Purpose |
|---|---|---|---|---|
| 1 | Lovable (browser) | Supabase Edge Function | On PDF upload / on message send | Trigger backend logic |
| 2 | Edge Function | Gemini API | Ingestion (chunking) + Query (constraint parsing + response generation) | Structured extraction and response generation |
| 3 | Edge Function | gte-small (Supabase) | Ingestion (per dish) + Query (per message) | Text → vector |
| 4 | Edge Function | Supabase DB | Ingestion (per dish store) + Query (retrieve) | Read and write persistent data |

> **Build update - actual API call map:**
>
> | Call | From | To | When | Purpose |
> |---|---|---|---|---|
> | 1 | Lovable | ingest-menu Edge Function | PDF upload | Trigger ingestion |
> | 2 | Lovable | embed-dishes Edge Function | After ingest, repeated until has_more: false | Trigger embedding batches |
> | 3 | Lovable | chat Edge Function | Every user message | Trigger chat pipeline |
> | 4 | ingest-menu | Gemini API (temp 0.0) | Once per upload | PDF reading + structured JSON extraction |
> | 5 | ingest-menu | Supabase DB | Once per upload | Insert menus row + dish rows |
> | 6 | embed-dishes | gte-small (Supabase) | Per batch of 3 dishes | Text → 384-dim vector |
> | 7 | embed-dishes | Supabase DB | Per dish | Update embedding column |
> | 8 | chat | Supabase DB | Per message | Fetch restaurant name + dish names + filtered dishes + embeddings |
> | 9 | chat | Gemini API (temp 0.0) | Per message | Constraint parsing + query classification |
> | 10 | chat | gte-small (Supabase) | Per message | Embed semantic query |
> | 11 | chat | Gemini API (dynamic temp) | Per message | Response generation (streaming SSE) |

---

## Key Design Decisions - Summary

| Decision | What was chosen | Why |
|---|---|---|
| RAG vs long context | RAG | Scales correctly - cost flat per query, multiple menus scoped cleanly, attention focused on relevant dishes |
| PDF parser | pdfjs-dist | JavaScript-native, handles digital PDFs, no Python runtime needed |
| Chunking approach | LLM-assisted via Gemini | Robust to any menu layout; one call at ingestion; collapses chunking and structuring into one step |
| Allergen constraint in extraction prompt | Never infer allergens at ingestion | Prevents inferred data from being stored at the same confidence level as confirmed metadata |
| Embedding model | gte-small via Supabase | Free, TypeScript-native, no separate infrastructure |
| Embedded text content | Dish name + description + soft metadata (when not null) | Maximises semantic signal; hard safety fields stay in SQL only |
| Storage schema | Two tables - menus + dishes | menu_id enables multi-menu support and session scoping |
| Nullable columns | Almost all fields nullable | Accepts real menu incompleteness without rejecting valid uploads |
| Menu switching | Supported; chat clears on switch | Mixing responses from two menus in one conversation creates a trust problem |
| Constraint parsing | Separate Gemini call before main response call | Allergen exclusions must be deterministic SQL filters, not probabilistic semantic preferences |
| SQL before semantic | SQL filter narrows pool, then vector search ranks | Prevents semantic search from surfacing dishes that fail hard constraints |
| Null allergens in SQL query | Null dishes not excluded | Null means unknown - excluding them would leave users with nothing to order on most menus |
| Response streaming | Streamed word by word | Feels faster and more conversational |

> **Build updates to key decisions:**
>
> | Decision | Original | Actual build |
> |---|---|---|
> | PDF parsing | pdfjs-dist → raw text → Gemini | PDF sent as base64 to Gemini directly; Gemini reads natively |
> | Ingestion function | Single `ingest-menu` handles extract + embed | Split into `ingest-menu` (extract) + `embed-dishes` (paginated embed) due to CPU limits |
> | Allergen exclusion | Filter out conflicting dishes before LLM | Tag dishes `allergen_conflict: true`; LLM sees dish but knows not to recommend it |
> | Retrieval slice | Fixed top 5 | Dynamic: 50 (full menu), 15 (multi-constraint or nutritional), 5 (standard) |
> | Named dish handling | Not in original design | Direct SQL lookup by dish name added; bypasses vector ranking and availability filter |
> | Prompt structure | Single assembled prompt string | system_instruction (system prompt) + contents array (history + current turn with fresh context) |
> | Frontend history | Not in original design | Lovable sends prior turns only as `history`; current message sent separately as `message` |
> | nutrition_source | Not in original design | Added column to track provenance of nutritional fields independently of description_source |

---

## Interview Talking Points - Stage 4

**On RAG vs long context:**
"I explicitly evaluated long context as an alternative to RAG. For V1 with a single small menu, long context would have been simpler - just attach the PDF to every call, no vectors needed. I chose RAG because cost per query stays flat regardless of menu size, multiple menus are scoped cleanly by menu_id, and retrieval focuses LLM attention on relevant dishes rather than the full document. The trade-off was higher build complexity now for an architecture that scales correctly."

**On the stack change:**
"I switched from Streamlit to Lovable + Supabase when I secured a free subscription. The resulting architecture - React frontend, serverless Edge Functions, managed vector database - is production-grade. The constraint forced a better design."

**On LLM-assisted chunking:**
"I collapsed the chunking and structuring steps into a single Gemini call at ingestion. Rather than writing brittle rules to find dish boundaries in messy PDF text, I let the LLM read it the way a human would. The cost is one API call per upload - negligible - and the output quality directly determines retrieval quality downstream."

**On allergen inference at ingestion:**
"The Gemini extraction prompt explicitly prohibits allergen inference. If Gemini inferred dairy for Kadhi and wrote it to the allergens column, it would look identical to confirmed data. Any system reading that database - now or in future - would have no way to know the difference. Inference belongs at query time, behind the cascade's caveat structure, where the confidence level is always visible."

**On constraint parsing:**
"I added a small parsing step before the main LLM call - a separate Gemini call that extracts hard constraints from the user's natural language message and converts them to SQL filter values. Allergen exclusions specifically must be deterministic. A 0.87 semantic similarity score is not good enough when the question is whether a dish contains something that could send someone to hospital."

**On SQL before semantic:**
"The retrieval runs SQL filter first, then vector search within the filtered pool. If you run semantic search first, you might fill your five retrieval slots with dishes that fail hard constraints - non-vegetarian options for a vegetarian user, dishes over budget. SQL first guarantees semantic search only ranks dishes the user can actually consider."

**On null allergen handling in SQL:**
"I don't exclude null-allergen dishes from the filtered pool. Null means unknown - not dangerous. The allergen cascade in the system prompt handles null correctly at response time, with appropriate caveats. Excluding every null-allergen dish would leave users with almost nothing to choose from on most real menus."

**On the nutritional query design:**
"I didn't fabricate nutritional numbers to fill gaps. Instead the embedding strategy captures descriptive signals - steamed, light, grilled, rich - that carry nutritional meaning semantically. When data is absent, the system surfaces the right dishes through meaning, then hedges based on what data actually exists. The confidence level in the response always reflects the confidence level in the data."

---

*Stage 4 feeds directly into Stage 5 - temperature settings. The query pipeline now has multiple LLM calls: constraint parsing, response generation. Each has different precision requirements. Temperature will be set per call type, not as a single global value.*
