# ADR-UI-NAV-001: Retention of Approved Five-Tab Navigation (v1.0 Baseline)

## Status
ACCEPTED / ENFORCED

## Context
Source B (`MyHealthNow_v1.1_Healthians_layout_wireframes(1).pdf`) proposed an alternative bottom navigation structure consisting of five floating tabs:
1. Home
2. Call
3. Community
4. MyCare
5. Profile

Under this proposed v1.1 layout:
- "All Tests" was moved behind a search entry on Home.
- "Bookings" was demoted from primary navigation.
- "Reports" was moved under Profile.
- "Community" and "MyCare" were introduced as primary tabs, despite being explicitly marked as Phase 2 features requiring clinical oversight, doctor staffing, content moderation, and legal approvals.

Conversely, the previously approved and frozen v1.0 baseline specifies the canonical patient workflow navigation:
1. Home (mhnTabHome)
2. All Tests (mhnTabTests)
3. Bookings (mhnTabBookings)
4. Reports (mhnTabReports)
5. Profile (mhnTabProfile)

In addition, the current implementation in `mhn_shell.dart` was provisionally configured with 4 tabs (Home, Contact, All Tests, Profile), omitting direct first-class tab access to Bookings and Reports.

## Decision
1. **Retain and enforce the approved 5-tab navigation** (Home, All Tests, Bookings, Reports, Profile) in the active patient application shell.
2. Ensure direct, immediate discoverability for critical patient clinical actions: browsing the clinical catalog, tracking active/upcoming specimen bookings, and accessing verified lab reports.
3. Keep "Contact / Help" accessible via header actions or Profile, without displacing core booking and reporting workflows.
4. Adopt v1.1's approved visual design system (typography, card aesthetics, spacing, badge tokens) within the 5-tab structure.
5. The proposed v1.1 navigation (with Community and MyCare) remains strictly gated behind a product-owner decision and will not be activated until clinical, moderation, and legal prerequisites are signed off.
