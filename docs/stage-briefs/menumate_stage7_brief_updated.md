# MenuMate - Stage 7 Brief
## Build and Polish

*For handoff between chat sessions - working reference*
*Last updated: June 17, 2026*

---

## What Stage 7 Is

Stage 7 is the implementation of everything designed in Stages 1–6. It covers the full build of the three-layer stack - Supabase backend, Edge Functions, and Lovable frontend - plus the polish pass that makes the product demo-ready.

---

## Stack

| Layer | Tool | Purpose |
|---|---|---|
| Frontend | Lovable (React/TypeScript) | UI - landing page, upload modal, chat layout, menu switcher |
| Backend | Supabase Edge Functions (Deno/TypeScript) | Ingestion pipeline + embedding pipeline + chat pipeline |
| Database | Supabase PostgreSQL + pgvector | menus table, dishes table, vector embeddings |
| Embedding | gte-small (Supabase-native) | Text → 384-dimension vectors |
| LLM | Gemini 3.5 Flash (primary) + Gemini 3.1 Flash Lite (fallback) | Constraint parsing + response generation |

**Supabase project URL:** `https://jsitjsdbuhlxrmaslzcc.supabase.co`

**Supabase secrets configured:**
- `PROJECT_SUPABASE_URL`
- `SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`

**Live app URL:** `https://mate-menu-guide.lovable.app`

---

## Architecture Decision: Gemini for Constraint Parsing

The Stage 7 brief originally planned to replace the Gemini constraint parsing call with TypeScript pattern matching for speed. This was **explicitly rejected** after evaluating trade-offs:

**Why Gemini constraint parsing is kept:**
- Handles spelling mistakes ("alergic" → allergic) ✅
- Handles synonyms ("milk" → dairy, "peanuts" → nuts) ✅
- Handles informal phrasing ("I can't have them") ✅
- TypeScript pattern matching fails silently on any variation not in the hardcoded keyword list ❌

**Speed trade-off accepted:**
- Two sequential Gemini calls per message adds ~5-8 seconds
- Accepted in favour of natural language robustness
- Speed improvement deferred to Claude API switch (planned)

**Known constraint parser bug (outstanding fix needed):**
- Gemini wrongly classifies "Does the Peanut Chaat have nuts?" as allergen query type and populates `exclude_allergens: ["nuts"]`
- This causes the allergen exclusion filter to remove Peanut Chaat from retrieval before the LLM can answer the question
- Root cause: classification rule in parsing prompt includes "does this have nuts" as allergen intent - incorrect
- Fix required in parsing prompt: `exclude_allergens` should only populate when user states explicit restriction ("I'm allergic", "I can't eat", "I avoid") - not when asking factual ingredient questions
- Fix required in query_type classification: "Does X have Y?" is factual, not allergen

---

## What Is Built and Working

### Supabase Database ✅

**pgvector enabled.**

**menus table:**
```sql
id uuid primary key default gen_random_uuid()
restaurant_name text
uploaded_at timestamp with time zone default now()
page_count integer
```

**dishes table:**
```sql
id uuid primary key default gen_random_uuid()
menu_id uuid references menus(id) on delete cascade
dish_name text not null
category text
price integer
is_veg boolean
allergens text[]
cooking_method text
is_fried boolean
spice_level text
protein_level text
fat_level text
calories integer
available boolean
description text
description_source text not null
embedded_text text not null
embedding vector(384)
created_at timestamp with time zone default now()
```

> **Build update - dishes table has one additional column:**
> `nutrition_source text` - added to track provenance of nutritional fields independently of `description_source`. Values: `"menu"` (explicitly stated on menu), `"ai_inferred"` (Gemini inferred from primary ingredient/cooking method), `null` (both protein_level and fat_level are null). Nullable. Added via `ALTER TABLE dishes ADD COLUMN nutrition_source text;` - non-destructive, existing rows default to null.

**RLS enabled on both tables.** Policies allow service role full access.

**ivfflat index on embedding column** for fast vector similarity search.

---

### Edge Function 1: `ingest-menu` ✅

**What it does:**
1. Receives PDF + restaurant_name from Lovable as form-data
2. Converts PDF to base64 using safe chunked conversion
3. Sends PDF directly to Gemini - reads natively, extracts structured JSON
4. Option B duplicate prevention - deletes existing menu with same restaurant_name before inserting
5. Inserts new row into menus table
6. Builds embedded_text for each dish and inserts all dish rows WITHOUT embeddings (embedding: null)
7. Returns `{ success, menu_id, dishes_processed, dishes_inserted }`

**Why embeddings are not done here:**
Supabase free tier Edge Functions have a 2-second CPU time limit. Running gte-small embeddings for 22+ dishes in sequence exceeds this limit and causes WORKER_RESOURCE_LIMIT errors. Embeddings are handled by the separate `embed-dishes` function called immediately after by the frontend.

**Key implementation details:**
- Base64 conversion uses `Array.from(bytes).map(...).join('')` - safe for any size, no spread operator
- Gemini model: `gemini-3.5-flash` with fallback to `gemini-3.1-flash-lite`
- Allergen rule enforced in extraction prompt: never infer allergens
- Unavailability rule in extraction prompt: set `available: false` if dish name or description contains UNAVAILABLE or CURRENTLY UNAVAILABLE
- CORS headers on all responses including OPTIONS preflight
- Env variables: `PROJECT_SUPABASE_URL`, `SERVICE_ROLE_KEY`, `GEMINI_API_KEY`

**Tested and verified:**
- 22 dishes extracted correctly from Rasa test menu
- All dishes inserted with embedding: null
- Duplicate prevention working - re-upload replaces existing menu
- Mango Sorbet: available: false ✅

---

### Edge Function 2: `embed-dishes` ✅

**Why this function exists:**
The ingestion pipeline previously ran gte-small embeddings inside `ingest-menu`. At 22+ dishes this exhausted the Supabase free tier CPU time limit (2 seconds). Splitting into a separate function gives each invocation a fresh CPU budget.

**What it does:**
1. Receives `{ menu_id }` from Lovable as JSON
2. Fetches up to 6 unembedded dishes (embedding IS NULL) for this menu
3. Embeds each dish via gte-small in batches of 3
4. Updates the embedding column for each dish individually
5. Counts remaining unembedded dishes
6. Returns `{ success, dishes_embedded, dishes_failed, has_more }`

**Pagination via has_more:**
Lovable calls `embed-dishes` in a loop until `has_more: false`. Each call processes 6 dishes. For a 22-dish menu this is 4 calls. Each call gets a fresh CPU budget.

`.is('embedding', null)` acts as a natural cursor - no offset tracking needed. Each invocation picks up exactly where the last one left off.

**Key implementation details:**
- BATCH_SIZE: 3 embeddings per batch
- LIMIT: 6 dishes per invocation
- Individual dish updates (not bulk) - if one fails, others are unaffected
- CORS headers on all responses including OPTIONS preflight
- Env variables: `PROJECT_SUPABASE_URL`, `SERVICE_ROLE_KEY`

---

### Edge Function 3: `chat` ✅

**What it does:**
1. Receives `{ message, menu_id }` from Lovable as JSON
2. Fetches restaurant_name from menus table
3. Parses constraints from user message via Gemini (separate call)
4. Embeds semantic query via gte-small
5. SQL filter on dishes table (is_veg, price, available)
6. Allergen exclusion filter (null dishes kept - null ≠ safe)
7. Fetches embeddings for filtered dishes
8. Cosine similarity ranking in-memory → top 5 dishes (top 50 for full menu queries)
9. Builds full prompt: system prompt + retrieved context + user message
10. Sets temperature by query_type (allergen: 0.1, factual: 0.2, recommendation: 0.4)
11. Streams response from Gemini via `streamGenerateContent?alt=sse`
12. Pipes SSE stream to Lovable as plain text

> **Build update - chat function significantly updated from original description:**
>
> **Request signature changed:** Function now receives `{ message, menu_id, history }`. `history` is an array of prior conversation turns (last 10 max), sent by Lovable as prior turns only - not including the current message. This was a critical frontend fix: Lovable was initially sending `history: updatedHistory` which included the current message, causing a duplicate user turn in Gemini's contents array and triggering an EarlyDrop (Gemini rejects two consecutive user turns with no model turn between).
>
> **Named dish direct SQL lookup added (Step 4a):** Before SQL filtering, the function fetches all dish names for the active menu and checks whether any appear in the user's message. If a match is found, that dish is fetched directly via SQL (bypassing availability filter and vector ranking) and injected at the top of the context. This ensures named dishes - including unavailable ones like Mango Sorbet - always reach the LLM regardless of their vector similarity score.
>
> **Allergen exclusion changed from filtering to tagging:** Dishes with confirmed allergen conflicts are no longer removed from the candidate set. Instead they are tagged `allergen_conflict: true` and kept. The context block passes this tag to the LLM with instruction to acknowledge the dish exists but explain it conflicts with the user's restrictions. This prevents the silent exclusion problem where the LLM incorrectly said a whole category didn't exist on the menu.
>
> **Dynamic retrieval slice:** The `.slice(0, 5)` is now dynamic: 50 for full menu queries, 15 for multi-constraint or nutritional queries, 5 for standard queries.
>
> **Multi-turn architecture:** System prompt moved to Gemini's `system_instruction` field (always in scope, never falls out of context). Prior conversation turns passed as Gemini `contents` array with role mapping (`assistant` → `model`). Current user turn contains fresh menu context block + user message. Menu context is injected fresh into every current turn - history carries conversation, context block carries dish data.

**Key implementation details:**
- System prompt: full Stage 3 system prompt via `getSystemPrompt(restaurantName)` function
- `[restaurant name]` placeholder replaced with `${restaurantName}` dynamically
- Full menu query detection via regex - raises retrieval limit from 5 to 50
- Streaming via TransformStream - chunks piped to client as generated
- Transfer-Encoding: chunked + Cache-Control: no-cache + Connection: keep-alive headers on streaming response
- Fallback model: tries `gemini-3.5-flash` first, falls back to `gemini-3.1-flash-lite` on 429/503
- CORS headers on all responses including OPTIONS preflight
- Cosine similarity handles pgvector output formats (array, string, object)

**Known outstanding issue - allergen exclusion filter conflict:**
When user asks "Does the Peanut Chaat have nuts?", Gemini constraint parser wrongly sets `exclude_allergens: ["nuts"]`, which removes Peanut Chaat from retrieval. Fix: tighten constraint parsing prompt so `exclude_allergens` only populates on explicit restriction statements, not ingredient questions. See fix details in Outstanding Issues section below.

---

### Lovable Frontend ✅

**Landing page:**
- Warm peach gradient background (#FAFAF7 to warm peach)
- Bowl with steam icon in saffron (#D47C0F)
- MenuMate title in serif font (Playfair Display), large
- Tagline: "Your personal guide to every dish on the menu."
- Body copy: "Upload a PDF and I'll help you explore, discover, and order with confidence - whatever your taste, diet, or budget."
- "UPLOAD A MENU" button in saffron with sparkle icon

**Upload modal:**
- Triggered by Upload a Menu button
- Shows selected PDF filename
- Restaurant name field - required, validated before upload
- "Upload & Process" button with loading state ("Processing menu...")
- Calls `ingest-menu` Edge Function as form-data
- On success: immediately calls `embed-dishes` in a loop until `has_more: false`
- Loading state stays active across both ingest and embed calls
- On success: transitions to chat layout, shows success message
- On error: shows error message inside modal

**Chat layout:**
- Left sidebar: MenuMate branding, YOUR MENUS list with active menu checkmark, "+ Upload another menu" at bottom
- Main area: chat messages, warm peach gradient background matching landing page
- User messages: right-aligned, saffron bubble
- MenuMate messages: left-aligned, light bubble, rendered via react-markdown
- Typing indicator: three animated dots while waiting
- Fixed input bar at bottom: text field + send button (type="button" - prevents form submit reload)
- Streaming response renders word-by-word as chunks arrive

**Fixes applied this session:**
- Send button `type="button"` added - prevents page reload on Enter/send ✅
- react-markdown installed - markdown renders correctly in chat bubbles ✅
- Compact spacing applied to react-markdown ul/li/p elements ✅
- `embed-dishes` loop added to upload flow ✅

**Success message format:**
"[Restaurant name] menu loaded! I've read through [dishes_processed] dishes. What would you like to know?"

---

## System Prompt Changes This Session

**Two additions made to the allergen handling section:**

**Addition 1 - ALLERGEN-FILTERED RECOMMENDATIONS (new section):**
Added before the four-tier cascade. When user states an allergy AND asks for recommendations (not asking about a specific dish), the model should:
1. Silently use Tier 1 to exclude confirmed-allergen dishes
2. Surface remaining dishes as options
3. Add ONE collective caveat at the end for null-allergen dishes
4. Lead with options, end with caveat
5. NOT run the four-tier cascade dish by dish in recommendation context

**Addition 2 - Description source rule for allergen cascade:**
Added after the critical safety rule, before ALLERGEN-FILTERED RECOMMENDATIONS:
```
If description_source is "ai_generated", treat the description 
as null when reasoning about allergens, ingredients, or dish 
composition. Use it only to understand the general nature of 
the dish for recommendation purposes.
For the allergen cascade: skip Tier 2 if description_source 
is "ai_generated". Proceed directly to Tier 3.
```

---

## Test Menu: Rasa - Modern Indian Kitchen

**22 dishes across 4 categories.** Designed to cover all 31 eval test cases.

| Category | Dishes |
|---|---|
| Starters | Peanut Chaat, Satay, Kadhi, House Special, Idli, Tomato Shorba |
| Mains | Butter Chicken, Dal Tadka, Veg Pulao, Prawn Masala, Paneer Tikka Masala, Aloo Gobi, Egg Curry, Nasi Lemak, Mushroom Pepper Fry |
| Breads & Sides | Garlic Naan, Steamed Rice, Raita, Papad |
| Desserts | Gulab Jamun, Mango Sorbet, Phirni |

**Key data points verified in Supabase:**
- Peanut Chaat: `allergens: ["nuts"]`, `available: true`, `embedding: populated` ✅
- Mango Sorbet: `available: false` ✅
- Phirni: `description` contains injected instruction, `allergens: ["dairy","gluten"]` ✅
- Kadhi: `price: null`, `allergens: null` ✅
- Idli: `description_source: "ai_generated"` ✅
- All 22 dishes: `embedding: populated` ✅

---

## Outstanding Issues - Fix Before Calling Stage 7 Complete

### Issue 1 - Constraint parser: wrong allergen exclusion on ingredient questions (HIGH)
*(Resolved - see below)*

**Symptom:** "Does the Peanut Chaat have nuts?" → dish not found → "That does not appear to be on this menu"

**Root cause:** Gemini constraint parser populates `exclude_allergens: ["nuts"]` when it sees the word "nuts" - even when the user is asking a factual ingredient question, not stating an allergy. The exclusion filter then removes Peanut Chaat from retrieval.

> **Resolved:** Parsing prompt tightened with explicit rules distinguishing restriction statements from ingredient questions. `exclude_allergens` only populates on "I am allergic to X", "I can't eat X", "I avoid X", "without X" in recommendation context. "Does X have Y?" classified as `factual`, not `allergen`. Named dish direct SQL lookup (added separately) also ensures named dishes reach the LLM regardless of allergen exclusion filter.

### Issue 2 - Run all 31 evals and document results (HIGH)
*(Resolved - see below)*

> **Resolved:** 35 test cases run across 3 eval rounds. Run 3 achieved 35/35 pass. Detailed reports produced for Run 2 and Run 3. Root causes documented per failing test with fix category (system prompt / parsing prompt / edge function code / temperature).

### Issue 3 - Streaming arrives as full chunk, not word by word (MEDIUM)
*(Resolved - see below)*

> **Resolved:** Root cause was the Lovable frontend sending the current message in both `history` and `message`, causing Gemini to reject the malformed contents array (EarlyDrop). Once the frontend history bug was fixed, streaming works correctly - tokens arrive word by word as generated.

### Issue 4 - Responses too robotic in tone (MEDIUM)
*(Partially resolved)*

> **Status:** Improved significantly via system prompt additions (warm tone instruction, multi-turn context enabling natural follow-ups). Acceptable for V1 demo. Full resolution would require switching response generation to Claude API - deferred to V2.

### Issue 5 - Lovable error popup (LOW)
*(Status: not blocking)*

> **Status:** Not confirmed resolved. Does not affect core functionality or eval results. Address before final demo if it recurs.

---

## Known Issues Tracker

| Issue | Severity | Status | Fix |
|---|---|---|---|
| Constraint parser: exclude_allergens fires on ingredient questions | High | ✅ Resolved | Parsing prompt tightened; named dish lookup added |
| 31 evals not yet run | High | ✅ Resolved | 35 tests run across 3 rounds; 35/35 passing |
| Streaming arrives as full chunk | Medium | ✅ Resolved | Frontend history bug fixed (EarlyDrop eliminated) |
| Responses too robotic | Medium | Partially resolved | System prompt improved; Claude API switch deferred to V2 |
| Lovable error popup | Low | Not confirmed | Does not block demo |
| Silent allergen exclusion (desserts bug) | High | ✅ Resolved | Tagging approach replaces filtering; system prompt updated |
| Multi-turn context loss | High | ✅ Resolved | history parameter + system_instruction architecture |
| Nutritional query retrieval (protein/fat) | Medium | ✅ Resolved | AI-inferred fields at ingestion; enriched embedded_text; dynamic slice |

---

*Stage 7 is complete when: constraint parser fix deployed, all must-pass evals passing, results documented, streaming verified, and Lovable error popup removed.*
