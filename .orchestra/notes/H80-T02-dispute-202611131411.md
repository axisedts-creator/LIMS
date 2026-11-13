# H80-T02 dispute (writer)
Test: `drivers-truth-h80e.test.ts:106` (`optionsSchema` > "accepts {} ... rejects unknown keys"): `valid({ bogus: 1 })` expected false, got true.
Cause: test line 84 builds the validator with `{ coerceTypes:false, strict:false, allErrors:true }` only. `AjvCompiler()` defaults to `removeAdditional: true`, which silently strips unknown keys when `additionalProperties:false`, so they never fail. Core uses `AJV_OPTIONS` (`core/openapi.ts:70`, `removeAdditional:false`); sibling tests (`attachments.contract.test.ts:10`, `agents.contract.ts:15`) spread it.
Schema is correct (`additionalProperties:false`, asserted by the previous test at line 88 which passes).
Fix wanted (tester): `customOptions: { ...AJV_OPTIONS, coerceTypes: false, strict: false }` (or add `removeAdditional: false`).
Status: 119/120 pass in drivers-truth-h80e + drivers-registry + drivers-golden; only this one fails. Impl note not written; waiting on ruling.
