Title: CR-C16-T-L6: Profile wire needs a version for If-Match on E18/E19; "link earlier visits" flag on E16; disabled option on LimsSegmentedControl
From chunk: C16            To owner: C0-0C (items 1, 2: contracts/openapi/engagement.yaml) | C0-0D (item 3: packages/ui-flutter)
Type: api (1, 2) | ui-kit (3)
Blocking? yes — T-L6 (06-IMPLEMENTATION-PLAN row T-L6): Change relationship (E18) and Remove (E19) cannot work; the A9 widget test "Myself segment is RENDERED disabled" fails.

Problem:
1. E18 updateMyProfile (engagement.yaml:987) and E19 removeMyProfile (:1080) reference `_common.yaml#/components/parameters/IfMatch`, which is `required: true` (_common.yaml:92); 02-TRD.md:447-448 also lists If-Match. The `Profile` schema returned by E13 has no `version` (or ETag), so the app has no value to send. A compliant server answers 428 `common.precondition_required` to every call. Serves US-EN-06.4 (remove) and the change-relationship action.
2. US-EN-05.2 "link earlier visits with a code" has no wire flag on E16 (noted in T-L4). Not built.
3. 04-UI-UX A9: "Myself (disabled if a `self` profile exists)". `LimsSegmentedControl` (packages/ui-flutter/lib/src/cr16_widgets.dart:100) has no way to disable one option; `ButtonSegment.enabled` is never set. Feature code may not fork the kit (LD-140), so today Myself only ignores the tap.

Proposed change (exact):
1. Option A (preferred): add `version: {type: integer, minimum: 1}` (required) to `Profile` in engagement.yaml; app sends `If-Match: "<version>"` on E18/E19. Option B: make IfMatch optional on E18/E19 (last-write-wins).
2. Lead/C0-0C to name the E16 request field (e.g. optional boolean) or rule US-EN-05.2 out of scope for E16. No name invented here.
3. Add optional `enabled` to the option record: `List<({T value, String label, bool enabled})>` (or a separate `Set<T> disabled = const {}` param, backward compatible) mapped to `ButtonSegment<T>(enabled: ...)`.

Backward compatible? 1A additive response field — yes. 1B relaxes a requirement — yes. 2 additive optional field — yes. 3 with `disabled` param defaulting to empty — yes.
Tenant/security impact: none; no new PHI field, no RLS change, no new public surface.
IRD/regulatory impact: n/a.
Alternatives considered: sending a fake If-Match (`"1"`) — rejected, defeats optimistic locking; building a local segmented control in features/profiles — rejected, LD-140.
Tests that will prove it: test/features/profiles/profiles_api_wire_test.dart (If-Match `^"[1-9][0-9]*"$` from Profile.version); a9_register_screen_test.dart "Myself segment is RENDERED disabled"; integration_test/profiles_prism_test.dart E18/E19 cases (currently skipped).
