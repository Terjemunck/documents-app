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

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export const handler = async (event) => {
  const origin = event.headers?.origin || '*';

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin), body: 'Method not allowed' };
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let document_id;
  try {
    ({ document_id } = JSON.parse(event.body));
    if (!document_id) throw new Error('Missing document_id');
  } catch (err) {
    return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: err.message }) };
  }

  // ── Clients ───────────────────────────────────────────────────────────────
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // ── 1. Fetch document metadata ─────────────────────────────────────────
    const { data: doc, error: docErr } = await sb
      .from('documents')
      .select('*, document_types(*), markets(*), products(*)')
      .eq('id', document_id)
      .single();

    if (docErr || !doc) {
      return { statusCode: 404, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Document not found' }) };
    }

    // ── 2. Download file from Storage ──────────────────────────────────────
    const { data: fileData, error: fileErr } = await sb.storage
      .from('compliance-documents')
      .download(doc.file_path);

    if (fileErr || !fileData) {
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Could not download file from storage' }) };
    }

    // ── 3. Extract text content ────────────────────────────────────────────
    const fileBuffer = Buffer.from(await fileData.arrayBuffer());
    const mimeType   = doc.file_mime_type || '';
    let messageContent;

    if (mimeType === 'application/pdf') {
      // Pass PDF directly to Claude as base64
      messageContent = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: fileBuffer.toString('base64'),
          },
        },
        { type: 'text', text: buildPrompt(doc) },
      ];
    } else {
      // Word document — extract text with mammoth
      const { value: text } = await mammoth.extractRawText({ buffer: fileBuffer });
      if (!text || text.trim().length < 50) {
        return {
          statusCode: 422,
          headers: corsHeaders(origin),
          body: JSON.stringify({ error: 'Could not extract readable text from document. Is it a scanned PDF?' }),
        };
      }
      messageContent = [
        { type: 'text', text: buildPrompt(doc) + '\n\n---\nDOCUMENT CONTENT:\n\n' + text.slice(0, 60000) },
      ];
    }

    // ── 4. Call Claude ─────────────────────────────────────────────────────
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: messageContent }],
    });

    const aiText = response.content[0]?.text || '';

    // ── 5. Parse AI response ───────────────────────────────────────────────
    const result = parseAiResponse(aiText);

    // ── 6. Save result to DB ───────────────────────────────────────────────
    const { data: saved, error: saveErr } = await sb
      .from('compliance_check_results')
      .insert({
        document_id,
        status:      result.status,
        summary:     result.summary,
        result_json: result,
        model_used:  'claude-sonnet-4-6',
        checked_at:  new Date().toISOString(),
      })
      .select()
      .single();

    if (saveErr) console.error('Save error:', saveErr);

    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, result }),
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
// Prompt builder
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(doc) {
  const market   = doc.markets?.name   || 'Unknown market';
  const docType  = doc.document_types?.name || 'Unknown document type';
  const product  = doc.products?.name  || 'Unknown product';
  const isEU     = doc.markets?.code === 'EU';

  return `You are a regulatory compliance expert specialising in cosmetics.

You are reviewing a **${docType}** for the product **"${product}"** intended for the **${market}** market.

${isEU ? `The primary regulatory framework is EU Cosmetics Regulation (EC) No 1223/2009.` : `The regulatory framework is market-specific cosmetics regulations for the Middle East region.`}

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
