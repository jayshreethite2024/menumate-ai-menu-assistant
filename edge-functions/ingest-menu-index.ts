// ============================================================
// MenuMate -- ingest-menu Edge Function
// ============================================================
// Receives a restaurant menu PDF, extracts all dishes as
// structured JSON via Gemini, and inserts dish rows into
// Supabase with embedding: null.
//
// Pipeline:
//   1. Receive PDF as multipart form-data
//   2. Convert to base64 (safe chunked method)
//   3. Send to Gemini as inline_data -- Gemini reads natively
//   4. Parse structured JSON (one object per dish)
//   5. Delete existing menu with same restaurant name
//   6. Insert menus row + all dish rows (embedding: null)
//   7. Return menu_id to frontend
//
// Embeddings are handled separately by embed-dishes to stay
// within Supabase free tier CPU time limits (2s per invocation).
//
// Required environment variables (set in Supabase dashboard):
//   PROJECT_SUPABASE_URL  -- your Supabase project URL
//   SERVICE_ROLE_KEY      -- your Supabase service role key
//   GEMINI_API_KEY        -- your Google AI Studio API key
// ============================================================
// ============================================================
// IMPORTS
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ============================================================
// SETUP
// ============================================================
declare const Supabase: any

const supabase = createClient(
  Deno.env.get('PROJECT_SUPABASE_URL')!,
  Deno.env.get('SERVICE_ROLE_KEY')!
)

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!

// ============================================================
// HELPER: Safe base64 encoding for binary data in Deno
// ============================================================
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const binString = Array.from(bytes)
    .map(byte => String.fromCharCode(byte))
    .join('')
  return btoa(binString)
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

// ============================================================
// MAIN FUNCTION
// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {

    // --------------------------------------------------------
    // STEP 1: READ THE PDF FROM THE REQUEST
    // --------------------------------------------------------
    const formData = await req.formData()
    const pdfFile = formData.get('pdf') as File

    if (!pdfFile) {
      return new Response(
        JSON.stringify({ error: 'No PDF file provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const pdfBuffer = await pdfFile.arrayBuffer()
    const uint8Array = new Uint8Array(pdfBuffer)

    // --------------------------------------------------------
    // STEP 2: CONVERT PDF TO BASE64
    // --------------------------------------------------------
    const base64PDF = uint8ArrayToBase64(uint8Array)

    // --------------------------------------------------------
    // STEP 3: SEND PDF TO GEMINI
    // Extracts all dishes and returns structured JSON
    // --------------------------------------------------------
    const extractionPrompt = `
You are a menu data extractor. Extract all dishes from this menu PDF and return a JSON array.

For each dish, extract these fields:
- dish_name (string, required)
- category (string or null — the menu section this dish belongs to, exactly as written)
- price (integer or null — numeric value only, no currency symbol)
- is_veg (boolean or null — true if explicitly marked vegetarian, false if non-vegetarian, null if not specified)
- allergens (array of strings or null — ONLY include allergens explicitly stated in the menu text. Never infer allergens from dish names or descriptions. If not explicitly stated, set to null)
- cooking_method (string or null — "fried", "grilled", "steamed", "tandoor", "baked", or null)
- is_fried (boolean or null — true only if cooking method is explicitly fried)
- spice_level (string or null — "mild", "medium", or "hot")
- protein_level (string or null — "high", "moderate", or "low". 
  Infer from primary ingredient if not stated: prawns/chicken/eggs/paneer/lentils = high, 
  rice/bread = low, mixed dishes = moderate)
- fat_level (string or null — "high", "moderate", or "low". 
  Infer if not stated: fried/cream/butter dishes = high, grilled/steamed = low, 
  curry-based = moderate)
- calories (integer or null — only if explicitly stated on the menu. 
  Do NOT infer calories.)
- available (boolean — true unless the menu explicitly marks it as UNAVAILABLE or CURRENTLY UNAVAILABLE)
- description (string or null — the dish description exactly as written on the menu)
- description_source (string — "menu" if description came from PDF, "ai_generated" if you wrote it because none existed)

Important rules:
1. Never infer allergens. Only populate allergens if the menu text explicitly states them.
2. If a dish has no description on the menu, write a brief factual description based on culinary knowledge and set description_source to "ai_generated".
3. Return only valid JSON array — no explanation, no markdown, no backticks.
4. Every dish must have dish_name and description_source at minimum.
5. If a dish name or description contains the word UNAVAILABLE or CURRENTLY UNAVAILABLE, set available to false.
6. For protein_level and fat_level, always infer if not explicitly stated — 
   never leave null if the dish type gives enough signal. 
   Set nutrition_source to "ai_inferred" if either field was inferred, 
   "menu" if explicitly stated, null if dish type gives no signal.
`

    const models = ['gemini-3.5-flash', 'gemini-3.1-flash-lite']
    let geminiResponse = null
    let geminiData = null

    for (const model of models) {
      geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  inline_data: {
                    mime_type: 'application/pdf',
                    data: base64PDF
                  }
                },
                { text: extractionPrompt }
              ]
            }],
            generationConfig: { temperature: 0.0 }
          })
        }
      )
      geminiData = await geminiResponse.json()
      if (geminiResponse.status === 200) break
      console.log(`${model} unavailable, trying fallback...`)
    }

    console.log('Gemini status:', geminiResponse.status)

    if (geminiResponse.status !== 200) {
      return new Response(
        JSON.stringify({ error: 'Gemini API error', details: geminiData }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || ''

    if (!rawText.trim()) {
      return new Response(
        JSON.stringify({ error: 'No content returned from Gemini' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const cleanedJson = rawText
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim()

    let dishes
    try {
      dishes = JSON.parse(cleanedJson)
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Failed to parse Gemini response as JSON', raw: rawText }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!Array.isArray(dishes) || dishes.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No dishes could be extracted from this menu' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // --------------------------------------------------------
    // STEP 4: INSERT INTO MENUS TABLE
    // Option B — delete existing menu with same name first
    // --------------------------------------------------------
    const restaurantName = formData.get('restaurant_name') as string || null

    if (restaurantName) {
      await supabase
        .from('menus')
        .delete()
        .eq('restaurant_name', restaurantName)
    }

    const { data: menuRecord, error: menuError } = await supabase
      .from('menus')
      .insert({
        restaurant_name: restaurantName,
        page_count: null
      })
      .select()
      .single()

    if (menuError) {
      throw new Error(`Failed to create menu record: ${menuError.message}`)
    }

    const menuId = menuRecord.id

    // --------------------------------------------------------
    // STEP 5: INSERT ALL DISHES WITHOUT EMBEDDINGS
    //
    // Embeddings are handled by the separate embed-dishes
    // function called immediately after by the frontend.
    // This keeps ingest-menu within the CPU time budget.
    //
    // embedded_text is built here so embed-dishes can
    // read it directly without re-constructing it.
    // --------------------------------------------------------
    const dishRows = dishes.map((dish: any) => {
      let embeddedText = `${dish.dish_name}`
      if (dish.description) embeddedText += ` — ${dish.description}`
      if (dish.spice_level) embeddedText += `. Spice level: ${dish.spice_level}`
      if (dish.cooking_method) embeddedText += `. Cooking method: ${dish.cooking_method}`
      if (dish.protein_level) embeddedText += `. Protein: ${dish.protein_level}`
      if (dish.fat_level) embeddedText += `. Fat: ${dish.fat_level}`
      if (dish.calories) embeddedText += `. Calories: ${dish.calories}`
      

      return {
        menu_id: menuId,
        dish_name: dish.dish_name,
        category: dish.category || null,
        price: dish.price || null,
        is_veg: dish.is_veg ?? null,
        allergens: dish.allergens || null,
        cooking_method: dish.cooking_method || null,
        is_fried: dish.is_fried ?? null,
        spice_level: dish.spice_level || null,
        protein_level: dish.protein_level || null,
        fat_level: dish.fat_level || null,
        calories: dish.calories || null,
        nutrition_source: dish.nutrition_source || null,
        available: dish.available ?? true,
        description: dish.description || null,
        description_source: dish.description_source || 'ai_generated',
        embedded_text: embeddedText,
        embedding: null  // populated by embed-dishes
        
      }
    })

    const { error: insertError } = await supabase
      .from('dishes')
      .insert(dishRows)

    if (insertError) {
      throw new Error(`Failed to insert dishes: ${insertError.message}`)
    }

    console.log(`Inserted ${dishRows.length} dishes without embeddings`)

    // --------------------------------------------------------
    // STEP 6: RETURN SUCCESS
    // Frontend will immediately call embed-dishes with menu_id
    // --------------------------------------------------------
    return new Response(
      JSON.stringify({
        success: true,
        menu_id: menuId,
        dishes_processed: dishes.length,
        dishes_inserted: dishRows.length
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Function error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
