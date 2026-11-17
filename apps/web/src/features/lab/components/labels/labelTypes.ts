// C5 T-10 web types: DTOs copied from contracts/openapi/lab.yaml (PrintLabelsResponse #14, OrderLabelPrintResponse #14a) + the snake_case -> LabelData mapping (02-TRD §4.6).
import type { LabelData } from './LabelRenderer';

export interface LabelDto {
  specimen_id: string; barcode: string; patient_name: string; age_sex: string; registration_no: string; specimen_type_code: string;
  container_code?: string; collected_on?: string; test_codes: string[]; more_tests: number; urgent: boolean; copies: number;
}
export interface PrintLabelsResponse {
  labels: LabelDto[]; errors: { id: string; code: string }[]; size: { width_mm: number; height_mm: number }; label_copies_default: number;
}
export interface ReadySpecimen { specimen_id: string; barcode: string; outcome: 'ready' | 'inactive' }
export interface OrderLabelPrintResponse { order_id: string; specimens: ReadySpecimen[]; labels_route: string }

export const toLabelData = (l: LabelDto): LabelData => ({
  specimenId: l.specimen_id, barcode: l.barcode, patientName: l.patient_name, ageSex: l.age_sex, registrationNo: l.registration_no, specimenTypeCode: l.specimen_type_code,
  ...(l.container_code ? { containerCode: l.container_code } : {}), ...(l.collected_on ? { collectedOn: l.collected_on } : {}),
  testCodes: l.test_codes, moreTests: l.more_tests, urgent: l.urgent, copies: l.copies,
});
