# T0D-04 impl (writer)
- Files: `core/errors.ts` (new: LimsError, isLimsError, toProblem, genReqId, sendProblem, installErrorHandlers), `core/bootstrap.ts` (genReqId, frameworkErrors, installErrorHandlers), `core/openapi.ts` (ResponseContractError extends LimsError; stage-12 hook passes core-built Problems; declared problem+json response schemas dropped so the serializer cannot strip them), `core/auth/errors.ts` (AuthError extends LimsError, keeps 401 fallback).
- [CONV] Fastify FST_* errors mapped by status: 400 validation_failed, 404 not_found, 405 method_not_allowed, 413 payload_too_large, 415 unsupported_media_type; anything else not a registered LimsError -> 500 common.internal.
- [CONV] ajv errors -> errors[] with JSON-pointer path (RFC 6901 escaping), sub-codes field_required/unknown_field/field_invalid, fixed messages (no value echo). Query errors use the ajv instancePath (`/limit`).
- [CONV] default text/plain parser removed (JSON + multipart only) so text bodies are 415. uuidv7 imported relatively from packages/shared-ts until @lims/shared-ts is a dependency (LD-05).
- 5xx log = event/error_code/err_name only (no message/stack); full logging is T0D-10.
- Results (after ruling, tests revised): errors suite 97/97, full api suite 717/717, typecheck clean. No impl change needed.
- Open: sqlstate.ts still constructs AuthError (now a LimsError; works), switch to LimsError when T0D-03 is next touched.
