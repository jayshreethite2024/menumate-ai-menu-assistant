# MenuMate - Stage 5 Brief
## Temperature Settings

*For interview use - PM case study reference*

---

## What Stage 5 Is

Temperature is the parameter that controls how deterministic or creative an LLM's output is. Setting it correctly is a product decision, not a technical one - the wrong temperature on a safety-critical response is a product failure, not a configuration mistake.

For MenuMate, temperature is more complex than a single global setting. The pipeline has three distinct LLM calls, each doing a fundamentally different job. Each call has different output requirements, different failure modes at the wrong temperature, and therefore a different correct temperature value.

---

## What Temperature Controls

When an LLM generates a response, it samples from a probability distribution over possible next words. Temperature controls how that sampling works.

**Low temperature (0.0 – 0.2):** the model strongly favours the most probable option. Output is consistent, predictable, and precise. The same input produces nearly identical output every time.

**High temperature (0.7 – 1.0):** the model spreads probability across more options. Output is varied, creative, and expressive. The same input produces different output on each run.

The failure modes are symmetric:
- Temperature too low on a conversational response → robotic, repetitive, feels like a database printout
- Temperature too high on a safety-critical response → inconsistent caveat language, varied warning structure, safety rules applied unevenly

---

## MenuMate's Three LLM Calls

| Call | Job | Output type |
|---|---|---|
| Call 1 - Constraint parsing + query classification | Extract structured values and classify query type from natural language | Structured JSON |
| Call 2 - Response generation | Answer the user's question conversationally | Natural language |
| Call 3 - Ingestion chunking | Extract structured dish data from raw PDF text | Structured JSON |

Calls 1 and 3 are extraction tasks - the output must be deterministic and schema-compliant. Call 2 is a generation task - the output must be accurate, grounded, and appropriately conversational. Call 2 is further subdivided by query type, because not all responses have the same precision requirements.

> **Build update - four LLM calls, not three, across three Edge Functions:**
>
> | Call | Function | Job | Temperature |
> |---|---|---|---|
> | Call 1 - Ingestion extraction | `ingest-menu` | Read PDF natively, extract all dishes as structured JSON | 0.0 |
> | Call 2 - Constraint parsing + classification | `chat` | Extract SQL filters, semantic query, query_type from user message | 0.0 |
> | Call 3 - Response generation | `chat` | Answer the user's question conversationally | Dynamic |
>
> `embed-dishes` makes no LLM calls - it calls gte-small only. The temperature logic and call classification from the original brief still applies; the count updates to reflect the ingestion split.

---

## Temperature Decisions - Call by Call

### Call 3 - Ingestion Chunking (temperature: 0.0)

Takes raw PDF text and returns a structured JSON array - one object per dish, all fields correctly populated or null.

**Why 0.0:**
This is pure structured extraction. The same menu uploaded twice must produce identical JSON. Any variability means the database becomes inconsistent - dish names vary between uploads, fields are populated on one run and null on another, downstream retrieval quality becomes unpredictable. Zero variability is the only acceptable outcome. Temperature 0.0 eliminates randomness entirely.

---

### Call 1 - Constraint Parsing + Query Classification (temperature: 0.0)

Takes the user's natural language message and returns a structured JSON object containing SQL filter values, a semantic query string, and a query_type classification.

**Why 0.0:**
Same reasoning as Call 3. This is structured extraction. The same message must produce the same filter values every time. Variability here causes downstream failures - wrong SQL filter, wrong allergen exclusion, wrong temperature applied to the response generation call. For allergen exclusions specifically, variability is a safety failure: "nut allergy" must always become exclude_allergens: ["nuts"], never sometimes, not usually.

---

### Call 2 - Response Generation (temperature: dynamic)

This call generates the actual response the user sees. Not all responses have the same requirements - a safety warning and a restaurant recommendation are fundamentally different tasks even though they use the same API call.

**Design decision: dynamic temperature based on query_type**

Rather than setting one conservative temperature for all responses, the pipeline uses the query_type field from Call 1 to set temperature dynamically before Call 2 runs:

```
query_type: "allergen"        → temperature: 0.1
query_type: "factual"         → temperature: 0.2
query_type: "recommendation"  → temperature: 0.4
```

If query_type is missing or unrecognised, temperature defaults to 0.2 - the safe middle ground.

This means the constraint parsing call (Call 1) serves two purposes: it extracts SQL filter values AND it determines what kind of response is needed, which sets the temperature for the response that follows.

---

#### Response type: allergen (temperature: 0.1)

Queries where the primary intent is allergen or dietary safety:
- "Does this have nuts?"
- "I'm allergic to dairy - what can I eat?"
- "Is this gluten free?"
- "Is this safe for me?"

**Why 0.1 not 0.0:**
The allergen cascade must fire correctly and consistently every time. Caveat language must be precise - "traditionally", "the menu does not specify", "please confirm with the restaurant" must appear in the right places. The safety warning must always lead the response, never be buried.

Temperature 0.0 would work for safety but produces robotic, repetitive phrasing that erodes trust over a conversation. Temperature 0.1 introduces the minimum naturalness needed for the response to feel human while keeping safety language consistent.

---

#### Response type: factual (temperature: 0.2)

Queries where the primary intent is a specific retrievable fact:
- "What is the price of Butter Chicken?"
- "Is Dal Tadka vegetarian?"
- "What is Nasi Lemak?"

**Why 0.2:**
Factual queries have one correct answer from the retrieved context. Variability is not needed - but a small amount of natural phrasing variation stops the responses from feeling mechanical across a multi-turn conversation. Temperature 0.2 gives just enough naturalness without risking factual inconsistency.

---

#### Response type: recommendation (temperature: 0.4)

Queries where the primary intent is a suggestion or preference:
- "Suggest something light for a cold evening."
- "What would you recommend for a first-time visitor?"
- "I'm not very hungry - what's a good option?"

**Why 0.4:**
This is where MenuMate needs to feel like a knowledgeable friend, not a lookup table. Recommendation responses should be warm, slightly varied, expressive. Two users asking the same question on the same menu should get responses that feel naturally worded - not identical.

Temperature 0.4 gives moderate creative latitude while keeping the grounding constraints reliable. The system prompt's self-check block and NEVER rules still apply - the model cannot hallucinate dishes or ignore hard constraints regardless of temperature. 0.4 affects tone and phrasing, not factual accuracy.

Temperature was not set higher than 0.4 because recommendation responses still contain hard constraints - allergen exclusions, available dishes, price limits - that must be applied consistently. Higher temperature risks the model occasionally drifting from those constraints.

---

## Multi-Type Query Handling

Real user messages frequently contain multiple intents. A single message might be simultaneously an allergen query, a factual question, and a recommendation request.

**The conflict resolution rule:**
query_type is always a single value - one temperature is set per response call. When multiple intents are present, a priority order resolves the classification:

```
Priority 1 - allergen: always wins if any safety intent is present
Priority 2 - recommendation: wins over factual if both present
Priority 3 - factual: default when no other intent is present
```

**Examples:**

*"I'm allergic to nuts - suggest something light."*
→ allergen + recommendation → allergen wins → temperature: 0.1

*"What is Nasi Lemak and would you recommend it for mild food lovers?"*
→ factual + recommendation → recommendation wins → temperature: 0.4

*"I'm allergic to nuts - what's the price of Dal Tadka and suggest something light?"*
→ allergen + factual + recommendation → allergen wins → temperature: 0.1

**Why allergen always wins:**
When a safety-critical intent is present in a query, the entire response runs at the allergen temperature. The recommendation or factual parts of the response will feel slightly more constrained than they would at their own optimal temperature. This is the correct trade-off - when safety is in the query, you do not loosen temperature for the non-safety parts of the response.

---

## The Classification Prompt

The query_type field is produced by Call 1 - the constraint parsing call. The classification instructions added to that prompt:

```
Also classify the query into exactly one type based on 
primary intent. Output query_type as a single string only.

"allergen"  - any allergen, dietary safety, or personal 
              safety intent is present:
              "does this have nuts"
              "I'm allergic to X"
              "is this gluten free"
              "is this safe for me / can I eat this"
              "will this affect me"

"factual"   - primary intent is a specific fact:
              "what is the price of X"
              "is X vegetarian"
              "what is X" (dish explanation)

"recommendation" - primary intent is a suggestion:
              "suggest something light"
              "what would you recommend"
              "something for a cold evening"

If multiple intents are present, apply this priority order:
1. allergen  - always wins if any safety intent is present
2. recommendation - wins over factual if both present
3. factual - default if no other intent present

Output a single string. Never output multiple values.
```

**Why "single string only" is explicit:**
Without this instruction, Gemini might return an array - ["allergen", "recommendation"]. The Edge Function temperature lookup expects a string. An array would return undefined, fall back to the default temperature of 0.2, and silently apply the wrong temperature to an allergen query - a safety failure that would produce no error and be invisible without testing.

---

## Multi-Language Queries

Multi-language input (e.g. Hinglish - "kuch light chahiye, nuts nahi") is out of scope for V1. Both V1 personas interact in English, and the product is designed around that assumption.

Gemini 2.5 Flash's multilingual capability means the system may handle Hinglish queries correctly in practice - extracting the right filters, classifying correctly - but this is untested behaviour, not a designed feature.

Explicit multi-language support - input language detection, language-matched responses - is a natural V2 addition, particularly as the product scales beyond the current personas.

---

## Complete Temperature Map

| LLM Call | Temperature | Reason |
|---|---|---|
| Call 3 - Ingestion chunking | 0.0 | Structured JSON extraction - zero variability |
| Call 1 - Constraint parsing + classification | 0.0 | Structured JSON extraction - zero variability |
| Call 2 - Response: allergen | 0.1 | Safety language must be consistent; minimum naturalness |
| Call 2 - Response: factual | 0.2 | One correct answer; slight naturalness over 0.0 |
| Call 2 - Response: recommendation | 0.4 | Conversational warmth; grounding constraints still apply |
| Call 2 - Default (unknown query_type) | 0.2 | Safe middle ground if classification fails |

> **Build update - temperature map aligned to actual call numbering:**
>
> | LLM Call | Function | Temperature |
> |---|---|---|
> | Call 1 - Ingestion extraction | `ingest-menu` | 0.0 |
> | Call 2 - Constraint parsing + classification | `chat` | 0.0 |
> | Call 3 - Response: allergen | `chat` | 0.1 |
> | Call 3 - Response: factual | `chat` | 0.2 |
> | Call 3 - Response: recommendation | `chat` | 0.4 |
> | Call 3 - Default (unknown query_type) | `chat` | 0.2 |
>
> Temperature logic and values unchanged. Call numbering updated to reflect three-function architecture.

---

## Key Design Decisions

**Dynamic temperature over a single global value**
A single conservative temperature (e.g. 0.2 for all responses) would work for safety but would make recommendation responses feel mechanical. A single permissive temperature (e.g. 0.4 for all responses) would give warm recommendations but risk inconsistent safety language. Dynamic temperature per query type is the correct design - each response gets the temperature its job actually requires.

**query_type resolved to a single value**
Multi-type queries are resolved to one temperature before the response call runs. The alternative - running one response call per intent type and combining outputs - would add latency, cost, and complexity for marginal gain. The priority order handles conflict resolution cleanly inside the parsing prompt.

**Allergen always wins in conflict resolution**
This is a responsible AI design decision, not just a convenience rule. When safety intent is present in a query, the entire response runs at the allergen temperature. The recommendation parts of a mixed query will be slightly more constrained than at their optimal temperature - that is the correct trade-off.

**0.4 ceiling on recommendation temperature**
Recommendation responses contain hard constraints - allergen exclusions, availability, price - that must be applied consistently. Temperature above 0.4 risks the model occasionally drifting from those constraints. The ceiling is a safety boundary disguised as a style decision.

---

## Interview Talking Points - Stage 5

**On dynamic temperature:**
"I set temperature per query type rather than globally. A single temperature forces a trade-off between safety consistency and conversational warmth that doesn't need to be made - the query type is already known from the parsing step, so the pipeline can apply the right temperature for the right job."

**On allergen temperature:**
"I set allergen response temperature to 0.1, not 0.0. Zero would give perfectly consistent safety language but robotic phrasing that erodes trust over a conversation. 0.1 is the minimum needed for natural expression while keeping the caveat structure reliable."

**On the conflict resolution rule:**
"When a query contains multiple intents, allergen always wins. The recommendation parts of a mixed query run at 0.1 instead of 0.4 - slightly more constrained than ideal. That's the correct trade-off. You don't loosen temperature for the conversational parts of a response when safety is also in the query."

**On the 0.4 ceiling:**
"I capped recommendation temperature at 0.4 rather than going higher. Recommendation responses still contain hard constraints - allergen exclusions, price limits, dish availability. Higher temperature risks the model occasionally drifting from those constraints. The ceiling is a responsible AI decision, not a conservative default."

**On single string output for query_type:**
"I explicitly instructed the model to output query_type as a single string, never an array. Without that, a multi-intent query might produce an array that breaks the temperature lookup silently - the pipeline would default to 0.2 and apply the wrong temperature to an allergen query with no error and no visibility. Defensive prompt design is as important as defensive code."

---

*Stage 5 feeds directly into Stage 6 - evaluation framework. Temperature settings are hypotheses until tested. Stage 6 defines how MenuMate's responses are evaluated against expected behaviour - including whether the allergen cascade fires correctly at temperature 0.1, whether recommendation responses feel appropriately warm at 0.4, and whether the query classification prompt handles edge cases correctly.*
