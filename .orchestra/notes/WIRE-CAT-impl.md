# WIRE-CAT impl (writer)
- Changed: services/api/src/modules/catalog/index.ts only (adds `ports: { CatalogPort }`; LD-185).
- [CONV] Port built eagerly at import: createCatalogPort({ cache: createCatalogCache(loadCatalogConfig(process.env)) }); one module-level instance, so ESM caching gives one process-wide cache. No I/O, no env var needed (defaults 50000 / 600 s).
- Tests: manifest-ports.test.ts 15/15 pass. tsc: no errors in catalog/index.ts; unrelated pre-existing errors in modules/quality (chart.service.ts, observation.service.ts), not touched.
- Open: full api suite not run by me; dev/ci now resolve the real CatalogPort, so any test that relied on the fake needs the tester to set LIMS_CORE_FAKE_PORTS or inject a port (LD-185 rule 3).
