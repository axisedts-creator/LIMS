# ADR-SCOPE-001: Launch Scope Boundaries and Feature Gating

## Status
ACCEPTED / ENFORCED

## Context
Analysis of Source B wireframes reveals speculative marketing and exploratory placeholders that have not received clinical, regulatory, or business approval. A clear boundary between core production capability and gated/excluded features is required.

## Decision

### 1. Strictly Excluded Features
- **Paid Memberships, VIP Tiers, and Subscriptions**: Completely excluded from the patient app UI. Any references to premium discounts or subscription upsells in the UI must be suppressed. (Operational tenant/identity membership in backend models is preserved without paid-tier connotations).
- **Gamification and Speculative Commerce**: Lucky Draw, My Wallet, and Refer & Earn are unapproved placeholders. No speculative points, reward currencies, or lottery mechanics will be exposed or simulated.
- **Corporate Eligibility Verification**: Retained as an unlinked specification stub (`NOT_SPECIFIED`).
- **Create Your Own Package**: Marked `NOT_SPECIFIED` pending an approved clinical pricing engine.

### 2. Gated Phase-2 Features (Held Pending Formal Review)
- **Community Forum / Ask an Expert / Discussions (H04, H05, H06)**: Gated (`PHASE2_HOLD`). Cannot launch without medical moderation, clinician credentialing, audit retention, and liability protections.
- **MyCare / HealthKarma / AI Diagnostics / Diet Plans (H07)**: Gated (`PHASE2_HOLD`). Automated diagnosis or clinical recommendations without certified medical device clearance or clinician review are strictly prohibited.

### 3. Core Approved Scope (Phase-1 Target)
- Complete patient authentication via verified phone OTP.
- Authoritative clinical catalog (tests & packages) with server-calculated pricing.
- One patient per booking constraint (self or registered family member).
- Robust address validation, slot selection (Asia/Kathmandu timezone), and booking lifecycle.
- Phlebotomist dispatch tracking with genuine location/status states (no simulated live GPS).
- Barcode-driven specimen custody and lab processing stages.
- Secure, authorized access to finalized clinical reports and signed PDF downloads.
- Direct customer support and official contact channels.
