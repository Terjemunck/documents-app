// ─────────────────────────────────────────────────────────────────────────────
// invite-user.js
// Netlify Function — admin-only user invite via Supabase admin API.
//
// POST /.netlify/functions/invite-user
// Headers: Authorization: Bearer <access_token>
// Body: { email, full_name }
//
// Required environment variables:
//   SUPABASE_URL          — https://nqajrmedbjvghvsccbsv.supabase.co
//   SUPABASE_SERVICE_KEY  — service role key from Supabase dashboard
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const SITE_URL = process.env.URL || process.env.SITE_URL || 'https://katicomdocuments.netlify.app';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': SITE_URL,
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Verify Bearer token
  const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verify caller is authenticated
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };

  // Verify caller is admin
  const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };

  // Parse request body
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const { email, full_name } = body;
  if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required' }) };

  // Send invite via Supabase Admin API
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: full_name?.trim() || '' },
    redirectTo: `${SITE_URL}/index.html`,
  });

  if (error) return { statusCode: 400, headers, body: JSON.stringify({ error: error.message }) };
  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
}
