// API-T06 / LD-78 — plain structural check of the golden vector against 02-TRD §5.10 (no OpenAPI): the signed document is an opaque payload, null is legal inside it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = JSON.parse(readFileSync(new URL('../fixtures/config/canonical.vector.json', import.meta.url), 'utf8')) as Record<string, any>;
const TARGET_KEYS = ['authenticode_publisher', 'key_id', 'package_sha256', 'package_size', 'release_id', 'signature', 'version'];

describe('canonical.vector.json shape (TRD §5.10)', () => {
  it('header fields', () => {
    expect(doc.schema).toBe('lims.bridge.config.v1');
    expect(doc.agent_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number.isInteger(doc.config_version) && doc.config_version > 0).toBe(true);
    expect(doc.issued_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it('update = { channel, target: Target|null, allow_downgrade, window: Window|null }', () => {
    expect(Object.keys(doc.update).sort()).toEqual(['allow_downgrade', 'channel', 'target', 'window']);
    expect(['stable', 'beta']).toContain(doc.update.channel);
    expect(typeof doc.update.allow_downgrade).toBe('boolean');
    const { target, window } = doc.update;
    if (target !== null) {
      expect(Object.keys(target).sort()).toEqual(TARGET_KEYS);
      expect(target.package_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(target.package_size) && target.package_size > 0).toBe(true);
    }
    if (window !== null) expect(Object.keys(window).sort()).toEqual(['from', 'timezone', 'to']);
  });
  it('null is present as an explicit null (the signed bytes keep the keys)', () => {
    expect(doc.update).toHaveProperty('target');
    expect(doc.update).toHaveProperty('window');
    expect(doc.update.target).toBeNull();
    expect(doc.update.window).toBeNull();
  });
  it('instruments entries carry the TRD transport / capabilities blocks', () => {
    expect(Array.isArray(doc.instruments)).toBe(true);
    for (const i of doc.instruments) {
      expect(typeof i.instrument_code).toBe('string');
      expect(Object.keys(i.capabilities).sort()).toEqual(['host_query', 'worklist_download']);
      expect(typeof i.transport.kind).toBe('string');
    }
  });
});
