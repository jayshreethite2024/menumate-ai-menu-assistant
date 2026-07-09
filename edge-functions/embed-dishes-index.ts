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
    // STEP 1: READ REQUEST
    // --------------------------------------------------------
    const { menu_id } = await req.json()

    if (!menu_id) {
      return new Response(
        JSON.stringify({ error: 'menu_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // --------------------------------------------------------
    // STEP 2: FETCH NEXT 6 UNEMBEDDED DISHES
    //
    // Uses .is('embedding', null) to only fetch dishes that
    // have not been embedded yet. This means Lovable can call
    // this function repeatedly until all dishes are embedded
    // without needing to track an offset — the null check
    // acts as a natural cursor.
    //
    // Limit 6 = 2 batches of 3 = well within CPU budget.
    // --------------------------------------------------------
    const { data: dishes, error: fetchError } = await supabase
      .from('dishes')
      .select('id, dish_name, embedded_text')
      .eq('menu_id', menu_id)
      .is('embedding', null)
      .limit(6)

    if (fetchError) {
      throw new Error(`Failed to fetch dishes: ${fetchError.message}`)
    }

    // No unembedded dishes left — all done
    if (!dishes || dishes.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          menu_id,
          dishes_embedded: 0,
          has_more: false
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Embedding ${dishes.length} dishes for menu ${menu_id}`)

    // --------------------------------------------------------
    // STEP 3: EMBED IN BATCHES OF 3
    // --------------------------------------------------------
    const session = new Supabase.ai.Session('gte-small')
    const BATCH_SIZE = 3
    let dishesEmbedded = 0
    let dishesFailed = 0

    for (let i = 0; i < dishes.length; i += BATCH_SIZE) {
      const batch = dishes.slice(i, i + BATCH_SIZE)

      for (const dish of batch) {
        let embedding = null

        try {
          const embeddingOutput = await session.run(dish.embedded_text, {
            mean_pool: true,
            normalize: true
          })

          if (embeddingOutput && embeddingOutput.data) {
            embedding = Array.from(embeddingOutput.data as Float32Array)
          } else if (Array.isArray(embeddingOutput)) {
            embedding = embeddingOutput
          }
        } catch (embErr) {
          console.error(`Embedding failed for ${dish.dish_name}:`, JSON.stringify(embErr))
          dishesFailed++
          continue
        }

        // Update embedding column for this dish
        const { error: updateError } = await supabase
          .from('dishes')
          .update({ embedding })
          .eq('id', dish.id)

        if (updateError) {
          console.error(`Failed to update embedding for ${dish.dish_name}:`, updateError.message)
          dishesFailed++
        } else {
          dishesEmbedded++
          console.log(`Embedded: ${dish.dish_name}`)
        }
      }
    }

    // --------------------------------------------------------
    // STEP 4: CHECK IF MORE UNEMBEDDED DISHES REMAIN
    //
    // has_more: true  → Lovable calls this function again
    // has_more: false → all dishes embedded, show success
    // --------------------------------------------------------
    const { count } = await supabase
      .from('dishes')
      .select('id', { count: 'exact', head: true })
      .eq('menu_id', menu_id)
      .is('embedding', null)

    const hasMore = count !== null && count > 0

    console.log(`Batch complete. Embedded: ${dishesEmbedded}, Failed: ${dishesFailed}, Remaining: ${count}`)

    // --------------------------------------------------------
    // STEP 5: RETURN RESULT
    // --------------------------------------------------------
    return new Response(
      JSON.stringify({
        success: true,
        menu_id,
        dishes_embedded: dishesEmbedded,
        dishes_failed: dishesFailed,
        has_more: hasMore
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