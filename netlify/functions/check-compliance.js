// ─────────────────────────────────────────────────────────────────────────────
// check-compliance.js
// Netlify Function — AI compliance check for a single document.
//
// POST /api/check-compliance
// Body: { document_id: string }
//
// Required environment variables (set in Netlify UI → Site → Environment):
//   ANTHROPIC_API_KEY      — from console.anthropic.com
//   SUPABASE_URL           — https://nqajrmedbjvghvsccbsv.supabase.co
//   SUPABASE_SERVICE_KEY   — service role key from Supabase dashboard
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import mammoth from 'mammoth';

const ALLOWED_ORIGIN = process.env.URL || '*';
const MODEL = 'claude-haiku-4-5-20251001';

// Cost per million tokens (USD) — Haiku 4.5 pricing
const COST_INPUT_PER_MTK  = 0.80;
const COST_OUTPUT_PER_MTK = 4.00;

const MARKET_REGS = {
  EU:  'EU Cosmetics Regulation (EC) No 1223/2009 (CPNP notification required)',
  SA:  'Saudi Food and Drug Authority (SFDA) Cosmetics Technical Regulation (SFDA.GN.0002)',
  UAE: 'UAE Federal Decree-Law No. 36/2021 and Ministry of Health cosmetics guidelines',
  KW:  'Kuwait PAFN / GCC Technical Regulation for Cosmetic Products',
  BH:  'Bahrain NHRA GCC Technical Regulation for Cosmetic Products',
  OM:  'Oman Food and Drug Safety Authority (OFDSA) cosmetics regulations',
  QA:  'Qatar Ministry of Public Health GCC Technical Regulation for Cosmetics',
  EG:  'Egyptian Drug Authority (EDA) Decision No. 164/2019 on cosmetics',
  ME:  'Middle East regional cosmetics regulations (GCC Technical Regulation GSO 1943)',
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export const handler = async (event) => {
  const origin = event.headers?.origin || '*';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: 'Method not allowed' };
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let document_id, document_id_b, check_type;
  try {
    ({ document_id, document_id_b, check_type } = JSON.parse(event.body));
    if (!document_id) throw new Error('Missing document_id');
  } catch (err) {
    return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: err.message }) };
  }
  const isConsistency = check_type === 'consistency' && !!document_id_b;

  // ── Clients ────────────────────────────────────────────────────────────────
  const sb       = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // ── 1. Authenticate user ─────────────────────────────────────────────────
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) {
      return { statusCode: 401, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
    if (authErr || !user) {
      return { statusCode: 401, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid session' }) };
    }

    // ── 2. Check AI permission ───────────────────────────────────────────────
    const { data: profile } = await sb
      .from('user_profiles')
      .select('role, org_id, can_use_ai')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'User profile not found' }) };
    }

    const isAdminRole = profile.role === 'admin' || profile.role === 'org_admin';
    if (!isAdminRole && !profile.can_use_ai) {
      return {
        statusCode: 403,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: 'AI checks are not enabled for your account. Ask your org admin to enable it.' }),
      };
    }

    // ── 3. Check monthly spend cap ───────────────────────────────────────────
    const { data: org } = await sb
      .from('organizations')
      .select('ai_monthly_cap_usd')
      .eq('id', profile.org_id)
      .single();

    if (org?.ai_monthly_cap_usd != null) {
      const firstOfMonth = new Date();
      firstOfMonth.setDate(1); firstOfMonth.setHours(0, 0, 0, 0);

      const { data: usage } = await sb
        .from('compliance_check_results')
        .select('cost_usd')
        .eq('org_id', profile.org_id)
        .gte('checked_at', firstOfMonth.toISOString())
        .not('cost_usd', 'is', null);

      const spent = (usage || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
      if (spent >= Number(org.ai_monthly_cap_usd)) {
        return {
          statusCode: 402,
          headers: corsHeaders(origin),
          body: JSON.stringify({
            error: `Monthly AI cap of $${Number(org.ai_monthly_cap_usd).toFixed(2)} reached. Adjust the cap in Admin → AI Usage.`,
          }),
        };
      }
    }

    // ── 4. Fetch document metadata ───────────────────────────────────────────
    const { data: doc, error: docErr } = await sb
      .from('documents')
      .select('*, document_types(*), markets(*), products(*)')
      .eq('id', document_id)
      .single();

    if (docErr || !doc) {
      return { statusCode: 404, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Document not found' }) };
    }

    // Verify doc belongs to the user's org
    if (doc.org_id !== profile.org_id && profile.role !== 'admin') {
      return { statusCode: 403, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Access denied' }) };
    }

    // ── 5. Download file(s) from Storage ────────────────────────────────────
    async function downloadAndPrepare(d) {
      const { data: fd, error: fe } = await sb.storage.from('compliance-documents').download(d.file_path);
      if (fe || !fd) throw new Error('Could not download file: ' + d.file_name);
      const buf  = Buffer.from(await fd.arrayBuffer());
      const mime = d.file_mime_type || '';
      if (mime === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
      }
      const { value: text } = await mammoth.extractRawText({ buffer: buf });
      if (!text || text.trim().length < 50) throw new Error('Could not extract text from ' + d.file_name);
      return { type: 'text', text: text.slice(0, 40000) };
    }

    // ── 6. Build message content ─────────────────────────────────────────────
    let messageContent, result, promptText;

    if (isConsistency) {
      // ── Consistency cross-check ─────────────────────────────────────────
      const { data: docB } = await sb
        .from('documents')
        .select('*, document_types(*), markets(*), products(*)')
        .eq('id', document_id_b)
        .single();
      if (!docB) return { statusCode: 404, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Second document not found' }) };

      const [partA, partB] = await Promise.all([downloadAndPrepare(doc), downloadAndPrepare(docB)]);
      promptText   = buildConsistencyPrompt(doc, docB);
      messageContent = [partA, partB, { type: 'text', text: promptText }];

      const response = await anthropic.messages.create({
        model: MODEL, max_tokens: 2048, temperature: 0,
        messages: [{ role: 'user', content: messageContent }],
      });
      const aiText       = response.content[0]?.text || '';
      const inputTokens  = response.usage?.input_tokens  || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const costUsd      = (inputTokens * COST_INPUT_PER_MTK + outputTokens * COST_OUTPUT_PER_MTK) / 1_000_000;
      result = parseConsistencyResponse(aiText);

      await sb.from('compliance_check_results').insert({
        document_id, document_id_b,
        org_id: doc.org_id, status: result.status, summary: result.summary,
        result_json: result, model_used: MODEL, checked_by: user.id,
        checked_at: new Date().toISOString(),
        input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd,
        check_type: 'consistency',
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, result: { ...result, cost_usd: costUsd } }),
      };
    }

    // ── Standard document check ──────────────────────────────────────────────
    const filePart = await downloadAndPrepare(doc);
    if (filePart.type === 'document') {
      messageContent = [filePart, { type: 'text', text: buildPrompt(doc) }];
    } else {
      messageContent = [{ type: 'text', text: buildPrompt(doc) + '\n\n---\nDOCUMENT CONTENT:\n\n' + filePart.text }];
    }

    // ── 7. Call Claude ───────────────────────────────────────────────────────
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: 'user', content: messageContent }],
    });

    const aiText       = response.content[0]?.text || '';
    const inputTokens  = response.usage?.input_tokens  || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costUsd      = (inputTokens * COST_INPUT_PER_MTK + outputTokens * COST_OUTPUT_PER_MTK) / 1_000_000;

    // ── 8. Parse AI response ─────────────────────────────────────────────────
    result = parseAiResponse(aiText);

    // ── 9. Save to DB ────────────────────────────────────────────────────────
    const { error: saveErr } = await sb.from('compliance_check_results').insert({
      document_id,
      org_id:        doc.org_id,
      status:        result.status,
      summary:       result.summary,
      result_json:   result,
      model_used:    MODEL,
      checked_by:    user.id,
      checked_at:    new Date().toISOString(),
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cost_usd:      costUsd,
      check_type:    'document',
    });
    if (saveErr) console.error('Save error:', saveErr);

    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        result: { ...result, cost_usd: costUsd, input_tokens: inputTokens, output_tokens: outputTokens },
      }),
    };

  } catch (err) {
    console.error('Compliance check error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: err.message || 'Unexpected error' }),
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder — market-aware regulatory context
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(doc) {
  const market  = doc.markets?.name  || 'Unknown market';
  const docType = doc.document_types?.name || 'Unknown document type';
  const product = doc.products?.name || 'Unknown product';
  const mktCode = (doc.markets?.code || '').toUpperCase();
  const regs    = MARKET_REGS[mktCode] || MARKET_REGS.ME;

  return `You are a regulatory compliance expert specialising in cosmetics.

You are reviewing a **${docType}** for the product **"${product}"** intended for the **${market}** market.

The primary regulatory framework is: ${regs}

Please review the document and provide a compliance assessment. Respond in the following exact format:

STATUS: [PASS | WARNING | FAIL]

SUMMARY:
[2–4 sentence plain-English summary of whether the document meets its regulatory purpose and any key concerns.]

ISSUES:
[List any gaps, missing sections, or non-compliant elements. If none, write "None identified."]

RECOMMENDATIONS:
[Specific actionable suggestions to address the issues above. If none, write "None."]

DISCLAIMER: This AI assessment checks document structure and completeness against known regulatory requirements. It does not replace a qualified Responsible Person or safety assessor. Regulatory updates must be tracked manually.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consistency cross-check prompt
// ─────────────────────────────────────────────────────────────────────────────
const PAIR_INSTRUCTIONS = {
  'CPSR|INCI':       'Verify that every ingredient in the INCI declaration appears in the CPSR safety assessment with consistent concentrations and functions. Flag any ingredient present in one document but absent or differently described in the other.',
  'INCI|STABILITY':  'Verify that the product composition in the stability test matches the INCI ingredient list exactly. Flag any discrepancies in ingredient identity, concentration, or formulation details.',
  'CLAIMS|CPSR':     'Verify that every marketing or on-pack claim is substantiated by the safety conclusions in the CPSR. Flag any claim the safety assessment does not explicitly support.',
  'INCI|MARKET_REG': 'Verify that the INCI ingredient declaration matches the ingredient information in the market registration. Flag any discrepancies in ingredient names, concentrations, or INCI naming conventions.',
};

function buildConsistencyPrompt(docA, docB) {
  const codeA    = docA.document_types?.code || '';
  const codeB    = docB.document_types?.code || '';
  const pairKey  = [codeA, codeB].sort().join('|');
  const instructions = PAIR_INSTRUCTIONS[pairKey] ||
    'Cross-check these two documents for regulatory consistency. Flag any discrepancies.';

  return `You are a regulatory compliance expert specialising in cosmetics.

You are cross-checking two documents for the product "${docA.products?.name || 'Unknown'}" in the ${docA.markets?.name || 'Unknown'} market.

Document A: ${docA.document_types?.name || 'Document A'}
Document B: ${docB.document_types?.name || 'Document B'}

${instructions}

Respond in the following exact format:

STATUS: [MATCH | PARTIAL | MISMATCH]

SUMMARY:
[2–3 sentence plain-English summary of overall consistency between the two documents.]

DISCREPANCIES:
[List specific inconsistencies found. If none, write "None identified."]

RECOMMENDATIONS:
[What to update or verify to resolve any discrepancies. If none, write "None."]

DISCLAIMER: This AI cross-check identifies potential inconsistencies between document pairs. Always verify findings with a qualified regulatory expert before market submission.`;
}

function parseConsistencyResponse(text) {
  const get = (label, nextLabel) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n${nextLabel}:|$)`, 'i');
    return (text.match(re)?.[1] || '').trim();
  };
  const rawStatus = get('STATUS', 'SUMMARY').toUpperCase();
  let status = 'warning';
  if (rawStatus.includes('MISMATCH'))                                     status = 'fail';
  else if (rawStatus.includes('PARTIAL'))                                 status = 'warning';
  else if (rawStatus.includes('MATCH') && !rawStatus.includes('PARTIAL')) status = 'pass';
  return {
    status,
    summary:         get('SUMMARY',         'DISCREPANCIES'),
    issues:          get('DISCREPANCIES',    'RECOMMENDATIONS'),
    recommendations: get('RECOMMENDATIONS', 'DISCLAIMER'),
    disclaimer:      get('DISCLAIMER',       '~~~~'),
    raw:             text,
    checked_at:      new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse AI response into structured object
// ─────────────────────────────────────────────────────────────────────────────
function parseAiResponse(text) {
  const get = (label, nextLabel) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n${nextLabel}:|$)`, 'i');
    return (text.match(re)?.[1] || '').trim();
  };
  const rawStatus = get('STATUS', 'SUMMARY').toUpperCase();
  let status = 'warning';
  if (rawStatus.includes('PASS'))    status = 'pass';
  if (rawStatus.includes('FAIL'))    status = 'fail';
  if (rawStatus.includes('WARNING')) status = 'warning';
  return {
    status,
    summary:         get('SUMMARY',         'ISSUES'),
    issues:          get('ISSUES',          'RECOMMENDATIONS'),
    recommendations: get('RECOMMENDATIONS', 'DISCLAIMER'),
    disclaimer:      get('DISCLAIMER',       '~~~~'),
    raw:             text,
    checked_at:      new Date().toISOString(),
  };
}
