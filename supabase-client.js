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

async function createProduct({ name, sku, description }) {
  const user  = await getCurrentUser();
  const orgId = await getOrgId();
  const { data, error } = await sb
    .from('products')
    .insert({ name, sku: sku || null, description: description || null, created_by: user.id, org_id: orgId })
    .select().single();
  if (error) throw error;
  return data;
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
  return data;
}

async function getDocumentTypes() {
  const { data, error } = await sb
    .from('document_types').select('*').order('sort_order');
  if (error) throw error;
  return data;
}

async function getMarketRequirements() {
  const { data, error } = await sb
    .from('market_document_requirements')
    .select('*, markets(*), document_types(*)')
  if (error) throw error;
  // Exclude rows where the document type is globally disabled
  return (data || []).filter(r => r.document_types?.is_active === true);
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

function showToast(message, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span>${message}</span>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3500);
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
function openModal({ title, body, onConfirm, confirmText = 'Confirm', confirmCls = 'btn-primary' }) {
  document.getElementById('modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" onclick="document.getElementById('modal-overlay').remove()">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-overlay').remove()">Cancel</button>
        <button class="btn ${confirmCls}" id="modal-confirm">${confirmText}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (onConfirm) {
    document.getElementById('modal-confirm').addEventListener('click', () => onConfirm(overlay));
  }
  return overlay;
}
