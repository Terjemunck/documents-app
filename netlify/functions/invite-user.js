// ─────────────────────────────────────────────────────────────────────────────
// invite-user.js
// Netlify Function — invite a user and assign them to an org.
//
// POST /.netlify/functions/invite-user
// Headers: Authorization: Bearer <access_token>
// Body: { email, full_name, org_id (platform admin only), role }
//
// Platform admin (role='admin')  → can invite to ANY org, any role
// Org admin      (role='org_admin') → can only invite to their own org,
//                                     role capped at org_admin
//
// Required environment variables:
//   SUPABASE_URL          — https://nqajrmedbjvghvsccbsv.supabase.co
//   SUPABASE_SERVICE_KEY  — service role key from Supabase dashboard
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const SITE_URL = process.env.URL || process.env.SITE_URL || 'https://katicomdocuments.netlify.app';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── Verify caller ───────────────────────────────────────────────────────────
  const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorised' }) };

  const sb = createClient(
    process.env.SUPABASE_URL || 'https://nqajrmedbjvghvsccbsv.supabase.co',
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: { user: caller }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !caller) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid token' }) };

  const { data: callerProfile } = await sb
    .from('user_profiles').select('role, org_id').eq('id', caller.id).single();

  const isPlatformAdmin = callerProfile?.role === 'admin';
  const isOrgAdmin      = callerProfile?.role === 'org_admin';

  if (!isPlatformAdmin && !isOrgAdmin) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Insufficient permissions' }) };
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const { email, full_name, org_id, role } = body;
  if (!email) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'email is required' }) };

  // ── Determine target org and role ───────────────────────────────────────────
  let targetOrgId = isPlatformAdmin ? org_id : callerProfile.org_id;
  if (!targetOrgId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'org_id is required' }) };

  // Org admins cannot grant platform admin role
  const allowedRoles = isPlatformAdmin
    ? ['admin', 'org_admin', 'user']
    : ['org_admin', 'user'];
  const safeRole = allowedRoles.includes(role) ? role : 'user';

  // ── Send invite ─────────────────────────────────────────────────────────────
  const { error: inviteErr } = await sb.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${SITE_URL}/index.html`,
    data: {
      org_id:    targetOrgId,
      role:      safeRole,
      full_name: (full_name || '').trim(),
    },
  });

  if (inviteErr) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: inviteErr.message }) };

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ success: true, email }),
  };
}
