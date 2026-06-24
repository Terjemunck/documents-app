-- ============================================================
-- Cosmetics Compliance Document Management System
-- Supabase Database Schema
-- ============================================================
-- Run this in the Supabase SQL Editor (one paste, full run).
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role               AS ENUM ('admin', 'user');
CREATE TYPE document_status         AS ENUM ('current', 'outdated', 'under_review', 'pending_upload');
CREATE TYPE compliance_status       AS ENUM ('pass', 'warning', 'fail', 'pending');
CREATE TYPE batch_job_status        AS ENUM ('pending', 'running', 'completed', 'failed');
CREATE TYPE market_compliance_status AS ENUM ('complete', 'incomplete', 'outdated', 'unchecked');


-- ============================================================
-- USER PROFILES
-- Extends Supabase auth.users with role management.
-- ============================================================

CREATE TABLE user_profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name   TEXT,
    role        user_role NOT NULL DEFAULT 'user',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create a profile row when a new user signs up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_profiles (id, full_name, role)
    VALUES (
        NEW.id,
        NEW.raw_user_meta_data->>'full_name',
        'user'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ============================================================
-- MARKETS
-- ============================================================

CREATE TABLE markets (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,   -- 'EU', 'ME'
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO markets (name, code, description) VALUES
    ('European Union', 'EU', 'Governed by EU Cosmetics Regulation (EC) No 1223/2009'),
    ('Middle East',    'ME', 'Requirements vary by country; track per-market compliance');


-- ============================================================
-- DOCUMENT TYPES
-- Extensible — add new types as regulations evolve.
-- ============================================================

CREATE TABLE document_types (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    description TEXT,
    sort_order  INT  NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO document_types (name, code, description, sort_order) VALUES
    ('Cosmetic Product Safety Report', 'CPSR',       'Full safety assessment per Annex I of EU Cosmetics Regulation',         1),
    ('Product Information File',       'PIF',        'Complete product dossier: formulation, manufacturing, safety data',     2),
    ('INCI / Ingredient Declaration',  'INCI',       'Full ingredient list in INCI nomenclature',                             3),
    ('Stability Test Report',          'STABILITY',  'Testing results demonstrating product shelf life',                     4),
    ('Preservative Efficacy Test',     'PET',        'Challenge test confirming preservative effectiveness',                 5),
    ('CPNP Notification Record',       'CPNP',       'CPNP submission confirmation — EU only',                               6),
    ('Claims Substantiation',          'CLAIMS',     'Evidence supporting marketing claims',                                 7),
    ('GMP / Manufacturing Documentation','GMP',      'Good Manufacturing Practice documentation and certificates',          8),
    ('Market-specific Registration',   'MARKET_REG', 'Country-specific registration certificates — Middle East',            9);


-- ============================================================
-- MARKET DOCUMENT REQUIREMENTS
-- Defines which document types are required per market.
-- is_required = false means "optional but tracked".
-- ============================================================

CREATE TABLE market_document_requirements (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id        UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    document_type_id UUID NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
    is_required      BOOLEAN NOT NULL DEFAULT true,
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(market_id, document_type_id)
);

DO $$
DECLARE
    eu_id        UUID; me_id       UUID;
    cpsr_id      UUID; pif_id      UUID; inci_id     UUID;
    stability_id UUID; pet_id      UUID; cpnp_id     UUID;
    claims_id    UUID; gmp_id      UUID; market_reg_id UUID;
BEGIN
    SELECT id INTO eu_id         FROM markets       WHERE code = 'EU';
    SELECT id INTO me_id         FROM markets       WHERE code = 'ME';
    SELECT id INTO cpsr_id       FROM document_types WHERE code = 'CPSR';
    SELECT id INTO pif_id        FROM document_types WHERE code = 'PIF';
    SELECT id INTO inci_id       FROM document_types WHERE code = 'INCI';
    SELECT id INTO stability_id  FROM document_types WHERE code = 'STABILITY';
    SELECT id INTO pet_id        FROM document_types WHERE code = 'PET';
    SELECT id INTO cpnp_id       FROM document_types WHERE code = 'CPNP';
    SELECT id INTO claims_id     FROM document_types WHERE code = 'CLAIMS';
    SELECT id INTO gmp_id        FROM document_types WHERE code = 'GMP';
    SELECT id INTO market_reg_id FROM document_types WHERE code = 'MARKET_REG';

    -- EU: CPNP required, MARKET_REG optional
    INSERT INTO market_document_requirements (market_id, document_type_id, is_required) VALUES
        (eu_id, cpsr_id,       true),
        (eu_id, pif_id,        true),
        (eu_id, inci_id,       true),
        (eu_id, stability_id,  true),
        (eu_id, pet_id,        true),
        (eu_id, cpnp_id,       true),
        (eu_id, claims_id,     true),
        (eu_id, gmp_id,        true),
        (eu_id, market_reg_id, false);

    -- Middle East: MARKET_REG required, CPNP optional
    INSERT INTO market_document_requirements (market_id, document_type_id, is_required) VALUES
        (me_id, cpsr_id,       true),
        (me_id, pif_id,        true),
        (me_id, inci_id,       true),
        (me_id, stability_id,  true),
        (me_id, pet_id,        true),
        (me_id, cpnp_id,       false),
        (me_id, claims_id,     true),
        (me_id, gmp_id,        true),
        (me_id, market_reg_id, true);
END $$;


-- ============================================================
-- PRODUCTS
-- ============================================================

CREATE TABLE products (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    sku         TEXT UNIQUE,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID REFERENCES auth.users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- DOCUMENTS
-- One row per file uploaded. A product can have multiple
-- versions of the same document type — the most recent
-- non-outdated one is treated as current.
-- ============================================================

CREATE TABLE documents (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    market_id        UUID NOT NULL REFERENCES markets(id),
    document_type_id UUID NOT NULL REFERENCES document_types(id),
    -- Storage
    file_path        TEXT,         -- Supabase Storage object path
    file_name        TEXT,
    file_size        BIGINT,       -- bytes
    file_mime_type   TEXT,
    -- Metadata
    version          TEXT NOT NULL DEFAULT '1.0',
    status           document_status NOT NULL DEFAULT 'current',
    upload_date      TIMESTAMPTZ NOT NULL DEFAULT now(),
    review_date      DATE,         -- when document should next be reviewed
    expiry_date      DATE,         -- hard expiry (if applicable)
    notes            TEXT,
    uploaded_by      UUID REFERENCES auth.users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_product_market     ON documents(product_id, market_id);
CREATE INDEX idx_documents_type               ON documents(document_type_id);
CREATE INDEX idx_documents_status             ON documents(status);
CREATE INDEX idx_documents_review_date        ON documents(review_date);


-- ============================================================
-- BATCH JOBS
-- Tracks multi-document AI compliance check runs.
-- ============================================================

CREATE TABLE batch_jobs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_by          UUID REFERENCES auth.users(id),
    status              batch_job_status NOT NULL DEFAULT 'pending',
    total_documents     INT NOT NULL DEFAULT 0,
    processed_documents INT NOT NULL DEFAULT 0,
    failed_documents    INT NOT NULL DEFAULT 0,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_batch_jobs_status ON batch_jobs(status);


-- ============================================================
-- COMPLIANCE CHECK RESULTS
-- One row per AI check run on a document.
-- ============================================================

CREATE TABLE compliance_check_results (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    batch_job_id UUID REFERENCES batch_jobs(id),
    status       compliance_status NOT NULL DEFAULT 'pending',
    summary      TEXT,
    result_json  JSONB,   -- full structured AI response
    model_used   TEXT,    -- e.g. 'claude-sonnet-4-6'
    checked_by   UUID REFERENCES auth.users(id),
    checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_compliance_results_document ON compliance_check_results(document_id);
CREATE INDEX idx_compliance_results_batch    ON compliance_check_results(batch_job_id);
CREATE INDEX idx_compliance_results_status   ON compliance_check_results(status);


-- ============================================================
-- COMPLIANCE STATUS VIEW
-- Computes per product × market:
--   incomplete → one or more required doc slots missing
--   outdated   → all slots filled but a doc is past review date
--   unchecked  → all slots filled, none outdated, but AI not run
--   complete   → all slots filled, current, and AI-checked
-- ============================================================

CREATE VIEW product_market_compliance AS
WITH required_slots AS (
    -- Every (product, market, required_doc_type) combination
    SELECT
        p.id   AS product_id,
        p.name AS product_name,
        p.sku,
        m.id   AS market_id,
        m.name AS market_name,
        m.code AS market_code,
        dt.id  AS document_type_id,
        dt.name AS document_type_name
    FROM products p
    CROSS JOIN markets m
    JOIN market_document_requirements mdr ON mdr.market_id = m.id AND mdr.is_required = true
    JOIN document_types dt ON dt.id = mdr.document_type_id
    WHERE p.is_active = true
),
slot_fill AS (
    -- Join each slot to its most recent non-pending document (if any)
    SELECT
        rs.*,
        d.id          AS document_id,
        d.status      AS doc_status,
        d.review_date,
        (
            SELECT ccr.status
            FROM compliance_check_results ccr
            WHERE ccr.document_id = d.id
            ORDER BY ccr.checked_at DESC
            LIMIT 1
        ) AS last_ai_status
    FROM required_slots rs
    LEFT JOIN LATERAL (
        SELECT id, status, review_date
        FROM documents
        WHERE product_id       = rs.product_id
          AND market_id        = rs.market_id
          AND document_type_id = rs.document_type_id
          AND status           != 'pending_upload'
        ORDER BY upload_date DESC
        LIMIT 1
    ) d ON true
)
SELECT
    product_id,
    product_name,
    sku,
    market_id,
    market_name,
    market_code,
    COUNT(*)                                                    AS total_required,
    COUNT(document_id)                                          AS docs_present,
    COUNT(*) FILTER (WHERE document_id IS NULL)                 AS docs_missing,
    COUNT(*) FILTER (WHERE doc_status = 'outdated')             AS docs_outdated,
    COUNT(*) FILTER (WHERE document_id IS NOT NULL
                       AND last_ai_status IS NULL)              AS docs_unchecked,
    CASE
        WHEN COUNT(*) FILTER (WHERE document_id IS NULL)        > 0 THEN 'incomplete'
        WHEN COUNT(*) FILTER (WHERE doc_status = 'outdated')    > 0 THEN 'outdated'
        WHEN COUNT(*) FILTER (WHERE document_id IS NOT NULL
                                AND last_ai_status IS NULL)     > 0 THEN 'unchecked'
        ELSE 'complete'
    END::market_compliance_status AS compliance_status
FROM slot_fill
GROUP BY product_id, product_name, sku, market_id, market_name, market_code;


-- ============================================================
-- TRIGGERS: auto-update updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_batch_jobs_updated_at
    BEFORE UPDATE ON batch_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- UTILITY FUNCTION: flag outdated documents
-- Call this on a schedule (e.g. daily via pg_cron or a
-- Netlify cron function) to auto-mark expired docs.
-- ============================================================

CREATE OR REPLACE FUNCTION flag_outdated_documents()
RETURNS void AS $$
BEGIN
    UPDATE documents
    SET status = 'outdated'
    WHERE status      = 'current'
      AND review_date IS NOT NULL
      AND review_date  < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- HELPER FUNCTION: is current user an admin?
-- Used in RLS policies below.
-- ============================================================

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM user_profiles
        WHERE id = auth.uid() AND role = 'admin'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE user_profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_types             ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE products                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_check_results   ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_jobs                 ENABLE ROW LEVEL SECURITY;

-- user_profiles
CREATE POLICY "Users read own profile"     ON user_profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "Admins read all profiles"   ON user_profiles FOR SELECT USING (is_admin());
CREATE POLICY "Users update own profile"   ON user_profiles FOR UPDATE USING (id = auth.uid());
CREATE POLICY "Admins manage all profiles" ON user_profiles FOR ALL    USING (is_admin());

-- Reference tables: read-only for all authenticated users, managed by admins
CREATE POLICY "Auth read markets"       ON markets FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Admins manage markets"   ON markets FOR ALL    USING (is_admin());

CREATE POLICY "Auth read doc types"     ON document_types FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Admins manage doc types" ON document_types FOR ALL    USING (is_admin());

CREATE POLICY "Auth read requirements"     ON market_document_requirements FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Admins manage requirements" ON market_document_requirements FOR ALL    USING (is_admin());

-- Products
CREATE POLICY "Auth read products"    ON products FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Auth insert products"  ON products FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Auth update products"  ON products FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Admins delete products" ON products FOR DELETE USING (is_admin());

-- Documents
CREATE POLICY "Auth read documents"    ON documents FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Auth insert documents"  ON documents FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Auth update documents"  ON documents FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Admins delete documents" ON documents FOR DELETE USING (is_admin());

-- Compliance results
CREATE POLICY "Auth read compliance results"   ON compliance_check_results FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Auth insert compliance results" ON compliance_check_results FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Batch jobs
CREATE POLICY "Auth read batch jobs"    ON batch_jobs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Auth insert batch jobs"  ON batch_jobs FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Auth update batch jobs"  ON batch_jobs FOR UPDATE USING (auth.role() = 'authenticated');


-- ============================================================
-- SUPABASE STORAGE
-- Create a bucket called "compliance-documents" manually in
-- the Supabase dashboard → Storage → New bucket.
-- Recommended settings:
--   - Private bucket (not public)
--   - Max file size: 50 MB
--   - Allowed MIME types: application/pdf, application/msword,
--     application/vnd.openxmlformats-officedocument.wordprocessingml.document
-- ============================================================
