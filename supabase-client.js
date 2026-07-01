// ─────────────────────────────────────────────────────────────────────────────
// supabase-client.js
// Shared Supabase client, auth helpers, and data access functions.
// Included via <script> tag before page-specific scripts.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://nqajrmedbjvghvsccbsv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_qErKtU-Nl2yiBlomKlijjA_yFNOpx9v';

const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function requireAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return null; }
  return session;
}

async function getCurrentUser() {
  const { data: { user } } = await sb.auth.getUser();
  return user;
}

let _profileCache = null;
async function getUserProfile(forceRefresh = false) {
  if (_profileCache && !forceRefresh) return _profileCache;
  const user = await getCurrentUser();
  if (!user) return null;
  const { data } = await sb.from('user_profiles').select('*').eq('id', user.id).single();
  _profileCache = data;
  return data;
}

async function isAdmin() {
  const profile = await getUserProfile();
  return profile?.role === 'admin';
}

async function getOrgId() {
  const profile = await getUserProfile();
  return profile?.org_id || null;
}

async function signOut() {
  _profileCache = null;
  await sb.auth.signOut();
  window.location.href = 'index.html';
}

// ─── Products ─────────────────────────────────────────────────────────────────

async function getProducts() {
  const { data, error } = await sb
    .from('products').select('*').eq('is_active', true).order('name');
  if (error) throw error;
  return data;
}

async function getProduct(id) {
  const { data, error } = await sb
    .from('products').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function createProduct({ name, sku, description, marketIds = [] }) {
  const user  = await getCurrentUser();
  const orgId = await getOrgId();
  const { data, error } = await sb
    .from('products')
    .insert({ name, sku: sku || null, description: description || null, created_by: user.id, org_id: orgId })
    .select().single();
  if (error) throw error;
  if (marketIds.length) {
    const inserts = marketIds.map(mid => ({ product_id: data.id, market_id: mid, org_id: orgId }));
    const { error: mErr } = await sb.from('product_markets').insert(inserts);
    if (mErr) throw mErr;
  }
  return data;
}

async function getProductMarkets(productId) {
  const { data, error } = await sb
    .from('product_markets')
    .select('market_id, markets(id, name, code)')
    .eq('product_id', productId);
  if (error) throw error;
  return data || [];
}

async function setProductMarkets(productId, marketIds) {
  const orgId = await getOrgId();
  await sb.from('product_markets').delete().eq('product_id', productId);
  if (marketIds.length) {
    const inserts = marketIds.map(mid => ({ product_id: productId, market_id: mid, org_id: orgId }));
    const { error } = await sb.from('product_markets').insert(inserts);
    if (error) throw error;
  }
}

async function updateProduct(id, updates) {
  const { data, error } = await sb
    .from('products').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ─── Reference data ───────────────────────────────────────────────────────────

async function getMarkets() {
  const { data, error } = await sb.from('markets').select('*').order('name');
  if (error) throw error;
  // EU always first, rest alphabetical
  return (data || []).sort((a, b) => {
    if (a.code === 'EU') return -1;
    if (b.code === 'EU') return 1;
    return a.name.localeCompare(b.name);
  });
}

async function getDocumentTypes() {
  const { data, error } = await sb
    .from('document_types').select('*').order('sort_order');
  if (error) throw error;
  return data;
}

async function getMarketRequirements() {
  // Global requirements
  const { data: globalData, error } = await sb
    .from('market_document_requirements')
    .select('*, markets(*), document_types(*)');
  if (error) throw error;
  const global = (globalData || []).filter(r => r.document_types?.is_active === true);

  // Org-specific custom types added as requirements
  const { data: orgData } = await sb
    .from('org_document_requirements')
    .select('market_id, document_type_id, markets(*), document_types(*)');
  const orgCustom = (orgData || [])
    .filter(r => r.document_types?.org_id !== null && r.document_types?.org_id !== undefined && r.document_types?.is_active === true)
    .map(r => ({ ...r, is_required: true }));

  return [...global, ...orgCustom];
}

async function getOrgDocumentTypes() {
  const { data, error } = await sb
    .from('document_types')
    .select('*')
    .not('org_id', 'is', null)
    .order('name');
  if (error) throw error;
  return data || [];
}

async function createOrgDocumentType(name) {
  const orgId = await getOrgId();
  const code  = 'CUSTOM_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 12) + '_' + Date.now().toString(36).toUpperCase();
  const { data, error } = await sb.from('document_types')
    .insert({ name, code, org_id: orgId, is_active: true, sort_order: 999 })
    .select().single();
  if (error) throw error;
  return data;
}

async function deleteOrgDocumentType(id) {
  // Safety check: any documents uploaded against this type?
  const { count } = await sb.from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('document_type_id', id);
  if (count > 0) throw new Error(`Cannot delete — ${count} document(s) already uploaded for this type.`);
  // Remove from org requirements first, then delete type
  await sb.from('org_document_requirements').delete().eq('document_type_id', id);
  const { error } = await sb.from('document_types').delete().eq('id', id);
  if (error) throw error;
}

async function getOrgDocumentRequirements(orgId) {
  let query = sb.from('org_document_requirements')
    .select('market_id, document_type_id');
  if (orgId) query = query.eq('org_id', orgId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function setOrgDocumentRequirements(orgId, marketId, documentTypeIds) {
  // Delete existing for this org+market, then re-insert
  const { error: delErr } = await sb.from('org_document_requirements')
    .delete()
    .eq('org_id', orgId)
    .eq('market_id', marketId);
  if (delErr) throw delErr;
  if (documentTypeIds.length) {
    const inserts = documentTypeIds.map(dtId => ({ org_id: orgId, market_id: marketId, document_type_id: dtId }));
    const { error } = await sb.from('org_document_requirements').insert(inserts);
    if (error) throw error;
  }
}

async function setDocTypeActive(id, isActive) {
  const { error } = await sb
    .from('document_types')
    .update({ is_active: isActive })
    .eq('id', id);
  if (error) throw error;
}

// ─── Compliance dashboard ─────────────────────────────────────────────────────

async function getComplianceSummary() {
  const { data, error } = await sb
    .from('product_market_compliance').select('*').order('product_name');
  if (error) throw error;
  return data;
}

// ─── Documents ────────────────────────────────────────────────────────────────

async function getProductDocuments(productId) {
  const { data, error } = await sb
    .from('documents')
    .select('*, document_types(*), markets(*)')
    .eq('product_id', productId)
    .order('upload_date', { ascending: false });
  if (error) throw error;
  return data;
}

async function uploadDocument({ productId, marketId, documentTypeId, file, version, reviewDate, expiryDate, notes }) {
  const user  = await getCurrentUser();
  const orgId = await getOrgId();

  // Build storage path
  const timestamp = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `products/${productId}/${marketId}/${documentTypeId}/${timestamp}_${safeName}`;

  // Upload file to Storage
  const { error: storageError } = await sb.storage
    .from('compliance-documents')
    .upload(filePath, file, { cacheControl: '3600', upsert: false });
  if (storageError) throw storageError;

  // Mark any existing current doc for this slot as under_review
  await sb.from('documents')
    .update({ status: 'under_review' })
    .eq('product_id', productId)
    .eq('market_id', marketId)
    .eq('document_type_id', documentTypeId)
    .eq('status', 'current');

  // Insert metadata row
  const { data, error } = await sb.from('documents').insert({
    product_id:       productId,
    market_id:        marketId,
    document_type_id: documentTypeId,
    file_path:        filePath,
    file_name:        file.name,
    file_size:        file.size,
    file_mime_type:   file.type,
    version:          version || '1.0',
    status:           'current',
    review_date:      reviewDate  || null,
    expiry_date:      expiryDate  || null,
    notes:            notes       || null,
    uploaded_by:      user.id,
    org_id:           orgId,
  }).select().single();
  if (error) throw error;
  return data;
}

async function getDownloadUrl(filePath) {
  const { data, error } = await sb.storage
    .from('compliance-documents')
    .createSignedUrl(filePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

async function deleteDocumentRecord(documentId, filePath) {
  if (filePath) await sb.storage.from('compliance-documents').remove([filePath]);
  const { error } = await sb.from('documents').delete().eq('id', documentId);
  if (error) throw error;
}

// ─── Product attachments (folder uploads) ─────────────────────────────────────

async function getProductAttachments(productId) {
  const { data, error } = await sb
    .from('product_attachments')
    .select('*')
    .eq('product_id', productId)
    .order('relative_path');
  if (error) throw error;
  return data;
}

async function getSlotAttachments(productId, marketId, documentTypeId) {
  const { data, error } = await sb
    .from('product_attachments')
    .select('*')
    .eq('product_id', productId)
    .eq('market_id', marketId)
    .eq('document_type_id', documentTypeId)
    .order('relative_path');
  if (error) throw error;
  return data;
}

async function uploadAttachmentFile({ productId, marketId, documentTypeId, file, relativePath }) {
  const user  = await getCurrentUser();
  const orgId = await getOrgId();
  const timestamp = Date.now();
  const safePath = relativePath.replace(/[^a-zA-Z0-9._\-\/]/g, '_');
  const filePath = `attachments/${productId}/${marketId}/${documentTypeId}/${timestamp}/${safePath}`;

  const { error: storageError } = await sb.storage
    .from('compliance-documents')
    .upload(filePath, file, { cacheControl: '3600', upsert: false });
  if (storageError) throw storageError;

  const { error } = await sb.from('product_attachments').insert({
    product_id:       productId,
    market_id:        marketId,
    document_type_id: documentTypeId,
    file_path:        filePath,
    relative_path:    relativePath,
    file_name:        file.name,
    file_size:        file.size,
    file_mime_type:   file.type,
    uploaded_by:      user.id,
    org_id:           orgId,
  });
  if (error) throw error;
}

async function deleteAttachment(id, filePath) {
  if (filePath) await sb.storage.from('compliance-documents').remove([filePath]);
  const { error } = await sb.from('product_attachments').delete().eq('id', id);
  if (error) throw error;
}

// ─── Slot overrides (deactivate per product) ──────────────────────────────────

async function getProductOverrides(productId) {
  const { data, error } = await sb
    .from('product_document_overrides')
    .select('*')
    .eq('product_id', productId);
  if (error) throw error;
  return data;
}

async function deactivateSlot(productId, marketId, documentTypeId, reason) {
  const user  = await getCurrentUser();
  const orgId = await getOrgId();
  const { error } = await sb.from('product_document_overrides').upsert({
    product_id:       productId,
    market_id:        marketId,
    document_type_id: documentTypeId,
    is_active:        false,
    reason:           reason || null,
    deactivated_by:   user.id,
    org_id:           orgId,
  }, { onConflict: 'product_id,market_id,document_type_id' });
  if (error) throw error;
}

async function reactivateSlot(productId, marketId, documentTypeId) {
  const { error } = await sb.from('product_document_overrides')
    .delete()
    .eq('product_id', productId)
    .eq('market_id', marketId)
    .eq('document_type_id', documentTypeId);
  if (error) throw error;
}

// ─── Compliance checks ────────────────────────────────────────────────────────

async function getLatestCheck(documentId) {
  const { data } = await sb
    .from('compliance_check_results')
    .select('*')
    .eq('document_id', documentId)
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function getAllChecksForDocument(documentId) {
  const { data, error } = await sb
    .from('compliance_check_results')
    .select('*')
    .eq('document_id', documentId)
    .order('checked_at', { ascending: false });
  if (error) throw error;
  return data;
}

// Returns all consistency check records for a product's documents
async function getConsistencyChecksForProduct(productId) {
  const { data: docs } = await sb.from('documents').select('id').eq('product_id', productId);
  if (!docs?.length) return [];
  const ids = docs.map(d => d.id);
  const { data } = await sb
    .from('compliance_check_results')
    .select('*')
    .in('document_id', ids)
    .eq('check_type', 'consistency')
    .order('checked_at', { ascending: false });
  return data || [];
}

// Returns { [documentId]: latestCheckRow } for all docs belonging to a product
async function getLatestChecksForProduct(productId) {
  const { data: docs } = await sb.from('documents').select('id').eq('product_id', productId);
  if (!docs?.length) return {};
  const ids = docs.map(d => d.id);
  const { data } = await sb
    .from('compliance_check_results')
    .select('*')
    .in('document_id', ids)
    .order('checked_at', { ascending: false });
  const latest = {};
  (data || []).forEach(r => { if (!latest[r.document_id]) latest[r.document_id] = r; });
  return latest;
}

// Returns { [productId]: { pass, warning, fail, unchecked, total } } for the dashboard AI column
async function getAiCheckSummaryByProduct() {
  const { data: docs } = await sb
    .from('documents')
    .select('id, product_id')
    .eq('status', 'current');
  if (!docs?.length) return {};

  const docIds        = docs.map(d => d.id);
  const docToProduct  = {};
  docs.forEach(d => { docToProduct[d.id] = d.product_id; });

  const { data: checks } = await sb
    .from('compliance_check_results')
    .select('document_id, status, checked_at')
    .in('document_id', docIds)
    .order('checked_at', { ascending: false });

  // Latest check per document
  const latestByDoc = {};
  (checks || []).forEach(c => {
    if (!latestByDoc[c.document_id]) latestByDoc[c.document_id] = c;
  });

  // Summarise by product
  const byProduct = {};
  docs.forEach(d => {
    if (!byProduct[d.product_id]) byProduct[d.product_id] = { pass: 0, warning: 0, fail: 0, unchecked: 0, total: 0 };
    byProduct[d.product_id].total++;
    const chk = latestByDoc[d.id];
    if      (!chk)                  byProduct[d.product_id].unchecked++;
    else if (chk.status === 'pass')    byProduct[d.product_id].pass++;
    else if (chk.status === 'warning') byProduct[d.product_id].warning++;
    else if (chk.status === 'fail')    byProduct[d.product_id].fail++;
  });
  return byProduct;
}

// Returns all check records for this org from the last 3 months (for usage dashboard)
async function getAiUsageSummary() {
  const since = new Date();
  since.setMonth(since.getMonth() - 3);
  const { data, error } = await sb
    .from('compliance_check_results')
    .select('cost_usd, input_tokens, output_tokens, checked_at, check_type, model_used')
    .gte('checked_at', since.toISOString())
    .not('cost_usd', 'is', null)
    .order('checked_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function updateOrgAiCap(orgId, capUsd) {
  const { error } = await sb
    .from('organizations')
    .update({ ai_monthly_cap_usd: capUsd })
    .eq('id', orgId);
  if (error) throw error;
}

async function setUserAiPermission(userId, canUseAi) {
  const { error } = await sb
    .from('user_profiles')
    .update({ can_use_ai: canUseAi })
    .eq('id', userId);
  if (error) throw error;
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function complianceBadge(status) {
  const map = {
    complete:   ['Complete',    'badge-success'],
    incomplete: ['Incomplete',  'badge-warning'],
    outdated:   ['Outdated',    'badge-danger'],
    unchecked:  ['Unchecked',   'badge-info'],
  };
  const [label, cls] = map[status] || [status, 'badge-neutral'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function docStatusBadge(status) {
  const map = {
    current:        ['Current',      'badge-success'],
    outdated:       ['Outdated',     'badge-danger'],
    under_review:   ['Under Review', 'badge-warning'],
    pending_upload: ['Pending',      'badge-neutral'],
  };
  const [label, cls] = map[status] || [status, 'badge-neutral'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function aiCheckBadge(status) {
  if (!status) return `<span class="badge badge-neutral">Not checked</span>`;
  const map = {
    pass:    ['Pass',    'badge-success'],
    warning: ['Warning', 'badge-warning'],
    fail:    ['Fail',    'badge-danger'],
    pending: ['Pending', 'badge-info'],
  };
  const [label, cls] = map[status] || [status, 'badge-neutral'];
  return `<span class="badge ${cls}">AI: ${label}</span>`;
}

function showToast(message, type = 'success', persistent = false) {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span>${message}</span>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const dismiss = () => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  };
  if (!persistent) setTimeout(dismiss, 3500);
  return dismiss;
}

async function openProfileEditor() {
  const profile = await getUserProfile();
  openModal({
    title: 'Edit Profile',
    body: `
      <div class="form-group">
        <label class="form-label">Full name</label>
        <input type="text" id="profile-name" value="${profile?.full_name || ''}" placeholder="Your name">
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input type="text" value="${(await getCurrentUser())?.email || ''}" disabled style="opacity:.6">
        <span class="form-hint">Email cannot be changed here.</span>
      </div>`,
    confirmText: 'Save',
    onConfirm: async (overlay) => {
      const name = document.getElementById('profile-name').value.trim();
      const btn  = overlay.querySelector('#modal-confirm');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const { error } = await sb.from('user_profiles')
          .update({ full_name: name })
          .eq('id', (await getCurrentUser()).id);
        if (error) throw error;
        _profileCache = null;
        overlay.remove();
        showToast('Profile updated.');
        // Refresh displayed name
        const updated = await getUserProfile(true);
        const nameEl  = document.getElementById('nav-user');
        const avatarEl = document.getElementById('user-avatar');
        if (nameEl)   nameEl.textContent   = updated.full_name || updated.id.slice(0, 8);
        if (avatarEl) avatarEl.textContent = (updated.full_name || 'U')[0].toUpperCase();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Save';
      }
    }
  });
}

function showLoader(el, msg = 'Loading…') {
  el.innerHTML = `<div class="loader-wrap"><div class="spinner"></div><p>${msg}</p></div>`;
}

function setNavUser(profile) {
  const el = document.getElementById('nav-user');
  if (!el || !profile) return;
  el.textContent = profile.full_name || 'User';
  if (profile.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(e => e.classList.remove('admin-only'));
  }
}

// Modal helper — creates and shows a simple modal
function openModal({ title, body, onConfirm, confirmText = 'Confirm', confirmCls = 'btn-primary', cls = '' }) {
  document.getElementById('modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.className = 'modal-overlay';
  const hasConfirm = confirmText != null;
  overlay.innerHTML = `
    <div class="modal ${cls}">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" onclick="document.getElementById('modal-overlay').remove()">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-overlay').remove()">${hasConfirm ? 'Cancel' : 'Close'}</button>
        ${hasConfirm ? `<button class="btn ${confirmCls}" id="modal-confirm">${confirmText}</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (onConfirm && hasConfirm) {
    document.getElementById('modal-confirm').addEventListener('click', () => onConfirm(overlay));
  }
  return overlay;
}
