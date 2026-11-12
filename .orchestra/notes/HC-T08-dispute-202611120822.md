# HC-T08 dispute (test fixture bug, not a spec contradiction)
- visits.list/visit.detail/routes tests fail in beforeAll: `visit_assignments__route__fk` violated (spec/chunks/C17-home-collection/05-SCHEMA.md:333 requires route to exist).
- Root: repository/__tests__/helpers.ts:64 seedWorld seeds a default route with fixed (tenant,centre,member,route_date); 3 parallel files collide, frontdesk helpers.ts:67 `ON CONFLICT DO NOTHING` hides it. Fix is tester-owned: unique route_date per file in seedWorld, or `fileParallelism:false` for these specs.
- Impl handlers untouched; 51 specs remain unrun until fixed.
