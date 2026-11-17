import 'server-only';
// Read-only lookups the SCR-06…08 page needs: #1–#2 style list endpoints for masters, #17 units, #20 value sets, #37/#44 range sets.
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './guard';
import type { RangeKind, RangeSet } from './types';

interface Data<T> { data: T[] }
export interface Department { id: string; name: string; is_active: boolean }
export interface SpecimenType { id: string; code: string; name: string }
export interface Method { id: string; name: string; is_active: boolean }
export interface Unit { code: string; display: string; scope: string }
export interface ValueSet { code: string; display: string; is_ordered: boolean }

const list = async <T>(path: string): Promise<T[]> => (await serverFetch<Data<T>>(path)).data;
export const listDepartments = () => list<Department>('/v1/catalog/departments');
export const listSpecimenTypes = () => list<SpecimenType>('/v1/catalog/specimen-types');
export const listMethods = () => list<Method>('/v1/catalog/methods');
export const listUnits = () => list<Unit>('/v1/catalog/units');
export const listValueSets = () => list<ValueSet>('/v1/catalog/value-sets');
export const listRangeSets = async (kind: RangeKind, analyteId: string): Promise<RangeSet[]> =>
  list<RangeSet>(`/v1/catalog/analytes/${uuid(analyteId)}/${kind === 'ranges' ? 'reference-range-sets' : 'critical-limit-sets'}`);
