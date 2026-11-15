// Controller/AiBot.controller.js
const { Pool } = require('pg');
require('dotenv').config();
const { invalidateProductsCache } = require('./Inventory.controller');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

// Helper: Normalize strings for comparisons
const cleanStr = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cap = (s) => (s || '')
  .toLowerCase()
  .split(/[\s_]+/)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');

// Fuzzy score between 0 and 1
function similarity(s1, s2) {
  const c1 = cleanStr(s1);
  const c2 = cleanStr(s2);
  if (!c1 || !c2) return 0;
  if (c1 === c2) return 1;
  if (c1.includes(c2) || c2.includes(c1)) return 0.85;

  let longer = c1.length > c2.length ? c1 : c2;
  let shorter = c1.length > c2.length ? c2 : c1;
  if (longer.length === 0) return 1.0;

  // Levenshtein
  const costs = [];
  for (let i = 0; i <= longer.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i === 0) costs[j] = j;
      else if (j > 0) {
        let newValue = costs[j - 1];
        if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[shorter.length] = lastValue;
  }
  return (longer.length - costs[shorter.length]) / parseFloat(longer.length);
}

// Find best match in list
function findBestMatch(term, list, key = 'name', threshold = 0.3) {
  if (!term || !list || list.length === 0) return null;
  let best = null;
  let bestScore = -1;

  for (const item of list) {
    const val = typeof item === 'string' ? item : item[key];
    const score = similarity(term, val);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= threshold ? { item: best, score: bestScore } : null;
}

// Advanced Godown Matcher supporting multi-word, partial, and colloquial names
function matchGodown(promptText, godownsList) {
  if (!godownsList || godownsList.length === 0) return null;
  const pLower = promptText.toLowerCase();

  // 1. Sort by length descending to match specific multi-word godown names first
  const sortedGodowns = [...godownsList].sort((a, b) => b.name.length - a.name.length);
  for (const g of sortedGodowns) {
    const gClean = g.name.toLowerCase().replace(/_/g, ' ').trim();
    // Only accept exact substring if it's not a generic word like 'main' when prompt has more specific terms
    if (gClean.length > 4 && pLower.includes(gClean)) {
      return g;
    }
  }

  // 2. Token-based scoring
  let bestGodown = null;
  let highestScore = 0;

  for (const g of godownsList) {
    const gClean = g.name.toLowerCase().replace(/_/g, ' ').trim();
    const gTokens = gClean.split(/\s+/).filter(t => t.length > 2);
    let score = 0;

    for (const t of gTokens) {
      if (pLower.includes(t)) {
        // High priority for distinctive geographic / branch terms
        if (t === 'main') score += 2;
        else if (t === 'godown' || t === 'kadai' || t === 'shop') score += 1;
        else score += 10; // e.g. 'sivakasi', 'branch', etc.
      }
    }

    const sim = similarity(pLower, gClean);
    score += sim * 3;

    if (score > highestScore && score >= 2) {
      highestScore = score;
      bestGodown = g;
    }
  }

  if (bestGodown) return bestGodown;

  // 3. Fallback to substring
  for (const g of sortedGodowns) {
    const gClean = g.name.toLowerCase().replace(/_/g, ' ').trim();
    if (pLower.includes(gClean)) return g;
  }

  // 4. Fallback to fuzzy match
  const match = findBestMatch(pLower, godownsList, 'name', 0.3);
  return match ? match.item : null;
}

// ─── AI Action Main Handler ───────────────────────────────────────────────
let lastActiveProduct = null;

exports.handleAiAction = async (req, res) => {
  const { prompt, username = 'AI Assistant' } = req.body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({
      success: false,
      message: 'Please provide a command or question for the AI.'
    });
  }

  const rawPrompt = prompt.trim();
  const lowerPrompt = rawPrompt.toLowerCase();

  try {
    // 1. Fetch live context from database
    const godownsRes = await pool.query('SELECT id, name FROM public.godown ORDER BY name');
    const godowns = godownsRes.rows;

    const brandsRes = await pool.query(`
      CREATE TABLE IF NOT EXISTS public.brand (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        agent_name VARCHAR(100)
      );
      SELECT id, name, agent_name FROM public.brand ORDER BY name;
    `);
    const brands = Array.isArray(brandsRes) ? brandsRes[1]?.rows || [] : brandsRes.rows || [];

    const typesRes = await pool.query(`
      CREATE TABLE IF NOT EXISTS public.products (product_type TEXT UNIQUE);
      DELETE FROM public.products a USING public.products b
      WHERE a.ctid < b.ctid AND LOWER(TRIM(a.product_type)) = LOWER(TRIM(b.product_type));
      SELECT DISTINCT product_type FROM public.products ORDER BY product_type;
    `);
    const productTypes = [...new Set(
      (Array.isArray(typesRes) ? typesRes[typesRes.length - 1]?.rows || [] : typesRes.rows || [])
        .map(r => r.product_type)
        .filter(Boolean)
    )];

    const stocksRes = await pool.query(`
      SELECT s.id, s.godown_id, s.productname, s.brand, s.product_type, s.current_cases, s.per_case, g.name AS godown_name
      FROM public.stock s
      JOIN public.godown g ON s.godown_id = g.id
    `);
    const allStocks = stocksRes.rows;

    // 2. Identify Intent
    const isTransfer = /\b(transfer|move|shift|send|dispatch)\b/i.test(lowerPrompt) ||
      (/\bfrom\b/i.test(lowerPrompt) && /\bto\b/i.test(lowerPrompt));

    const isEditProduct = !isTransfer &&
      /\b(edit|update|change|modify|rename|make\s+it\s+edit|set)\b/i.test(lowerPrompt) &&
      /\b(brand|price|rate|per\s*case|percase|name|type|category|product|it)\b/i.test(lowerPrompt);

    const isAddProduct = !isTransfer && !isEditProduct && (
      /\b(add\s+new\s+product|new\s+product|create\s+product|add\s+product|add\s+on\s+new\s+product)\b/i.test(lowerPrompt) ||
      /\b(product\s*name|item\s*name)\b/i.test(lowerPrompt) ||
      (/\b(brand|add\s+(?:new\s+)?brand)\b/i.test(lowerPrompt) && /\b(product\s*type|type|category|price|rate|per\s*case|percase|qty)\b/i.test(lowerPrompt))
    );

    const isAddBrandOnly = !isTransfer && !isEditProduct && !isAddProduct &&
      /\b(add\s+(?:new\s+)?brand|create\s+brand|new\s+brand)\b/i.test(lowerPrompt);

    const isAddStockOnly = !isTransfer && !isEditProduct && !isAddProduct && !isAddBrandOnly &&
      /\b(add\s+stock|inward|receive\s+stock)\b/i.test(lowerPrompt);

    const isQueryStock = !isTransfer && !isEditProduct && !isAddProduct && !isAddBrandOnly && !isAddStockOnly &&
      (/\b(show|check|view|list|tell|get|how\s+many|what\s+is|display|see|available|status|count|stocks?|report)\b/i.test(lowerPrompt) ||
       /\b(in|at|for)\b/i.test(lowerPrompt));

    // ────────────────────────────────────────────────────────────────────────
    // INTENT A: TRANSFER STOCK
    // ────────────────────────────────────────────────────────────────────────
    if (isTransfer) {
      // Extract cases number
      const casesMatch = lowerPrompt.match(/(\d+(?:\.\d+)?)\s*(?:cases?|cs|boxes?|box|pieces?|pcs)?/i);
      const cases = casesMatch ? parseFloat(casesMatch[1]) : null;

      if (!cases || isNaN(cases) || cases <= 0) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: 'Could not determine the number of cases to transfer. Please specify e.g. "transfer 10 cases of [Product] from [Godown A] to [Godown B]".'
        });
      }

      // Extract "from <godown>" and "to <godown>"
      let fromText = null;
      let toText = null;

      const fromToMatch = lowerPrompt.match(/from\s+([a-z0-9_\s-]+?)\s+to\s+([a-z0-9_\s-]+)/i);
      if (fromToMatch) {
        fromText = fromToMatch[1].trim();
        toText = fromToMatch[2].trim();
      } else {
        const toMatch = lowerPrompt.match(/to\s+([a-z0-9_\s-]+)/i);
        if (toMatch) toText = toMatch[1].trim();
        const fromMatch = lowerPrompt.match(/from\s+([a-z0-9_\s-]+)/i);
        if (fromMatch) fromText = fromMatch[1].trim();
      }

      if (!fromText || !toText) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: `Please specify both source and destination godowns (e.g. *"transfer ${cases} cases from [Godown A] to [Godown B]"*). Available godowns: ${godowns.map(g => `**${cap(g.name)}**`).join(', ')}.`
        });
      }

      const sourceGodown = matchGodown(fromText, godowns) || findBestMatch(fromText, godowns, 'name', 0.3)?.item;
      const targetGodown = matchGodown(toText, godowns) || findBestMatch(toText, godowns, 'name', 0.3)?.item;

      if (!sourceGodown) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: `Source godown matching "${fromText}" was not found. Available godowns: ${godowns.map(g => `**${cap(g.name)}**`).join(', ')}.`
        });
      }
      if (!targetGodown) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: `Target godown matching "${toText}" was not found. Available godowns: ${godowns.map(g => `**${cap(g.name)}**`).join(', ')}.`
        });
      }

      if (Number(sourceGodown.id) === Number(targetGodown.id)) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: `Source and destination godowns cannot be the same (${cap(sourceGodown.name)}).`
        });
      }

      // Find products in source godown directly from database
      const sourceStocksRes = await pool.query(
        `SELECT s.id, s.godown_id, s.productname, s.brand, s.product_type, s.current_cases, s.per_case, s.taken_cases
         FROM public.stock s
         WHERE s.godown_id = $1 AND COALESCE(s.current_cases, 0) > 0`,
        [sourceGodown.id]
      );
      const sourceStocks = sourceStocksRes.rows;

      if (sourceStocks.length === 0) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: `Source godown **${cap(sourceGodown.name)}** currently has 0 available stock.`
        });
      }

      // Match product name from prompt
      // Strip out words like "transfer", "cases", "from", "to", godown names
      let cleanedForProduct = lowerPrompt
        .replace(/\b(transfer|move|shift|send|dispatch|the|cases?|cs|boxes?|box|piece|pcs|from|to|godown)\b/gi, ' ')
        .replace(new RegExp(fromText, 'gi'), ' ')
        .replace(new RegExp(toText, 'gi'), ' ')
        .replace(/\d+(\.\d+)?/g, ' ')
        .trim();

      let matchedStock = null;
      if (cleanedForProduct.length > 1) {
        let bestScore = 0;
        for (const s of sourceStocks) {
          const score1 = similarity(cleanedForProduct, s.productname);
          const score2 = similarity(cleanedForProduct, `${s.productname} ${s.brand}`);
          const score3 = similarity(cleanedForProduct, `${s.productname} (${s.brand})`);
          const maxScore = Math.max(score1, score2, score3);
          if (maxScore > bestScore && maxScore >= 0.3) {
            bestScore = maxScore;
            matchedStock = s;
          }
        }
      }

      // Fallback: if only 1 stock item in source godown, use it
      if (!matchedStock && sourceStocks.length === 1) {
        matchedStock = sourceStocks[0];
      }

      if (!matchedStock) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: `Could not identify which product to transfer from **${cap(sourceGodown.name)}**. Available in this godown:\n` +
            sourceStocks.map(s => `• **${s.productname}** (${s.current_cases} cs available)`).join('\n')
        });
      }

      // Check current cases
      const sourceAvailable = parseFloat(matchedStock.current_cases || 0);
      if (cases > sourceAvailable) {
        return res.json({
          success: false,
          action: 'TRANSFER_FAILED',
          message: `Insufficient stock of **${matchedStock.productname}** in **${cap(sourceGodown.name)}**. Available: **${sourceAvailable} cs**, requested: **${cases} cs**.`
        });
      }

      // Execute Transfer in a Transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Deduct from source
        const newSourceCases = sourceAvailable - cases;
        const newSourceTaken = parseFloat(matchedStock.taken_cases || 0) + cases;
        await client.query(
          `UPDATE public.stock 
           SET current_cases = $1, taken_cases = $2, last_taken_date = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [newSourceCases, newSourceTaken, matchedStock.id]
        );

        const perCaseTotal = Math.round(cases * (matchedStock.per_case || 1));

        // Source history
        await client.query(
          `INSERT INTO public.stock_history 
           (stock_id, action, cases, per_case_total, added_by, taken_by, customer_name, date)
           VALUES ($1, 'taken', $2, $3, $4, $4, $5, CURRENT_TIMESTAMP)`,
          [
            matchedStock.id,
            cases,
            perCaseTotal,
            username,
            `TRANSFERRED TO ${targetGodown.name.replace(/_/g, ' ').toUpperCase()}`
          ]
        );

        // Target stock check
        const targetStockRes = await client.query(
          `SELECT id, current_cases FROM public.stock 
           WHERE godown_id = $1 AND LOWER(TRIM(productname)) = LOWER(TRIM($2)) AND LOWER(TRIM(brand)) = LOWER(TRIM($3))`,
          [targetGodown.id, matchedStock.productname, matchedStock.brand]
        );

        let targetStockId;
        let newTargetCases = cases;

        if (targetStockRes.rows.length > 0) {
          targetStockId = targetStockRes.rows[0].id;
          newTargetCases = parseFloat(targetStockRes.rows[0].current_cases || 0) + cases;
          await client.query(
            `UPDATE public.stock 
             SET current_cases = $1, date_added = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [newTargetCases, targetStockId]
          );
        } else {
          const insertRes = await client.query(
            `INSERT INTO public.stock 
             (godown_id, product_type, productname, brand, current_cases, per_case, date_added)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
             RETURNING id`,
            [
              targetGodown.id,
              matchedStock.product_type || 'General',
              matchedStock.productname,
              matchedStock.brand,
              cases,
              matchedStock.per_case || 1
            ]
          );
          targetStockId = insertRes.rows[0].id;
        }

        // Target history
        await client.query(
          `INSERT INTO public.stock_history 
           (stock_id, action, cases, per_case_total, added_by, customer_name, is_billed, date)
           VALUES ($1, 'added', $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP)`,
          [
            targetStockId,
            cases,
            perCaseTotal,
            username,
            `TRANSFERRED FROM ${sourceGodown.name.replace(/_/g, ' ').toUpperCase()}`
          ]
        );

        // Create challan
        await client.query(`
          CREATE TABLE IF NOT EXISTS public.godown_transfer_challans (
            id SERIAL PRIMARY KEY,
            challan_number TEXT UNIQUE,
            transfer_date DATE DEFAULT CURRENT_DATE,
            source_godown_id INTEGER,
            target_godown_id INTEGER,
            source_godown_name TEXT,
            target_godown_name TEXT,
            product_details JSONB DEFAULT '[]',
            transport_name TEXT,
            lr_number TEXT,
            delivery_person TEXT,
            performed_by TEXT,
            from_place TEXT,
            to_place TEXT,
            created_at TIMESTAMP DEFAULT NOW()
          );
          CREATE SEQUENCE IF NOT EXISTS challan_sequence START 1;
        `);

        const seqRes = await client.query(`SELECT nextval('challan_sequence') AS seq`);
        const challanNumber = `CHN-${String(seqRes.rows[0].seq).padStart(4, '0')}`;

        const productDetails = [{
          productname: matchedStock.productname,
          brand: matchedStock.brand,
          product_type: matchedStock.product_type,
          cases: cases,
          per_case: matchedStock.per_case,
          total_pieces: perCaseTotal
        }];

        await client.query(
          `INSERT INTO public.godown_transfer_challans
           (challan_number, transfer_date, source_godown_id, target_godown_id, source_godown_name,
            target_godown_name, product_details, performed_by, from_place, to_place)
           VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            challanNumber,
            sourceGodown.id,
            targetGodown.id,
            sourceGodown.name,
            targetGodown.name,
            JSON.stringify(productDetails),
            username,
            sourceGodown.name.replace(/_/g, ' ').toUpperCase(),
            targetGodown.name.replace(/_/g, ' ').toUpperCase()
          ]
        );

        await client.query('COMMIT');

        lastActiveProduct = {
          productname: matchedStock.productname,
          brand: cap(matchedStock.brand),
          type: cap(matchedStock.product_type || 'General'),
          price: matchedStock.price || 0,
          per_case: matchedStock.per_case || 1
        };

        return res.json({
          success: true,
          action: 'TRANSFER_COMPLETED',
          message: `✅ **Successfully transferred ${cases} cases of ${matchedStock.productname}** from **${cap(sourceGodown.name)}** to **${cap(targetGodown.name)}**!`,
          details: {
            product: matchedStock.productname,
            brand: matchedStock.brand,
            cases: cases,
            source_godown: cap(sourceGodown.name),
            source_remaining: newSourceCases,
            target_godown: cap(targetGodown.name),
            target_new_total: newTargetCases,
            challan_number: challanNumber
          }
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('AI Transfer error:', err);
        return res.status(500).json({
          success: false,
          action: 'TRANSFER_ERROR',
          message: `Transfer failed: ${err.message}`
        });
      } finally {
        client.release();
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTENT B: ADD NEW PRODUCT (AND OPTIONALLY ALLOCATE TO GODOWN)
    // ────────────────────────────────────────────────────────────────────────
    if (isAddProduct) {
      // 1. Extract brand:
      // Examples: "add new brand called gk", "brand called gk", "brand - gk", "brand: Sony", "brand Standard"
      let brandName = 'General';
      const brandMatch = 
        rawPrompt.match(/(?:(?:add\s+new\s+)?brand\s+(?:called|name|is)\s+|brand\s*[-:=]\s*|on\s+brand\s+|for\s+brand\s+|\bbrand\s+)([a-zA-Z0-9_\s-]+?)(?=,\s*|\s+(?:product|type|category|price|rate|per|qty|godown|cases|stock)|\s*$)/i);
      if (brandMatch && brandMatch[1].trim()) {
        brandName = brandMatch[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim();
      }

      // 2. Extract product type:
      // Examples: "product type - bijili", "product type: bijili", "type - bijili", "category: crackers"
      let productType = productTypes[0] || 'crackers';
      const typeMatch = 
        rawPrompt.match(/(?:product\s*type|type|category)\s*[-:=]?\s*([a-zA-Z0-9_\s-]+?)(?=,\s*|\s+(?:brand|product\s*name|item\s*name|\bname\b|price|rate|per|qty|godown|cases|stock)|\s*$)/i);
      if (typeMatch && typeMatch[1].trim()) {
        productType = typeMatch[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim().toLowerCase();
      }

      // 3. Extract price:
      // Examples: "price -30", "price: 30", "price - 30", "rate: 45", "rs 100", "cost 50"
      let price = 100;
      const priceMatch = rawPrompt.match(/(?:price|rate|rs\.?|cost)\s*[-:=]?\s*(\d+(?:\.\d+)?)/i);
      if (priceMatch) {
        price = parseFloat(priceMatch[1]);
      }

      // 4. Extract per_case:
      // Examples: "percase-100 qty", "percase - 100", "per case: 50", "per box - 20"
      let perCase = 1;
      const perCaseMatch = rawPrompt.match(/(?:per\s*case|percase|per\s*box|perbox)\s*[-:=]?\s*(\d+)/i);
      if (perCaseMatch) {
        perCase = parseInt(perCaseMatch[1]);
      }

      // 5. Extract cases to add:
      let casesToAdd = 0;
      const casesMatch = 
        rawPrompt.match(/(?<!per\s*)\b(?:cases?|stock)\s*[-:=]\s*(\d+(?:\.\d+)?)/i) ||
        rawPrompt.match(/(?:add|with)\s+(\d+(?:\.\d+)?)\s*(?:cases?|cs|boxes?|box)?(?:\s+(?:to|in)\b)/i) ||
        rawPrompt.match(/(?<!per\s*)(\d+(?:\.\d+)?)\s*(?:cases?|cs|boxes?|box)\b/i);
      if (casesMatch) {
        casesToAdd = parseFloat(casesMatch[1]);
      }

      // 6. Extract target godown:
      let targetGodown = null;
      const godownMatch = 
        rawPrompt.match(/(?:to\s+godown|in\s+godown|into\s+godown|godown\s*[-:=]|godown)\s*([a-zA-Z0-9_\s-]+?)(?=,\s*|\s+(?:cases?|stock|price|percase)|\s*$)/i) ||
        rawPrompt.match(/(?:to|in|into)\s+([a-zA-Z0-9_\s-]+?)(?:\s+godown)?(?:$|\.|\,)/i);
      if (godownMatch) {
        const candidate = godownMatch[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim();
        targetGodown = matchGodown(candidate, godowns) || findBestMatch(candidate, godowns, 'name', 0.3)?.item;
      }
      if (!targetGodown && casesToAdd > 0 && godowns.length > 0) {
        for (const g of godowns) {
          if (lowerPrompt.includes(g.name.toLowerCase().replace(/_/g, ' '))) {
            targetGodown = g;
            break;
          }
        }
      }

      // 7. Extract product name:
      // Try explicit pattern first: "product name - vari 100 bijili" or "item name: 5000 wala" or "name - ..."
      let productName = '';
      const nameMatch = 
        rawPrompt.match(/(?:product\s*name|item\s*name|\bname\b)\s*[-:=]?\s*([^,;]+?)(?=,\s*|\s+(?:brand|product\s*type|type|category|price|rate|per\s*case|percase|per\s*box|perbox|qty|godown|cases|stock)|\s*$)/i);
      if (nameMatch && nameMatch[1].trim()) {
        productName = nameMatch[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim();
      } else {
        // Fallback: strip matched/known parts and use remainder
        let cleanedName = rawPrompt
          .replace(/add\s+new\s+product/i, '')
          .replace(/add\s+product/i, '')
          .replace(/new\s+product/i, '')
          .replace(/create\s+product/i, '')
          .replace(/add\s+on\s+new\s+product/i, '')
          .replace(/(?:(?:add\s+new\s+)?brand\s+(?:called|name|is)\s+|brand\s*[-:=]\s*|on\s+brand\s+|for\s+brand\s+|\bbrand\s+)[a-zA-Z0-9_\s-]+?(?=,\s*|\s+(?:product|type|category|price|rate|per|qty|godown|cases|stock)|\s*$)/gi, '')
          .replace(/(?:product\s*type|type|category)\s*[-:=]?\s*[a-zA-Z0-9_\s-]+?(?=,\s*|\s+(?:brand|product\s*name|item\s*name|name|price|rate|per|qty|godown|cases|stock)|\s*$)/gi, '')
          .replace(/(?:price|rate|rs\.?|cost)\s*[-:=]?\s*\d+(\.\d+)?/gi, '')
          .replace(/(?:per\s*case|percase|per\s*box|perbox)\s*[-:=]?\s*\d+\s*(?:qty|pcs|pieces)?/gi, '')
          .replace(/(?<!per\s*)\b(?:cases?|stock)\s*[-:=]\s*\d+(\.\d+)?/gi, '')
          .replace(/(?:and\s+)?add\s+\d+(\.\d+)?\s*(?:cases?|cs)?(?:\s+(?:to|in)\s+[a-zA-Z0-9_\s-]+)?/gi, '')
          .replace(/(?:to|in|into|godown)\s*[-:=]?\s*(?:godown\s+)?[a-zA-Z0-9_\s-]+(?:\s+godown)?/gi, '')
          .replace(/[,\.;]/g, '')
          .trim();
        if (cleanedName && cleanedName.length >= 2) {
          productName = cleanedName.replace(/^[-:=]+|[-:=]+$/g, '').trim();
        }
      }

      if (!productName || productName.length < 2) {
        productName = 'New Item ' + Math.floor(100 + Math.random() * 900);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1. Ensure brand exists
        const formattedBrand = brandName.toLowerCase().replace(/\s+/g, '_');
        let brandCheck = await client.query('SELECT id FROM public.brand WHERE name = $1', [formattedBrand]);
        let brandId;
        if (brandCheck.rows.length === 0) {
          const insB = await client.query('INSERT INTO public.brand (name) VALUES ($1) RETURNING id', [formattedBrand]);
          brandId = insB.rows[0].id;
        } else {
          brandId = brandCheck.rows[0].id;
        }

        // 2. Ensure product type exists & table exists
        const formattedType = productType.toLowerCase().replace(/\s+/g, '_');
        const typeCheck = await client.query('SELECT product_type FROM public.products WHERE product_type = $1', [formattedType]);
        if (typeCheck.rows.length === 0) {
          await client.query('INSERT INTO public.products (product_type) VALUES ($1)', [formattedType]);
        }

        await client.query(`
          CREATE TABLE IF NOT EXISTS public."${formattedType}" (
            id BIGSERIAL PRIMARY KEY,
            productname TEXT NOT NULL,
            price NUMERIC(10,2) NOT NULL,
            per_case INTEGER NOT NULL,
            brand TEXT NOT NULL
          )
        `);

        // Check if product exists in type table
        const prodCheck = await client.query(
          `SELECT id FROM public."${formattedType}" WHERE LOWER(productname) = LOWER($1) AND LOWER(brand) = LOWER($2)`,
          [productName, formattedBrand]
        );

        if (prodCheck.rows.length === 0) {
          await client.query(
            `INSERT INTO public."${formattedType}" (productname, price, per_case, brand) VALUES ($1, $2, $3, $4)`,
            [productName, price, perCase, formattedBrand]
          );
        } else {
          await client.query(
            `UPDATE public."${formattedType}" SET price = $1, per_case = $2 WHERE id = $3`,
            [price, perCase, prodCheck.rows[0].id]
          );
        }
        if (invalidateProductsCache) invalidateProductsCache();

        // 3. If cases and target godown specified, add stock directly to godown!
        let stockAddedMsg = '';
        if (casesToAdd > 0 && targetGodown) {
          // Check if stock exists in godown
          const stockCheck = await client.query(
            'SELECT id, current_cases FROM public.stock WHERE godown_id = $1 AND LOWER(productname) = LOWER($2) AND LOWER(brand) = LOWER($3)',
            [targetGodown.id, productName, formattedBrand]
          );

          let stockId;
          let newTotal = casesToAdd;

          if (stockCheck.rows.length > 0) {
            stockId = stockCheck.rows[0].id;
            newTotal = parseFloat(stockCheck.rows[0].current_cases || 0) + casesToAdd;
            await client.query(
              'UPDATE public.stock SET current_cases = $1, date_added = CURRENT_TIMESTAMP, brand_id = $2 WHERE id = $3',
              [newTotal, brandId, stockId]
            );
          } else {
            const insStock = await client.query(
              `INSERT INTO public.stock 
               (godown_id, product_type, productname, brand, brand_id, current_cases, per_case, date_added)
               VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
               RETURNING id`,
              [targetGodown.id, formattedType, productName, formattedBrand, brandId, casesToAdd, perCase]
            );
            stockId = insStock.rows[0].id;
          }

          // History record
          const perCaseTotal = Math.round(casesToAdd * perCase);
          await client.query(
            `INSERT INTO public.stock_history 
             (stock_id, action, cases, per_case_total, customer_name, is_billed)
             VALUES ($1, 'added', $2, $3, $4, FALSE)`,
            [stockId, casesToAdd, perCaseTotal, 'DIRECT GODOWN INWARD']
          );

          stockAddedMsg = ` and added **${casesToAdd} cases** to **${cap(targetGodown.name)}**`;
        }

        await client.query('COMMIT');

        lastActiveProduct = {
          productname: productName,
          brand: cap(brandName),
          type: cap(formattedType),
          price: price,
          per_case: perCase
        };

        const tipMsg = (casesToAdd === 0 || !targetGodown)
          ? `\n\n💡 *Tip: To add stock to a godown, you can now say: "Add 10 cases of ${productName} to Main Godown"*`
          : '';

        return res.json({
          success: true,
          action: 'PRODUCT_CREATED',
          message: `✅ Created product **${productName}** under brand **${cap(brandName)}** (${cap(formattedType)})${stockAddedMsg}!\n` +
            `• **Product:** ${productName}\n` +
            `• **Brand:** ${cap(brandName)}\n` +
            `• **Category/Type:** ${cap(formattedType)}\n` +
            `• **Price:** ₹${price}\n` +
            `• **Per Case Qty:** ${perCase} pcs` +
            (targetGodown && casesToAdd > 0 ? `\n• **Allocated:** ${casesToAdd} cs in ${cap(targetGodown.name)}` : '') +
            tipMsg,
          details: {
            productname: productName,
            brand: cap(brandName),
            type: cap(formattedType),
            price: price,
            per_case: perCase,
            godown: targetGodown ? cap(targetGodown.name) : 'None',
            cases_added: casesToAdd
          }
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('AI Add Product error:', err);
        return res.status(500).json({
          success: false,
          action: 'ADD_PRODUCT_ERROR',
          message: `Failed to create product: ${err.message}`
        });
      } finally {
        client.release();
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTENT B.2: ADD BRAND ONLY
    // ────────────────────────────────────────────────────────────────────────
    if (isAddBrandOnly) {
      let brandName = 'General';
      const brandMatch = 
        rawPrompt.match(/(?:(?:add\s+new\s+)?brand\s+(?:called|name|is)\s+|brand\s*[-:=]\s*|on\s+brand\s+|for\s+brand\s+|\bbrand\s+)([a-zA-Z0-9_\s-]+?)(?=,\s*|\s+(?:product|type|category|price|rate|per|qty|godown|cases|stock)|\s*$)/i);
      if (brandMatch && brandMatch[1].trim()) {
        brandName = brandMatch[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim();
      }

      const formattedBrand = brandName.toLowerCase().replace(/\s+/g, '_');
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS public.brand (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR NOT NULL UNIQUE,
            agent_name TEXT
          )
        `);

        const dup = await client.query('SELECT id, name FROM public.brand WHERE name = $1', [formattedBrand]);
        if (dup.rows.length > 0) {
          return res.json({
            success: true,
            action: 'BRAND_EXISTS',
            message: `Brand **${cap(brandName)}** already exists in the system.`,
            details: { brand: cap(brandName) }
          });
        }

        const ins = await client.query(
          'INSERT INTO public.brand (name) VALUES ($1) RETURNING id, name',
          [formattedBrand]
        );

        return res.json({
          success: true,
          action: 'BRAND_CREATED',
          message: `✅ Created new brand **${cap(brandName)}** successfully! You can now add products under this brand.\n\n` +
            `*Example: "add new product name - vari 100 bijili, brand - ${cap(brandName)}, type - bijili, price - 30, percase - 100"*\n`,
          details: { brand_id: ins.rows[0].id, brand: cap(brandName) }
        });
      } catch (err) {
        console.error('AI Add Brand error:', err);
        return res.status(500).json({
          success: false,
          action: 'ADD_BRAND_ERROR',
          message: `Failed to create brand: ${err.message}`
        });
      } finally {
        client.release();
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTENT B.3: EDIT / UPDATE PRODUCT (Brand, Name, Price, Per Case, Type)
    // ────────────────────────────────────────────────────────────────────────
    if (isEditProduct) {
      // 1. Extract fields to change:
      let newBrand = null;
      const brandM1 = rawPrompt.match(/(?:to\s+brand\s+|brand\s*(?:to|as|is|=|-|:)\s*)([a-zA-Z0-9_\s-]+?)(?=,\s*|\s+(?:and\s+|price|rate|per|qty|name|product)|\s*$)/i);
      if (brandM1) {
        newBrand = brandM1[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').replace(/\b(?:and)\b/i, '').trim();
      } else {
        const brandM2 = rawPrompt.match(/brand\s+of\s+.*?to\s+([a-zA-Z0-9_\s-]+?)(?=,\s*|\s+(?:and\s+|price|rate|per|qty|name|product)|\s*$)/i);
        if (brandM2) {
          newBrand = brandM2[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').replace(/\b(?:and)\b/i, '').trim();
        } else if (/\bbrand\b/i.test(rawPrompt)) {
          const brandM3 = rawPrompt.match(/to\s+([a-zA-Z0-9_-]+)/i);
          if (brandM3 && !['brand', 'product', 'price', 'name', 'type', 'category'].includes(brandM3[1].toLowerCase())) {
            newBrand = brandM3[1].trim();
          }
        }
      }

      let newName = null;
      const nameM = rawPrompt.match(/(?:(?:rename\s+product|change\s+name|rename|edit\s+name)\s+(?:of\s+.*?\s+)?to\s+|name\s*(?:to|as|is|=|-|:)\s*)([^,;]+?)(?=,\s*|\s+(?:brand|price|rate|per|qty)|\s*$)/i);
      if (nameM) {
        newName = nameM[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim();
      }
      if (!newName) {
        const prodCardM = rawPrompt.match(/Product\s*[:=]?\s*([^,\n;]+?)(?=\s+(?:Brand|Category|Price|Rate|\(|$))/i);
        if (prodCardM) {
          newName = prodCardM[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim();
        }
      }

      let newPrice = null;
      const priceM = rawPrompt.match(/(?:Price\s*(?:\/\s*Box)?\s*[:=]?\s*[₹$]?\s*|(?:change|edit|update|set)?\s*(?:price|rate)\s*(?:of\s+.*?\s+)?(?:to|as|is|=|-|:)\s*|\bprice\s+)(\d+(?:\.\d+)?)/i);
      if (priceM) {
        newPrice = parseFloat(priceM[1]);
      }

      let newPerCase = null;
      const perCaseM = rawPrompt.match(/(?:\((\d+)\s*(?:pcs\/cs|pcs|pieces)\)|Quantity\s*\/\s*case\s*[:=]?\s*(\d+)|(?:change|edit|update|set)?\s*(?:per\s*case|percase|per\s*box|perbox)\s*(?:of\s+.*?\s+)?(?:to|as|is|=|-|:)\s*|\bpercase\s+(\d+))/i);
      if (perCaseM) {
        newPerCase = parseInt(perCaseM[1] || perCaseM[2] || perCaseM[3]);
      }

      let newType = null;
      const typeM = rawPrompt.match(/(?:to\s+(?:product\s+)?type\s+|to\s+category\s+|(?:product\s+)?type\s*(?:to|as|is|=|-|:)\s*|category\s*(?:to|as|is|=|-|:)\s*)([a-zA-Z0-9_\s-]+?)(?=,\s*|\s+(?:and\s+|brand|price|rate|per|qty|name)|\s*$)/i);
      if (typeM) {
        newType = typeM[1].replace(/\badd\s*new\b/gi, '').trim().replace(/^[-:=]+|[-:=]+$/g, '').trim().toLowerCase().replace(/\s+/g, '_');
        if (!newType) newType = null;
      }

      // 2. Identify target product:
      let productTarget = null;
      const targetM = rawPrompt.match(/(?:product|item)\s+([a-zA-Z0-9_\s-]+?)(?=\s+(?:brand|to|price|per|name|is|=|-|:)|$)/i) ||
                      rawPrompt.match(/of\s+([a-zA-Z0-9_\s-]+?)(?=\s+to\b|\s*$)/i);
      if (targetM) {
        const candidate = targetM[1].trim().replace(/^[-:=]+|[-:=]+$/g, '').trim();
        if (!['it', 'this', 'brand', 'price', 'name', 'type', 'category'].includes(candidate.toLowerCase())) {
          productTarget = candidate;
        }
      }

      // Collect all products across tables
      const allProducts = [];
      for (const pType of productTypes) {
        const tbl = pType.toLowerCase().replace(/\s+/g, '_');
        try {
          const pRes = await pool.query(`SELECT id, productname, price, per_case, brand, '${tbl}' AS product_type FROM public."${tbl}" ORDER BY id DESC`);
          allProducts.push(...pRes.rows);
        } catch (e) {
          // Table doesn't exist
        }
      }

      // Also fetch any stock entries
      const clientContext = req.body.lastProduct || lastActiveProduct;

      let matchedProduct = null;
      if (productTarget) {
        matchedProduct = findBestMatch(productTarget, allProducts, 'productname', 0.35)?.item;
        if (!matchedProduct && allStocks.length > 0) {
          const matchedStock = findBestMatch(productTarget, allStocks, 'productname', 0.35)?.item;
          if (matchedStock) {
            matchedProduct = {
              id: matchedStock.id,
              productname: matchedStock.productname,
              brand: matchedStock.brand,
              product_type: matchedStock.product_type,
              price: matchedStock.price || 0,
              per_case: matchedStock.per_case || 1,
              is_stock_only: true
            };
          }
        }
      }

      if (!matchedProduct && clientContext?.productname) {
        matchedProduct = allProducts.find(p => 
          p.productname.toLowerCase() === clientContext.productname.toLowerCase()
        );
        if (!matchedProduct && allStocks.length > 0) {
          const matchedStock = allStocks.find(s => s.productname.toLowerCase() === clientContext.productname.toLowerCase());
          if (matchedStock) {
            matchedProduct = {
              id: matchedStock.id,
              productname: matchedStock.productname,
              brand: matchedStock.brand,
              product_type: matchedStock.product_type,
              price: matchedStock.price || 0,
              per_case: matchedStock.per_case || 1,
              is_stock_only: true
            };
          }
        }
      }

      if (!matchedProduct && allProducts.length > 0) {
        // Fallback: Pick the most recently added product
        matchedProduct = allProducts[0];
      }

      if (!matchedProduct && allStocks.length > 0) {
        matchedProduct = allStocks[0];
      }

      if (!matchedProduct) {
        return res.json({
          success: false,
          action: 'EDIT_PRODUCT_FAILED',
          message: 'Could not find which product to edit. Please specify the product name (e.g. *"edit product vari 100 brand to GK"*).'
        });
      }

      // 3. Perform update in database:
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        let finalBrand = matchedProduct.brand;
        let brandId = null;

        if (newBrand) {
          const formattedNewBrand = newBrand.toLowerCase().replace(/\s+/g, '_');
          finalBrand = formattedNewBrand;
          const bCheck = await client.query('SELECT id FROM public.brand WHERE name = $1', [formattedNewBrand]);
          if (bCheck.rows.length === 0) {
            const insB = await client.query('INSERT INTO public.brand (name) VALUES ($1) RETURNING id', [formattedNewBrand]);
            brandId = insB.rows[0].id;
          } else {
            brandId = bCheck.rows[0].id;
          }
        }

        // Auto-sanitize if product in database has accidental prompt string
        let isUglyName = matchedProduct.productname.includes('product name -') || matchedProduct.productname.startsWith('add new');
        if (isUglyName) {
          const cleanM = matchedProduct.productname.match(/product\s*name\s*[-:=]\s*([^,;]+?)(?=\s+(?:price|percase|rate|per|qty)|$)/i);
          if (cleanM && !newName) newName = cleanM[1].trim();

          const autoPM = matchedProduct.productname.match(/(?:price|rate)\s*[-:=]?\s*(\d+(?:\.\d+)?)/i);
          if (autoPM && newPrice == null) newPrice = parseFloat(autoPM[1]);

          const autoCM = matchedProduct.productname.match(/(?:per\s*case|percase|per\s*box|perbox)\s*[-:=]?\s*(\d+)/i);
          if (autoCM && newPerCase == null) newPerCase = parseInt(autoCM[1]);
        }

        const finalName = newName || matchedProduct.productname;
        const finalPrice = newPrice != null ? newPrice : parseFloat(matchedProduct.price || 0);
        const finalPerCase = newPerCase != null ? newPerCase : parseInt(matchedProduct.per_case || 1);

        // Clean category if it was something like 'bijili_add_new'
        let cleanedType = (matchedProduct.product_type || 'General').replace(/_add_new$/i, '').replace(/\badd_new\b/gi, '').trim();
        if (!cleanedType) cleanedType = 'General';
        const finalType = newType ? newType.toLowerCase().replace(/\s+/g, '_') : cleanedType;

        // Update product table if exists
        if (!matchedProduct.is_stock_only && matchedProduct.product_type) {
          if (finalType !== matchedProduct.product_type) {
            await client.query(`
              CREATE TABLE IF NOT EXISTS public."${finalType}" (
                id BIGSERIAL PRIMARY KEY,
                productname TEXT NOT NULL,
                price NUMERIC(10,2) NOT NULL,
                per_case INTEGER NOT NULL,
                brand TEXT NOT NULL
              )
            `);
            await client.query(
              'INSERT INTO public.products (product_type) VALUES ($1) ON CONFLICT DO NOTHING',
              [finalType]
            );
            await client.query(
              `INSERT INTO public."${finalType}" (productname, price, per_case, brand) VALUES ($1, $2, $3, $4)`,
              [finalName, finalPrice, finalPerCase, finalBrand]
            );
            await client.query(`DELETE FROM public."${matchedProduct.product_type}" WHERE id = $1`, [matchedProduct.id]);
            // If old table was an accidental table (ends with _add_new), drop it and remove from public.products
            if (matchedProduct.product_type.endsWith('_add_new')) {
              try {
                await client.query(`DROP TABLE IF EXISTS public."${matchedProduct.product_type}"`);
                await client.query('DELETE FROM public.products WHERE product_type = $1', [matchedProduct.product_type]);
              } catch (e) {
                // Ignore drop error
              }
            }
          } else {
            await client.query(
              `UPDATE public."${matchedProduct.product_type}"
               SET productname = $1, brand = $2, price = $3, per_case = $4
               WHERE id = $5`,
              [finalName, finalBrand, finalPrice, finalPerCase, matchedProduct.id]
            );
          }
          if (invalidateProductsCache) invalidateProductsCache();
        }

        // Update stock records if any
        if (brandId) {
          await client.query(
            `UPDATE public.stock 
             SET brand = $1, brand_id = $2, productname = $3, per_case = $4, product_type = $5
             WHERE LOWER(productname) = LOWER($6)`,
            [finalBrand, brandId, finalName, finalPerCase, finalType, matchedProduct.productname]
          );
        } else {
          await client.query(
            `UPDATE public.stock 
             SET productname = $1, per_case = $2, product_type = $3
             WHERE LOWER(productname) = LOWER($4)`,
            [finalName, finalPerCase, finalType, matchedProduct.productname]
          );
        }

        await client.query('COMMIT');

        lastActiveProduct = {
          productname: finalName,
          brand: cap(finalBrand),
          type: cap(finalType),
          price: finalPrice,
          per_case: finalPerCase
        };

        const changes = [];
        if (newBrand) changes.push(`brand to **${cap(newBrand)}**`);
        if (newName) changes.push(`name to **${finalName}**`);
        if (newPrice != null) changes.push(`price to **₹${finalPrice}**`);
        if (newPerCase != null) changes.push(`per case to **${finalPerCase} pcs**`);
        if (newType) changes.push(`category to **${cap(finalType)}**`);

        return res.json({
          success: true,
          action: 'PRODUCT_UPDATED',
          message: `✅ Successfully updated **${matchedProduct.productname}** (${changes.join(', ')})!\n\n` +
            `• **Product:** ${finalName}\n` +
            `• **Brand:** ${cap(finalBrand)}\n` +
            `• **Category/Type:** ${cap(finalType)}\n` +
            `• **Price:** ₹${finalPrice}\n` +
            `• **Per Case Qty:** ${finalPerCase} pcs`,
          details: {
            productname: finalName,
            brand: cap(finalBrand),
            type: cap(finalType),
            price: finalPrice,
            per_case: finalPerCase
          }
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('AI Edit Product error:', err);
        return res.status(500).json({
          success: false,
          action: 'EDIT_PRODUCT_ERROR',
          message: `Failed to edit product: ${err.message}`
        });
      } finally {
        client.release();
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTENT C: ADD STOCK TO GODOWN FOR EXISTING PRODUCT
    // ────────────────────────────────────────────────────────────────────────
    if (isAddStockOnly) {
      const casesMatch = lowerPrompt.match(/(\d+(?:\.\d+)?)\s*(?:cases?|cs|boxes?|box)?/i);
      const cases = casesMatch ? parseFloat(casesMatch[1]) : null;

      if (!cases || isNaN(cases) || cases <= 0) {
        return res.json({
          success: false,
          action: 'ADD_STOCK_FAILED',
          message: 'Please specify the number of cases to add (e.g., *"add 20 cases of [Product] to [Godown]"*).'
        });
      }

      // Find target godown
      let targetGodown = null;
      for (const g of godowns) {
        if (lowerPrompt.includes(g.name.toLowerCase().replace(/_/g, ' '))) {
          targetGodown = g;
          break;
        }
      }
      if (!targetGodown) {
        const toMatch = lowerPrompt.match(/(?:to|in|into)\s+([a-zA-Z0-9_\s-]+)/i);
        if (toMatch) {
          const match = findBestMatch(toMatch[1].trim(), godowns, 'name', 0.4);
          if (match) targetGodown = match.item;
        }
      }

      if (!targetGodown) {
        return res.json({
          success: false,
          action: 'ADD_STOCK_FAILED',
          message: `Please specify the godown to add stock to. Available godowns: ${godowns.map(g => `**${cap(g.name)}**`).join(', ')}.`
        });
      }

      // Match product
      let cleaned = lowerPrompt
        .replace(/\b(add|stock|cases?|cs|boxes?|box|to|in|into|godown)\b/gi, ' ')
        .replace(new RegExp(targetGodown.name, 'gi'), ' ')
        .replace(/\d+(\.\d+)?/g, ' ')
        .trim();

      // Fetch stocks for target godown directly
      const godownStocksRes = await pool.query(
        `SELECT s.id, s.godown_id, s.productname, s.brand, s.product_type, s.current_cases, s.per_case
         FROM public.stock s
         WHERE s.godown_id = $1`,
        [targetGodown.id]
      );
      const godownStocks = godownStocksRes.rows;
      let matchedStock = findBestMatch(cleaned, godownStocks, 'productname', 0.35)?.item;

      if (!matchedStock && allStocks.length > 0) {
        matchedStock = findBestMatch(cleaned, allStocks, 'productname', 0.35)?.item;
      }

      if (!matchedStock) {
        return res.json({
          success: false,
          action: 'ADD_STOCK_FAILED',
          message: `Could not find an existing product matching "${cleaned}". If this is a new product, say: *"Add new product [name] to brand [brand] with ${cases} cases in ${cap(targetGodown.name)}"*`
        });
      }

      // Add stock to godown
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingStock = await client.query(
          'SELECT id, current_cases, per_case FROM public.stock WHERE godown_id = $1 AND productname = $2 AND brand = $3',
          [targetGodown.id, matchedStock.productname, matchedStock.brand]
        );

        let stockId;
        let newTotal = cases;
        const perCase = matchedStock.per_case || 1;

        if (existingStock.rows.length > 0) {
          stockId = existingStock.rows[0].id;
          newTotal = parseFloat(existingStock.rows[0].current_cases || 0) + cases;
          await client.query(
            'UPDATE public.stock SET current_cases = $1, date_added = CURRENT_TIMESTAMP WHERE id = $2',
            [newTotal, stockId]
          );
        } else {
          const ins = await client.query(
            `INSERT INTO public.stock (godown_id, product_type, productname, brand, current_cases, per_case, date_added)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) RETURNING id`,
            [targetGodown.id, matchedStock.product_type || 'General', matchedStock.productname, matchedStock.brand, cases, perCase]
          );
          stockId = ins.rows[0].id;
        }

        const perCaseTotal = Math.round(cases * perCase);
        await client.query(
          `INSERT INTO public.stock_history 
           (stock_id, action, cases, per_case_total, added_by, customer_name, is_billed, date)
           VALUES ($1, 'added', $2, $3, $4, $5, FALSE, CURRENT_TIMESTAMP)`,
          [stockId, cases, perCaseTotal, username, 'DIRECT GODOWN INWARD']
        );

        await client.query('COMMIT');

        lastActiveProduct = {
          productname: matchedStock.productname,
          brand: cap(matchedStock.brand),
          type: cap(matchedStock.product_type || 'General'),
          price: matchedStock.price || 0,
          per_case: perCase
        };

        return res.json({
          success: true,
          action: 'STOCK_ADDED',
          message: `✅ Added **${cases} cases** of **${matchedStock.productname}** to **${cap(targetGodown.name)}**! New godown total: **${newTotal} cs**.`,
          details: {
            product: matchedStock.productname,
            brand: matchedStock.brand,
            godown: cap(targetGodown.name),
            cases_added: cases,
            current_total: newTotal
          }
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('AI Add Stock error:', err);
        return res.status(500).json({
          success: false,
          action: 'ADD_STOCK_ERROR',
          message: `Failed to add stock: ${err.message}`
        });
      } finally {
        client.release();
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTENT D: QUERY STOCK / STATUS
    // ────────────────────────────────────────────────────────────────────────
    if (isQueryStock || lowerPrompt.includes('godown') || lowerPrompt.includes('product') || lowerPrompt.includes('stock')) {
      // Find if a godown was mentioned using advanced matcher
      const targetGodown = matchGodown(lowerPrompt, godowns);

      if (targetGodown) {
        // Query database directly for this godown's stocks to avoid any type mismatch
        const stocksRes = await pool.query(
          `SELECT s.id, s.godown_id, s.productname, s.brand, s.product_type, s.current_cases, s.per_case
           FROM public.stock s
           WHERE s.godown_id = $1 AND COALESCE(s.current_cases, 0) > 0
           ORDER BY s.current_cases DESC, s.productname ASC`,
          [targetGodown.id]
        );
        const stocks = stocksRes.rows;
        const totalCases = Math.round(stocks.reduce((acc, s) => acc + parseFloat(s.current_cases || 0), 0) * 100) / 100;
        const distinctCount = new Set(stocks.map(s => s.productname?.trim())).size;

        // Also fetch availability across other godowns for full visibility
        const otherGodownsRes = await pool.query(`
          SELECT g.id, g.name,
                 COALESCE(SUM(CASE WHEN s.current_cases > 0 THEN s.current_cases ELSE 0 END), 0)::NUMERIC AS total_cases,
                 COUNT(DISTINCT CASE WHEN s.current_cases > 0 THEN LOWER(TRIM(s.productname)) END) AS distinct_products
          FROM public.godown g
          LEFT JOIN public.stock s ON s.godown_id = g.id
          WHERE g.id != $1
          GROUP BY g.id, g.name
          ORDER BY total_cases DESC
        `, [targetGodown.id]);

        let otherGodownsMsg = '';
        if (otherGodownsRes.rows.length > 0) {
          otherGodownsMsg = `\n\n📌 **Other Godowns Availability:**\n` +
            otherGodownsRes.rows.map(og => `• **${cap(og.name)}**: ${og.total_cases} cs (${og.distinct_products} products)`).join('\n');
        }

        return res.json({
          success: true,
          action: 'QUERY_RESULT',
          message: `📊 **${cap(targetGodown.name)} Stock Summary**:\n` +
            `• **Total Available Cases:** ${totalCases} cs\n` +
            `• **Distinct Products in Stock:** ${distinctCount}\n\n` +
            (stocks.length > 0
              ? `**Available Products:**\n` + stocks.slice(0, 15).map(s => `• **${s.productname}** (${cap(s.brand || 'General')}): **${s.current_cases} cs**`).join('\n') +
              (stocks.length > 15 ? `\n• ...and ${stocks.length - 15} more products` : '')
              : `*No active stock in this godown.*`) +
            otherGodownsMsg,
          details: {
            godown: cap(targetGodown.name),
            total_cases: totalCases,
            distinct_products: distinctCount,
            items: stocks.map(s => ({ name: s.productname, cases: s.current_cases, brand: s.brand }))
          }
        });
      }

      // If no specific godown was matched, show ALL godowns breakdown
      const allGodownsBreakdown = await pool.query(`
        SELECT g.id, g.name,
               COALESCE(SUM(CASE WHEN s.current_cases > 0 THEN s.current_cases ELSE 0 END), 0)::NUMERIC AS total_cases,
               COUNT(DISTINCT CASE WHEN s.current_cases > 0 THEN LOWER(TRIM(s.productname)) END) AS distinct_products
        FROM public.godown g
        LEFT JOIN public.stock s ON s.godown_id = g.id
        GROUP BY g.id, g.name
        ORDER BY total_cases DESC
      `);

      const totalAllCases = allGodownsBreakdown.rows.reduce((acc, r) => acc + parseFloat(r.total_cases || 0), 0);
      const totalDistinct = allGodownsBreakdown.rows.reduce((acc, r) => acc + parseInt(r.distinct_products || 0), 0);

      return res.json({
        success: true,
        action: 'QUERY_RESULT',
        message: `📊 **ERP Godowns Stock Breakdown**:\n\n` +
          allGodownsBreakdown.rows.map(g => `• 🏢 **${cap(g.name)}**: **${g.total_cases} cs** (${g.distinct_products} products)`).join('\n') +
          `\n\n• **Overall Total:** ${totalAllCases} cases across ${godowns.length} godowns.\n\n` +
          `You can tell me:\n` +
          `• *"Transfer 10 cases of [Product] from [Godown A] to [Godown B]"*\n` +
          `• *"Add new product [Name] on brand [Brand] with 20 cases in [Godown]"*\n` +
          `• *"Add 15 cases of [Product] to [Godown]"*`,
        details: {
          total_cases: totalAllCases,
          total_distinct_products: totalDistinct,
          godowns_count: godowns.length,
          godowns: allGodownsBreakdown.rows
        }
      });
    }

    // ────────────────────────────────────────────────────────────────────────
    // DEFAULT / HELP
    // ────────────────────────────────────────────────────────────────────────
    return res.json({
      success: true,
      action: 'HELP',
      message: `👋 Hi **${username}**! I'm your ERP AI Assistant. I can automatically perform stock and inventory actions for you!\n\n` +
        `**Try commands like:**\n` +
        `• 🔄 **Transfer Stock:** *"Transfer 5 cases of 28 Chorsa from Main Godown to Branch Godown"*\n` +
        `• 📦 **Create Product & Allocate:** *"Add new product 50 Shots on brand Standard type Crackers price 450 per case 20 and add 15 cases to Main Godown"*\n` +
        `• 📥 **Add Stock:** *"Add 25 cases of 28 Chorsa to Main Godown"*\n` +
        `• 📊 **Check Stock:** *"Check stock in Main Godown"* or *"Overall stock"*`,
      details: {}
    });

  } catch (err) {
    console.error('AI Bot Controller error:', err);
    return res.status(500).json({
      success: false,
      message: `AI action error: ${err.message}`
    });
  }
};
