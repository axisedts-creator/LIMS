# T2 impl (writer)
Files: services/api/src/modules/identity/domain/{password-policy,numbering-pattern,settings.ranges,permission-set}.ts. Tests: 4 files, 203/203 pass (vitest 5.1.0).
[CONV] numbering max length checked statically with MIN token widths: {yy} 2, {fy} 6 (`082/83`), {fyl} 7 (`2082/83`) per 03-IC §9.3; {prefix} 0, {branch}/{centre} 1 (actual values vary 0–8 / 1–16). Renderer must re-check the real rendered length.
[CONV] barcode also rejects {branch}/{centre}/{fy}/{fyl} (C5 02-TRD §4.2 grammar; {fy} renders '/', outside [A-Z0-9]).
[CONV] permission-set registry param defaults to DEFAULT_REGISTRY built from contracts/ports/generated/permissions.ts (relative import, as other modules do); fixedActorPermissions/supportPermissions use the generated FIXED_ACTOR_PERMISSIONS / 02-TRD §7.4 lists. Unknown scope/actor/variant -> [].
settings.ranges also checks enums (timezone=Asia/Kathmandu only, support_access_mode, calendar_display, westgard_mode, letterhead_default) with identity.setting_out_of_range.
Open: tsc reports pre-existing TS5097 in packages/shared-ts/src/bsdate (not C2). Full api suite (DB-backed) not run. pending_* numbering patterns / billing_live_on left to T16.
