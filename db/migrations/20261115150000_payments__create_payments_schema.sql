-- T0B-13.C15 (LD-202): payments schema — C15 05-SCHEMA §6 DDL verbatim (12 tables: 1 G + 11 tenant; 24 indexes; 2 SECURITY INVOKER
-- transition guards + 1 SECURITY DEFINER app.payments_resolve_callback_token (CR-C15-004, 08 A19 P-41); 6 triggers + 8 audit triggers;
-- 31 written-out policies; grants), plus the C0 transcription steps: the missing <t>__tenant__fk on 5 tables and UNIQUE (tenant_id, id)
-- on the 3 class-A tables (C0 05-SCHEMA §9 rule 1), and the §5 coded-set seed. Policies are copied 1:1 to db/policies/payments.sql
-- (AC-0B-2.3). The payments inbox belongs to T0B-05. Schema exists since T0B-01. No view (§7). No DELETE grant. Single role switch.
SET LOCAL ROLE lims_owner;

-- ===================== §6 DDL (verbatim) =====================
-- ===================================================== coded sets
CREATE TABLE payments.g_cs_reasons (
  id uuid NOT NULL, set_name text NOT NULL, code text NOT NULL, display text NOT NULL,
  requires_text boolean NOT NULL DEFAULT false, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_reasons__set_code__uq UNIQUE (set_name, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_name IN ('hold_reasons','failure_reasons','cancel_reasons','resolution_reasons',
     'refund_reasons','refund_reject_reasons','refund_fail_reasons','refund_hold_reasons','finding_kinds','finding_resolutions')),
  CONSTRAINT g_cs_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT g_cs_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE payments.cs_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL, set_name text NOT NULL, code text NOT NULL, display text NOT NULL,
  requires_text boolean NOT NULL DEFAULT false, sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_reasons__tenant_set_code__uq UNIQUE (tenant_id, set_name, code),
  CONSTRAINT cs_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_reasons__set__fk FOREIGN KEY (set_name, code) REFERENCES payments.g_cs_reasons (set_name, code)
  -- tenants may relabel/deactivate global codes only (hold/failure/finding codes are code-driven)
);

-- ===================================================== settings
CREATE TABLE payments.settings (
  tenant_id uuid NOT NULL,
  refund_two_person_threshold_paisa bigint NOT NULL DEFAULT 0,
  purchase_order_label text NOT NULL DEFAULT 'Lab payment',
  reconciliation_enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__threshold__ck CHECK (refund_two_person_threshold_paisa >= 0),
  CONSTRAINT settings__label__ck CHECK (purchase_order_label ~ '^[A-Za-z0-9 .,&()-]{1,50}$')
);

-- ===================================================== merchant accounts
CREATE TABLE payments.merchant_accounts (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  gateway text NOT NULL, environment text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT false,
  esewa_product_code text, khalti_website_url text,
  secret_ciphertext bytea, secret_nonce bytea, secret_auth_tag bytea, secret_kek_id text,   -- Secret (AES-256-GCM, TRD §6.9)
  secret_fingerprint text, secret_set_at timestamptz, secret_set_by uuid,
  api_refunds_enabled boolean NOT NULL DEFAULT false,
  last_test_outcome text, last_test_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT merchant_accounts__pk PRIMARY KEY (id),
  CONSTRAINT merchant_accounts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT merchant_accounts__slot__uq UNIQUE (tenant_id, gateway, environment),
  CONSTRAINT merchant_accounts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT merchant_accounts__gateway__ck CHECK (gateway IN ('esewa','khalti','fonepay')),
  CONSTRAINT merchant_accounts__env__ck CHECK (environment IN ('uat','production')),
  CONSTRAINT merchant_accounts__fonepay_off__ck CHECK (gateway <> 'fonepay' OR is_enabled = false),        -- B8
  CONSTRAINT merchant_accounts__esewa_code__ck CHECK (esewa_product_code IS NULL OR (gateway = 'esewa' AND esewa_product_code ~ '^[A-Za-z0-9_-]{1,64}$')),
  CONSTRAINT merchant_accounts__khalti_url__ck CHECK (khalti_website_url IS NULL OR (gateway = 'khalti' AND khalti_website_url ~ '^https://' AND char_length(khalti_website_url) <= 300)),
  CONSTRAINT merchant_accounts__secret_shape__ck CHECK (
     (secret_ciphertext IS NULL AND secret_nonce IS NULL AND secret_auth_tag IS NULL AND secret_kek_id IS NULL AND secret_fingerprint IS NULL)
     OR (secret_ciphertext IS NOT NULL AND octet_length(secret_nonce) = 12 AND octet_length(secret_auth_tag) = 16
         AND secret_kek_id ~ '^[A-Za-z0-9_-]{1,32}$' AND secret_fingerprint ~ '^[0-9a-f]{8}$')),
  CONSTRAINT merchant_accounts__enabled_complete__ck CHECK (NOT is_enabled OR (secret_ciphertext IS NOT NULL AND
     ((gateway = 'esewa' AND esewa_product_code IS NOT NULL) OR (gateway = 'khalti' AND khalti_website_url IS NOT NULL)))),
  CONSTRAINT merchant_accounts__api_refunds__ck CHECK (NOT api_refunds_enabled OR gateway = 'khalti'),
  CONSTRAINT merchant_accounts__test__ck CHECK (last_test_outcome IS NULL OR last_test_outcome IN
     ('reachable_key_valid','reachable_key_unverifiable','auth_failed','unreachable'))
);
-- Environment vs deployment (prod refuses 'uat', EPAYTEST) is enforced in the service (deployment-level fact, not data).

-- ===================================================== intents
CREATE TABLE payments.intents (
  id uuid NOT NULL, tenant_id uuid NOT NULL, order_id uuid NOT NULL, branch_id uuid NOT NULL, centre_id uuid NOT NULL,
  gateway text NOT NULL, environment text NOT NULL, merchant_account_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'created',
  amount_paisa bigint NOT NULL, currency text NOT NULL DEFAULT 'NPR',
  idempotency_key text NOT NULL, request_fingerprint text NOT NULL,
  return_url text NOT NULL, cancel_url text NOT NULL,
  callback_token_sha256 bytea NOT NULL,
  gateway_txn_ref text, gateway_secondary_ref text, gateway_payment_url text,
  expires_at timestamptz, initiated_at timestamptz, pending_at timestamptz, settled_at timestamptz, closed_at timestamptz,
  last_checked_at timestamptz, check_count integer NOT NULL DEFAULT 0, consecutive_unknown integer NOT NULL DEFAULT 0,
  last_gateway_status_raw text, verified_amount_paisa bigint, verification_method text,
  hold_reason text, failure_reason text,
  resolution_reason_code text, resolution_note text, resolved_by uuid, resolved_at timestamptz,
  ledger_entry_id uuid,                                                   -- billing.ledger_entries id; no FK (02-CV §5.4)
  refunded_paisa bigint NOT NULL DEFAULT 0,
  created_actor_type text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT intents__pk PRIMARY KEY (id),
  CONSTRAINT intents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT intents__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT intents__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT intents__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT intents__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT intents__merchant__fk FOREIGN KEY (tenant_id, merchant_account_id) REFERENCES payments.merchant_accounts (tenant_id, id),
  CONSTRAINT intents__gateway__ck CHECK (gateway IN ('esewa','khalti','fonepay')),
  CONSTRAINT intents__env__ck CHECK (environment IN ('uat','production')),
  CONSTRAINT intents__status__ck CHECK (status IN ('created','initiated','pending','settled','failed','expired',
     'held_for_review','refunded','partially_refunded')),
  CONSTRAINT intents__amount__ck CHECK (amount_paisa > 0 AND currency = 'NPR'),
  CONSTRAINT intents__khalti_min__ck CHECK (gateway <> 'khalti' OR amount_paisa >= 1000),            -- 04 P4
  CONSTRAINT intents__idem__ck CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),                  -- port-key grammar, 08 A19 P-40
  CONSTRAINT intents__fp__ck CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT intents__urls__ck CHECK (return_url ~ '^https://' AND cancel_url ~ '^https://'
     AND char_length(return_url) <= 2000 AND char_length(cancel_url) <= 2000),
  CONSTRAINT intents__token__ck CHECK (octet_length(callback_token_sha256) = 32),
  CONSTRAINT intents__refs__ck CHECK ((gateway_txn_ref IS NULL OR char_length(gateway_txn_ref) BETWEEN 1 AND 100)
     AND (gateway_secondary_ref IS NULL OR char_length(gateway_secondary_ref) <= 64)
     AND (gateway_payment_url IS NULL OR (gateway_payment_url ~ '^https://' AND char_length(gateway_payment_url) <= 2000))),
  CONSTRAINT intents__initiated_refs__ck CHECK (status = 'created' OR gateway_txn_ref IS NOT NULL),
  CONSTRAINT intents__esewa_ref__ck CHECK (gateway <> 'esewa' OR gateway_txn_ref IS NULL OR gateway_txn_ref = id::text),
  CONSTRAINT intents__raw__ck CHECK (last_gateway_status_raw IS NULL OR char_length(last_gateway_status_raw) <= 64),
  CONSTRAINT intents__method__ck CHECK (verification_method IS NULL OR verification_method IN ('esewa_status_check','khalti_lookup')),
  CONSTRAINT intents__hold__ck CHECK (status <> 'held_for_review' OR hold_reason IS NOT NULL),
  CONSTRAINT intents__failure__ck CHECK (status NOT IN ('failed','expired') OR failure_reason IS NOT NULL),
  CONSTRAINT intents__settled__ck CHECK (status NOT IN ('settled','refunded','partially_refunded')
     OR (settled_at IS NOT NULL AND ledger_entry_id IS NOT NULL AND verified_amount_paisa = amount_paisa AND verification_method IS NOT NULL)),
  CONSTRAINT intents__refunded__ck CHECK (refunded_paisa >= 0 AND refunded_paisa <= amount_paisa
     AND (status <> 'refunded' OR refunded_paisa = amount_paisa)
     AND (status <> 'partially_refunded' OR (refunded_paisa > 0 AND refunded_paisa < amount_paisa))),
  CONSTRAINT intents__note__ck CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  CONSTRAINT intents__actor__ck CHECK (created_actor_type IN ('user','system'))                       -- 08 R8
);
-- hold_reason is kept (history) after held → settled/failed; it is cleared never.
CREATE UNIQUE INDEX intents__tenant_id_order_id__open__p_uq ON payments.intents (tenant_id, order_id)
  WHERE status IN ('created','initiated','pending');
CREATE UNIQUE INDEX intents__tenant_id_idempotency_key__uq ON payments.intents (tenant_id, idempotency_key);
CREATE UNIQUE INDEX intents__tenant_id_gateway_txn__p_uq ON payments.intents (tenant_id, gateway, gateway_txn_ref)
  WHERE gateway_txn_ref IS NOT NULL;
CREATE UNIQUE INDEX intents__callback_token_sha256__uq ON payments.intents (callback_token_sha256);   -- lint exception, CR-C15-004
CREATE INDEX intents__tenant_id_callback_token__idx ON payments.intents (tenant_id, callback_token_sha256);   -- 03-IC §13.3 exception condition
CREATE INDEX intents__tenant_id_status_created__p_idx ON payments.intents (tenant_id, status, created_at)
  WHERE status IN ('created','initiated','pending','held_for_review');
CREATE INDEX intents__tenant_id_settled__p_idx ON payments.intents (tenant_id, settled_at) WHERE settled_at IS NOT NULL;
CREATE INDEX intents__tenant_id_closed__p_idx ON payments.intents (tenant_id, closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX intents__tenant_id_created__idx ON payments.intents (tenant_id, created_at, id);
CREATE INDEX intents__tenant_id_order__idx ON payments.intents (tenant_id, order_id);

CREATE TRIGGER intents__mutable_columns BEFORE UPDATE ON payments.intents FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('status','gateway_txn_ref','gateway_secondary_ref','gateway_payment_url',
    'expires_at','initiated_at','pending_at','settled_at','closed_at','last_checked_at','check_count','consecutive_unknown',
    'last_gateway_status_raw','verified_amount_paisa','verification_method','hold_reason','failure_reason',
    'resolution_reason_code','resolution_note','resolved_by','resolved_at','ledger_entry_id','refunded_paisa',
    'updated_at','updated_by','version');

-- Transition guard (SECURITY INVOKER, search_path ''), = 02-TRD §4.1
CREATE FUNCTION payments.intents_transition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.gateway_txn_ref IS NOT NULL AND NEW.gateway_txn_ref IS DISTINCT FROM OLD.gateway_txn_ref
     OR OLD.gateway_payment_url IS NOT NULL AND NEW.gateway_payment_url IS DISTINCT FROM OLD.gateway_payment_url
     OR OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'payments.intents';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'created' AND NEW.status IN ('initiated','failed'))
    OR (OLD.status IN ('initiated','pending') AND NEW.status IN ('pending','settled','failed','expired','held_for_review'))
    OR (OLD.status = 'held_for_review' AND NEW.status IN ('settled','failed'))
    OR (OLD.status IN ('failed','expired') AND NEW.status = 'held_for_review')
    OR (OLD.status = 'settled' AND NEW.status IN ('partially_refunded','refunded'))
    OR (OLD.status = 'partially_refunded' AND NEW.status = 'refunded')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition', DETAIL = 'payments.intents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER intents__transition_guard BEFORE UPDATE ON payments.intents FOR EACH ROW
  EXECUTE FUNCTION payments.intents_transition_guard();
-- API maps message 'invalid_transition' → 409 payments.intent_invalid_transition.

-- ===================================================== append-only logs
CREATE TABLE payments.intent_transitions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, intent_id uuid NOT NULL,
  from_status text, to_status text NOT NULL,
  cause text NOT NULL, reason_code text, actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT intent_transitions__pk PRIMARY KEY (id),
  CONSTRAINT intent_transitions__intent__fk FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.intents (tenant_id, id),
  CONSTRAINT intent_transitions__cause__ck CHECK (cause IN ('create','callback','poll','verify_call','recheck','resolve',
     'cancel','reconciliation','refund','sweep')),
  CONSTRAINT intent_transitions__actor__ck CHECK (actor_type IN ('user','system'))                    -- 08 R8
);
CREATE INDEX intent_transitions__tenant_id_intent__idx ON payments.intent_transitions (tenant_id, intent_id, created_at);

CREATE TABLE payments.gateway_calls (
  id uuid NOT NULL, tenant_id uuid NOT NULL, intent_id uuid, refund_id uuid, merchant_account_id uuid,
  gateway text NOT NULL, operation text NOT NULL, attempt integer NOT NULL DEFAULT 1,
  http_status integer, outcome text NOT NULL, gateway_status_raw text,
  response_redacted jsonb,                                                 -- allowlisted keys only (TRD §7.6); P1
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT gateway_calls__pk PRIMARY KEY (id),
  CONSTRAINT gateway_calls__intent__fk FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.intents (tenant_id, id),
  CONSTRAINT gateway_calls__merchant__fk FOREIGN KEY (tenant_id, merchant_account_id) REFERENCES payments.merchant_accounts (tenant_id, id),
  -- gateway_calls__refund__fk is added after payments.refunds exists (below)
  CONSTRAINT gateway_calls__gateway__ck CHECK (gateway IN ('esewa','khalti','fonepay')),
  CONSTRAINT gateway_calls__op__ck CHECK (operation IN ('khalti_initiate','khalti_lookup','esewa_status','khalti_refund','credential_test')),
  CONSTRAINT gateway_calls__outcome__ck CHECK (outcome IN ('answer','service_unavailable','timeout','network_error','http_error',
     'auth_error','not_found','invalid_response')),
  CONSTRAINT gateway_calls__raw__ck CHECK (gateway_status_raw IS NULL OR char_length(gateway_status_raw) <= 64),
  CONSTRAINT gateway_calls__size__ck CHECK (response_redacted IS NULL OR octet_length(response_redacted::text) <= 2048)
);
CREATE INDEX gateway_calls__tenant_id_intent__idx ON payments.gateway_calls (tenant_id, intent_id, created_at);
CREATE INDEX gateway_calls__tenant_id_refund__p_idx ON payments.gateway_calls (tenant_id, refund_id, created_at) WHERE refund_id IS NOT NULL;

CREATE TABLE payments.callbacks (
  id uuid NOT NULL, tenant_id uuid NOT NULL, intent_id uuid NOT NULL,
  gateway text NOT NULL, kind text NOT NULL,
  query_redacted jsonb,                                                    -- allowlisted keys; Khalti 'mobile' never stored; P1
  signature_valid boolean, outcome_code text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT callbacks__pk PRIMARY KEY (id),
  CONSTRAINT callbacks__intent__fk FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.intents (tenant_id, id),
  CONSTRAINT callbacks__kind__ck CHECK (kind IN ('esewa_success','esewa_failure','khalti_return','launch')),   -- 'launch' = P30 (02-TRD §6.3a)
  CONSTRAINT callbacks__outcome__ck CHECK (outcome_code IN ('ok','payments.signature_invalid','payments.callback_mismatch',
     'payments.callback_stale','rate_limited')),                                        -- 'rate_limited' = throttled hit (02-TRD §6.3 step 2)
  CONSTRAINT callbacks__no_mobile__ck CHECK (query_redacted IS NULL OR NOT (query_redacted ? 'mobile')),
  CONSTRAINT callbacks__size__ck CHECK (query_redacted IS NULL OR octet_length(query_redacted::text) <= 6144)
);
CREATE INDEX callbacks__tenant_id_intent__idx ON payments.callbacks (tenant_id, intent_id, received_at);

-- ===================================================== refunds
CREATE TABLE payments.refunds (
  id uuid NOT NULL, tenant_id uuid NOT NULL, intent_id uuid NOT NULL, order_id uuid NOT NULL, centre_id uuid NOT NULL,
  gateway text NOT NULL, mode text NOT NULL, status text NOT NULL DEFAULT 'pending_approval',
  amount_paisa bigint NOT NULL, reason_code text NOT NULL, reason_text text,
  idempotency_key text NOT NULL,                                           -- = 'refund:' || id, set at insert; the port refund() call presents it (02-TRD §6.6)
  requested_by_membership_id uuid NOT NULL, requested_at timestamptz NOT NULL,
  approved_by_membership_id uuid, approved_at timestamptz,
  rejected_by_membership_id uuid, rejected_at timestamptz, reject_reason_code text, decision_note text,
  gateway_refund_reference text, refunded_on date, confirmed_by_membership_id uuid, confirmed_at timestamptz,
  completed_at timestamptz, ledger_entry_id uuid,                          -- no FK into billing
  failure_reason text,                                                     -- code in refund_fail_reasons (P11b) [CONV]
  failure_note text,                                                       -- P11b note ≤ 500 (actor = updated_by + row audit) [CONV]
  held_reason text,                                                        -- code in refund_hold_reasons (review m#20)
  last_checked_at timestamptz,                                             -- last gateway refund check (P7b min interval) [CONV]
  unconfirmed_run_count integer NOT NULL DEFAULT 0,                        -- reconciliation runs that did not see the refund (review m#20)
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT refunds__pk PRIMARY KEY (id),
  CONSTRAINT refunds__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT refunds__intent__fk FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.intents (tenant_id, id),
  CONSTRAINT refunds__mode__ck CHECK (mode IN ('manual','api') AND (mode = 'manual' OR gateway = 'khalti')),
  CONSTRAINT refunds__status__ck CHECK (status IN ('pending_approval','approved','rejected','requested','held_for_review','completed','failed')),
  CONSTRAINT refunds__amount__ck CHECK (amount_paisa > 0),
  CONSTRAINT refunds__text__ck CHECK ((reason_text IS NULL OR char_length(reason_text) <= 500)
     AND (decision_note IS NULL OR char_length(decision_note) <= 500)
     AND (failure_note IS NULL OR char_length(failure_note) <= 500)),
  CONSTRAINT refunds__idem__ck CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),                  -- port-key grammar, 08 A19 P-40 (review m#17)
  CONSTRAINT refunds__ref__ck CHECK (gateway_refund_reference IS NULL OR gateway_refund_reference ~ '^[A-Za-z0-9_.:/-]{1,100}$'),
  CONSTRAINT refunds__approved__ck CHECK (status IN ('pending_approval','rejected') OR approved_by_membership_id IS NOT NULL),
  CONSTRAINT refunds__completed__ck CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND ledger_entry_id IS NOT NULL)),
  CONSTRAINT refunds__held__ck CHECK ((held_reason IS NULL OR held_reason IN ('refund_not_visible','refund_kind_mismatch','api_outcome_unknown'))
     AND (status <> 'held_for_review' OR held_reason IS NOT NULL)),
  CONSTRAINT refunds__failed__ck CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
  CONSTRAINT refunds__failure_code__ck CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT refunds__unconfirmed__ck CHECK (unconfirmed_run_count >= 0)
  -- two-person rule (approver ≠ requester above threshold) is enforced in the service (threshold is tenant data)
);
CREATE UNIQUE INDEX refunds__tenant_id_intent_inflight__p_uq ON payments.refunds (tenant_id, intent_id)
  WHERE status IN ('pending_approval','approved','requested','held_for_review');
CREATE UNIQUE INDEX refunds__tenant_id_idempotency_key__uq ON payments.refunds (tenant_id, idempotency_key);
CREATE INDEX refunds__tenant_id_status_created__idx ON payments.refunds (tenant_id, status, created_at);
CREATE INDEX refunds__tenant_id_intent__idx ON payments.refunds (tenant_id, intent_id, created_at);
CREATE TRIGGER refunds__mutable_columns BEFORE UPDATE ON payments.refunds FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('status','approved_by_membership_id','approved_at','rejected_by_membership_id',
    'rejected_at','reject_reason_code','decision_note','gateway_refund_reference','refunded_on','confirmed_by_membership_id',
    'confirmed_at','completed_at','ledger_entry_id','failure_reason','failure_note','held_reason',
    'last_checked_at','unconfirmed_run_count','updated_at','updated_by','version');

-- Transition guard (SECURITY INVOKER, search_path ''), = 02-TRD §4.2 R1–R8
CREATE FUNCTION payments.refunds_transition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending_approval' AND NEW.status IN ('rejected','approved'))
    OR (OLD.status = 'approved'         AND NEW.status = 'requested')
    OR (OLD.status = 'requested'        AND NEW.status IN ('completed','held_for_review','failed'))
    OR (OLD.status = 'held_for_review'  AND NEW.status IN ('completed','failed'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition', DETAIL = 'payments.refunds';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds__transition_guard BEFORE UPDATE ON payments.refunds FOR EACH ROW
  EXECUTE FUNCTION payments.refunds_transition_guard();
-- API maps message 'invalid_transition' on refunds → 409 payments.refund_not_allowed.

ALTER TABLE payments.gateway_calls ADD CONSTRAINT gateway_calls__refund__fk
  FOREIGN KEY (tenant_id, refund_id) REFERENCES payments.refunds (tenant_id, id);           -- review m#22

-- ===================================================== reconciliation
CREATE TABLE payments.reconciliation_runs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, business_date date NOT NULL,
  trigger text NOT NULL, status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL, finished_at timestamptz,
  checked_count integer NOT NULL DEFAULT 0, ok_count integer NOT NULL DEFAULT 0,
  findings_count integer NOT NULL DEFAULT 0, critical_count integer NOT NULL DEFAULT 0,
  error_code text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT reconciliation_runs__pk PRIMARY KEY (id),
  CONSTRAINT reconciliation_runs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reconciliation_runs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT reconciliation_runs__trigger__ck CHECK (trigger IN ('cron','manual')),
  CONSTRAINT reconciliation_runs__status__ck CHECK (status IN ('running','completed','failed')),
  CONSTRAINT reconciliation_runs__counts__ck CHECK (checked_count >= 0 AND ok_count >= 0 AND findings_count >= 0 AND critical_count >= 0)
);
CREATE UNIQUE INDEX reconciliation_runs__tenant_id_running__p_uq ON payments.reconciliation_runs (tenant_id) WHERE status = 'running';
CREATE INDEX reconciliation_runs__tenant_id_date__idx ON payments.reconciliation_runs (tenant_id, business_date DESC);

CREATE TABLE payments.reconciliation_findings (
  id uuid NOT NULL, tenant_id uuid NOT NULL, run_id uuid NOT NULL, intent_id uuid, refund_id uuid,
  kind text NOT NULL, severity text NOT NULL,
  our_status text, gateway_status_raw text, our_amount_paisa bigint, gateway_amount_paisa bigint,
  auto_action text NOT NULL DEFAULT 'none',
  status text NOT NULL DEFAULT 'open', resolution_code text, note text, resolved_by uuid, resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT reconciliation_findings__pk PRIMARY KEY (id),
  CONSTRAINT reconciliation_findings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reconciliation_findings__run__fk FOREIGN KEY (tenant_id, run_id) REFERENCES payments.reconciliation_runs (tenant_id, id),
  CONSTRAINT reconciliation_findings__intent__fk FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.intents (tenant_id, id),
  CONSTRAINT reconciliation_findings__refund__fk FOREIGN KEY (tenant_id, refund_id) REFERENCES payments.refunds (tenant_id, id),
  CONSTRAINT reconciliation_findings__subject__ck CHECK (intent_id IS NOT NULL OR refund_id IS NOT NULL),
  CONSTRAINT reconciliation_findings__severity__ck CHECK (severity IN ('info','warning','critical')),
  CONSTRAINT reconciliation_findings__auto__ck CHECK (auto_action IN ('none','settled','held','ledger_repaired')),
  CONSTRAINT reconciliation_findings__status__ck CHECK (status IN ('open','resolved')
     AND (status = 'open' OR (resolution_code IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))),
  CONSTRAINT reconciliation_findings__note__ck CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX reconciliation_findings__tenant_id_status__idx ON payments.reconciliation_findings (tenant_id, status, severity, created_at);
CREATE INDEX reconciliation_findings__tenant_id_run__idx ON payments.reconciliation_findings (tenant_id, run_id);
CREATE TRIGGER reconciliation_findings__mutable_columns BEFORE UPDATE ON payments.reconciliation_findings FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('status','resolution_code','note','resolved_by','resolved_at','updated_at','updated_by','version');

-- ===================================================== static QR worksheet (04 P5 interim)
CREATE TABLE payments.static_qr_reconciliations (
  id uuid NOT NULL, tenant_id uuid NOT NULL, business_date date NOT NULL, centre_id uuid,
  system_entries integer NOT NULL, system_total_paisa bigint NOT NULL,
  statement_total_paisa bigint NOT NULL, difference_paisa bigint GENERATED ALWAYS AS (statement_total_paisa - system_total_paisa) STORED,
  statement_reference text NOT NULL, status text NOT NULL, note text,
  reconciled_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT static_qr__pk PRIMARY KEY (id),
  CONSTRAINT static_qr__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT static_qr__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT static_qr__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT static_qr__amounts__ck CHECK (system_entries >= 0 AND system_total_paisa >= 0 AND statement_total_paisa >= 0),
  CONSTRAINT static_qr__ref__ck CHECK (char_length(statement_reference) BETWEEN 1 AND 100),
  CONSTRAINT static_qr__status__ck CHECK (status IN ('matched','accepted_with_difference')
     AND ((status = 'matched') = (statement_total_paisa = system_total_paisa))
     AND (status = 'matched' OR note IS NOT NULL)),
  CONSTRAINT static_qr__note__ck CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE UNIQUE INDEX static_qr__tenant_id_date_centre__p_uq ON payments.static_qr_reconciliations (tenant_id, business_date, centre_id) WHERE centre_id IS NOT NULL;
CREATE UNIQUE INDEX static_qr__tenant_id_date_all__p_uq ON payments.static_qr_reconciliations (tenant_id, business_date) WHERE centre_id IS NULL;
CREATE TRIGGER static_qr__mutable_columns BEFORE UPDATE ON payments.static_qr_reconciliations FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('is_active','updated_at','updated_by','version');   -- worksheets are not edited

-- ===================================================== C0 transcription (C0 05-SCHEMA §9 rule 1): tenant FK + UNIQUE (tenant_id, id) where §6 omits them
ALTER TABLE payments.refunds ADD CONSTRAINT refunds__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE payments.intent_transitions ADD CONSTRAINT intent_transitions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE payments.gateway_calls ADD CONSTRAINT gateway_calls__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE payments.callbacks ADD CONSTRAINT callbacks__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE payments.reconciliation_findings ADD CONSTRAINT reconciliation_findings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE payments.intent_transitions ADD CONSTRAINT intent_transitions__tenant_id_id__uq UNIQUE (tenant_id, id);
ALTER TABLE payments.gateway_calls ADD CONSTRAINT gateway_calls__tenant_id_id__uq UNIQUE (tenant_id, id);
ALTER TABLE payments.callbacks ADD CONSTRAINT callbacks__tenant_id_id__uq UNIQUE (tenant_id, id);

-- ===================================================== RLS (template T, 08 A17 P-16; every policy written out)
-- pred_t := tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
-- S I U: settings, merchant_accounts, intents, refunds, reconciliation_runs, reconciliation_findings, static_qr_reconciliations, cs_reasons
-- S I  : intent_transitions, gateway_calls, callbacks (append-only, class A)
ALTER TABLE payments.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings__select__tenant ON payments.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON payments.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON payments.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.merchant_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.merchant_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_accounts__select__tenant ON payments.merchant_accounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY merchant_accounts__insert__tenant ON payments.merchant_accounts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY merchant_accounts__update__tenant ON payments.merchant_accounts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.intents FORCE ROW LEVEL SECURITY;
CREATE POLICY intents__select__tenant ON payments.intents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY intents__insert__tenant ON payments.intents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY intents__update__tenant ON payments.intents FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY refunds__select__tenant ON payments.refunds FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY refunds__insert__tenant ON payments.refunds FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY refunds__update__tenant ON payments.refunds FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.reconciliation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_runs__select__tenant ON payments.reconciliation_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reconciliation_runs__insert__tenant ON payments.reconciliation_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reconciliation_runs__update__tenant ON payments.reconciliation_runs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.reconciliation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.reconciliation_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_findings__select__tenant ON payments.reconciliation_findings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reconciliation_findings__insert__tenant ON payments.reconciliation_findings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reconciliation_findings__update__tenant ON payments.reconciliation_findings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.static_qr_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.static_qr_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY static_qr_reconciliations__select__tenant ON payments.static_qr_reconciliations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY static_qr_reconciliations__insert__tenant ON payments.static_qr_reconciliations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY static_qr_reconciliations__update__tenant ON payments.static_qr_reconciliations FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.cs_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.cs_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_reasons__select__tenant ON payments.cs_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__insert__tenant ON payments.cs_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__update__tenant ON payments.cs_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.intent_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.intent_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY intent_transitions__select__tenant ON payments.intent_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY intent_transitions__insert__tenant ON payments.intent_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.gateway_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.gateway_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY gateway_calls__select__tenant ON payments.gateway_calls FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY gateway_calls__insert__tenant ON payments.gateway_calls FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
ALTER TABLE payments.callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments.callbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY callbacks__select__tenant ON payments.callbacks FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY callbacks__insert__tenant ON payments.callbacks FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
-- No DELETE policy on any table (default deny).
GRANT SELECT, INSERT, UPDATE ON payments.settings, payments.merchant_accounts, payments.intents, payments.refunds,
  payments.reconciliation_runs, payments.reconciliation_findings, payments.static_qr_reconciliations, payments.cs_reasons TO lims_app;
GRANT SELECT, INSERT ON payments.intent_transitions, payments.gateway_calls, payments.callbacks TO lims_app;
GRANT SELECT ON payments.g_cs_reasons TO lims_app;
-- Secret columns hold ciphertext only; the KEK never enters the DB (02-TRD §6.9). Mappers never select secret_* except credentials.ts.

-- ===================================================== row audit (C0 app.tg_row_audit; M and C tables, §1)
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON payments.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER intents__audit AFTER INSERT OR UPDATE OR DELETE ON payments.intents FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER refunds__audit AFTER INSERT OR UPDATE OR DELETE ON payments.refunds FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER reconciliation_runs__audit AFTER INSERT OR UPDATE OR DELETE ON payments.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER reconciliation_findings__audit AFTER INSERT OR UPDATE OR DELETE ON payments.reconciliation_findings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER static_qr_reconciliations__audit AFTER INSERT OR UPDATE OR DELETE ON payments.static_qr_reconciliations FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON payments.cs_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER merchant_accounts__audit AFTER INSERT OR UPDATE OR DELETE ON payments.merchant_accounts FOR EACH ROW
  EXECUTE FUNCTION app.tg_row_audit('secret_ciphertext','secret_nonce','secret_auth_tag');   -- CR-C15-013

-- ===================================================== callback lookup (CR-C15-004; 08 A19 P-41; A12.1 pre-tenant GUC)
CREATE POLICY intents__select__owner_only ON payments.intents FOR SELECT TO lims_owner
  USING (callback_token_sha256 = decode(current_setting('app.pre_payments_callback_token_sha256', true), 'hex'));
CREATE FUNCTION app.payments_resolve_callback_token(p_token_sha256 bytea)
RETURNS TABLE (tenant_id uuid, intent_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 THEN RETURN; END IF;
  PERFORM set_config('app.pre_payments_callback_token_sha256', encode(p_token_sha256, 'hex'), true);
  RETURN QUERY SELECT i.tenant_id, i.id FROM payments.intents i
    WHERE i.callback_token_sha256 = p_token_sha256
      AND i.created_at > now() - interval '30 days';               -- fixed acceptance window [CONV] (review m#23)
  PERFORM set_config('app.pre_payments_callback_token_sha256', '', true);
END $$;
ALTER FUNCTION app.payments_resolve_callback_token(bytea) OWNER TO lims_owner;
REVOKE ALL ON FUNCTION app.payments_resolve_callback_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payments_resolve_callback_token(bytea) TO lims_api;
-- An empty or unset GUC decodes to '' / NULL, which matches no 32-byte hash, so lims_owner sees no intents outside the call.

-- ===================== §5 / §8 seeds: payments.g_cs_reasons (55 rows; displays [CONV] = code humanised) =====================
INSERT INTO payments.g_cs_reasons (id, set_name, code, display, requires_text, sort_order) VALUES
  ('019a0000-c015-7000-8001-000000000001', 'hold_reasons', 'amount_mismatch', 'Amount mismatch', false, 10),
  ('019a0000-c015-7000-8001-000000000002', 'hold_reasons', 'gateway_ambiguous', 'Gateway ambiguous', false, 20),
  ('019a0000-c015-7000-8001-000000000003', 'hold_reasons', 'gateway_pending', 'Gateway pending', false, 30),
  ('019a0000-c015-7000-8001-000000000004', 'hold_reasons', 'gateway_pending_after_expiry', 'Gateway pending after expiry', false, 40),
  ('019a0000-c015-7000-8001-000000000005', 'hold_reasons', 'gateway_initiated_after_expiry', 'Gateway initiated after expiry', false, 50),
  ('019a0000-c015-7000-8001-000000000006', 'hold_reasons', 'gateway_refunded_before_settle', 'Gateway refunded before settle', false, 60),
  ('019a0000-c015-7000-8001-000000000007', 'hold_reasons', 'gateway_status_unknown', 'Gateway status unknown', false, 70),
  ('019a0000-c015-7000-8001-000000000008', 'hold_reasons', 'gateway_not_found', 'Gateway not found', false, 80),
  ('019a0000-c015-7000-8001-000000000009', 'hold_reasons', 'gateway_identity_mismatch', 'Gateway identity mismatch', false, 90),
  ('019a0000-c015-7000-8001-000000000010', 'hold_reasons', 'exceeds_due', 'Exceeds due', false, 100),
  ('019a0000-c015-7000-8001-000000000011', 'hold_reasons', 'late_payment_found', 'Late payment found', false, 110),
  ('019a0000-c015-7000-8002-000000000001', 'failure_reasons', 'gateway_cancelled', 'Gateway cancelled', false, 10),
  ('019a0000-c015-7000-8002-000000000002', 'failure_reasons', 'gateway_expired', 'Gateway expired', false, 20),
  ('019a0000-c015-7000-8002-000000000003', 'failure_reasons', 'abandoned', 'Abandoned', false, 30),
  ('019a0000-c015-7000-8002-000000000004', 'failure_reasons', 'resolved_failed', 'Resolved failed', false, 40),
  ('019a0000-c015-7000-8003-000000000001', 'cancel_reasons', 'patient_changed_method', 'Patient changed method', false, 10),
  ('019a0000-c015-7000-8003-000000000002', 'cancel_reasons', 'patient_left', 'Patient left', false, 20),
  ('019a0000-c015-7000-8003-000000000003', 'cancel_reasons', 'wrong_amount', 'Wrong amount', false, 30),
  ('019a0000-c015-7000-8003-000000000004', 'cancel_reasons', 'staff_error', 'Staff error', false, 40),
  ('019a0000-c015-7000-8003-000000000005', 'cancel_reasons', 'other', 'Other', true, 50),
  ('019a0000-c015-7000-8004-000000000001', 'resolution_reasons', 'gateway_confirmed_paid', 'Gateway confirmed paid', false, 10),
  ('019a0000-c015-7000-8004-000000000002', 'resolution_reasons', 'gateway_confirmed_unpaid', 'Gateway confirmed unpaid', false, 20),
  ('019a0000-c015-7000-8004-000000000003', 'resolution_reasons', 'provider_support_confirmed', 'Provider support confirmed', false, 30),
  ('019a0000-c015-7000-8004-000000000004', 'resolution_reasons', 'duplicate_attempt', 'Duplicate attempt', false, 40),
  ('019a0000-c015-7000-8004-000000000005', 'resolution_reasons', 'other', 'Other', true, 50),
  ('019a0000-c015-7000-8005-000000000001', 'refund_reasons', 'test_cancelled', 'Test cancelled', false, 10),
  ('019a0000-c015-7000-8005-000000000002', 'refund_reasons', 'overpayment', 'Overpayment', false, 20),
  ('019a0000-c015-7000-8005-000000000003', 'refund_reasons', 'service_not_provided', 'Service not provided', false, 30),
  ('019a0000-c015-7000-8005-000000000004', 'refund_reasons', 'duplicate_payment', 'Duplicate payment', false, 40),
  ('019a0000-c015-7000-8005-000000000005', 'refund_reasons', 'other', 'Other', true, 50),
  ('019a0000-c015-7000-8006-000000000001', 'refund_reject_reasons', 'not_eligible', 'Not eligible', false, 10),
  ('019a0000-c015-7000-8006-000000000002', 'refund_reject_reasons', 'wrong_amount', 'Wrong amount', false, 20),
  ('019a0000-c015-7000-8006-000000000003', 'refund_reject_reasons', 'duplicate_request', 'Duplicate request', false, 30),
  ('019a0000-c015-7000-8006-000000000004', 'refund_reject_reasons', 'other', 'Other', true, 40),
  ('019a0000-c015-7000-8007-000000000001', 'refund_fail_reasons', 'gateway_confirmed_not_refunded', 'Gateway confirmed not refunded', false, 10),
  ('019a0000-c015-7000-8007-000000000002', 'refund_fail_reasons', 'refund_rejected_by_provider', 'Refund rejected by provider', false, 20),
  ('019a0000-c015-7000-8007-000000000003', 'refund_fail_reasons', 'other', 'Other', true, 30),
  ('019a0000-c015-7000-8008-000000000001', 'refund_hold_reasons', 'refund_not_visible', 'Refund not visible', false, 10),
  ('019a0000-c015-7000-8008-000000000002', 'refund_hold_reasons', 'refund_kind_mismatch', 'Refund kind mismatch', false, 20),
  ('019a0000-c015-7000-8008-000000000003', 'refund_hold_reasons', 'api_outcome_unknown', 'Api outcome unknown', false, 30),
  ('019a0000-c015-7000-8009-000000000001', 'finding_kinds', 'missed_settlement', 'Missed settlement', false, 10),
  ('019a0000-c015-7000-8009-000000000002', 'finding_kinds', 'still_held', 'Still held', false, 20),
  ('019a0000-c015-7000-8009-000000000003', 'finding_kinds', 'late_payment_found', 'Late payment found', false, 30),
  ('019a0000-c015-7000-8009-000000000004', 'finding_kinds', 'status_divergence', 'Status divergence', false, 40),
  ('019a0000-c015-7000-8009-000000000005', 'finding_kinds', 'gateway_refund_unrecorded', 'Gateway refund unrecorded', false, 50),
  ('019a0000-c015-7000-8009-000000000006', 'finding_kinds', 'amount_mismatch', 'Amount mismatch', false, 60),
  ('019a0000-c015-7000-8009-000000000007', 'finding_kinds', 'ledger_entry_missing', 'Ledger entry missing', false, 70),
  ('019a0000-c015-7000-8009-000000000008', 'finding_kinds', 'refund_unconfirmed', 'Refund unconfirmed', false, 80),
  ('019a0000-c015-7000-8009-000000000009', 'finding_kinds', 'gateway_unreachable', 'Gateway unreachable', false, 90),
  ('019a0000-c015-7000-8010-000000000001', 'finding_resolutions', 'confirmed_ok', 'Confirmed ok', false, 10),
  ('019a0000-c015-7000-8010-000000000002', 'finding_resolutions', 'refunded_outside_system_recorded', 'Refunded outside system recorded', false, 20),
  ('019a0000-c015-7000-8010-000000000003', 'finding_resolutions', 'escalated_to_provider', 'Escalated to provider', false, 30),
  ('019a0000-c015-7000-8010-000000000004', 'finding_resolutions', 'ledger_corrected_in_billing', 'Ledger corrected in billing', false, 40),
  ('019a0000-c015-7000-8010-000000000005', 'finding_resolutions', 'false_positive', 'False positive', false, 50),
  ('019a0000-c015-7000-8010-000000000006', 'finding_resolutions', 'other', 'Other', true, 60)
ON CONFLICT (set_name, code) DO NOTHING;
