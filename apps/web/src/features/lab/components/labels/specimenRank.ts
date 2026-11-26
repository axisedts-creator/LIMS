/**
 * Specimen Type Ranking and Connected Barcode mapping.
 * Aligns with legacy LIS / Analyzer machine standards:
 * Barcode = <RankCode><5-digit RegistrationNo>
 *
 * Ranking Order:
 * 1: Serum
 * 2: Stool
 * 3: Swab
 * 4: Sputum
 * 5: Urine
 * 6: Other / Nospec
 * 7: Fluoride F
 * 8: Citrate
 * 9: Heparin
 * 10: EDTA Whole Blood
 * 11: Urine 24Hr.
 * 12: Tissue
 * 13: Semen
 * 14: Blood
 * 15: Fluoride PP
 * 16: GTT 1 Hr.
 * 17: GTT 2 Hr.
 * 18: GTT 3 Hr.
 * 19: GTT 1/2 Hr.
 * 20: GTT 1 1/2 Hr.
 * 21: GTT 2 1/2 Hr.
 * 22: Culture
 * 23: Fluid
 * 24: Slide
 * 25: Fluoride R
 * 26: Nasal/Throat swab
 * 27: BAL
 * 28: Serum + EDTA
 * 29: Vaginal Swab
 * 30: Endotracheal Secretion
 * 31: Urine R
 * 32: Asc. F
 * 33: Pleural Fluid
 * 34: Pericardial Fluid
 * 35: Dialysis Fluid
 * 36: Endocervical Swab
 * 37: Slit Skin Scrapping
 * 38: CSF
 * 39: Ocular Fluid
 * 40: Synovial Fluid
 * 41: Wound Swab
 * 42: Cervical Scrapping
 * 43: BMA
 * 44: Plasma
 * 45: BC+
 * 46: Sem
 * 47: UGS
 * 48: Ear Swab
 * 49: PUS
 * 50: Catheter Tip
 * 51: TRF
 */

export const SPECIMEN_TYPE_RANKS: Readonly<Record<string, number>> = {
  SERUM: 1,
  STOOL: 2,
  SWAB: 3,
  SPUTUM: 4,
  URINE: 5,
  OTHER: 6,
  NOSPEC: 6,
  PLASMA_FL: 7,
  FLUORIDE_F: 7,
  PLASMA_CIT: 8,
  CITRATE: 8,
  WB_HEP: 9,
  HEPARIN: 9,
  WB_EDTA: 10,
  EDTA_WB: 10,
  URINE_24H: 11,
  TISSUE: 12,
  SEMEN: 13,
  BLOOD: 14,
  WB_CLOT: 14,
  FLUORIDE_PP: 15,
  GTT_1H: 16,
  GTT_2H: 17,
  GTT_3H: 18,
  GTT_HALF_H: 19,
  GTT_1_HALF_H: 20,
  GTT_2_HALF_H: 21,
  CULTURE: 22,
  BLOOD_CUL: 22,
  FLUID: 23,
  SLIDE: 24,
  SMEAR: 24,
  FLUORIDE_R: 25,
  NPSWAB: 26,
  BAL: 27,
  SERUM_EDTA: 28,
  VAGINAL_SWAB: 29,
  ENDOTRACHEAL: 30,
  URINE_R: 31,
  URINE_MID: 31,
  URINE_FM: 31,
  ASC_F: 32,
  ASCITIC_FLUID: 32,
  PLEURAL_FLUID: 33,
  PERICARDIAL_FLUID: 34,
  DIALYSIS_FLUID: 35,
  ENDOCERVICAL_SWAB: 36,
  SKIN_SCRAPPING: 37,
  SLIT_SKIN: 37,
  CSF: 38,
  OCULAR_FLUID: 39,
  SYNOVIAL_FLUID: 40,
  WOUND_SWAB: 41,
  CERVICAL_SCRAPPING: 42,
  BMA: 43,
  BM_ASP: 43,
  PLASMA: 44,
  BC_PLUS: 45,
  SEM: 46,
  UGS: 47,
  EAR_SWAB: 48,
  PUS: 49,
  CATHETER_TIP: 50,
  TRF: 51,
};

export const CONTAINER_RANKS: Readonly<Record<string, number>> = {
  GOLD_SST: 1,
  STOOL_CUP: 2,
  SWAB_TUBE: 3,
  URINE_CUP: 5,
  GREY_FL: 7,
  BLUE_CIT: 8,
  GREEN_HEP: 9,
  LAV_EDTA: 10,
  BLACK_ESR: 10,
  URINE_JUG: 11,
  FORMALIN: 12,
  RED_PLAIN: 14,
  BC_BOTTLE: 22,
  SLIDE_BOX: 24,
  VTM_TUBE: 26,
  URINE_STER: 31,
};

export function getSpecimenRank(specimenTypeCode?: string, containerCode?: string): number {
  const normType = (specimenTypeCode ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normType && normType in SPECIMEN_TYPE_RANKS) return SPECIMEN_TYPE_RANKS[normType]!;
  const normCont = (containerCode ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normCont && normCont in CONTAINER_RANKS) return CONTAINER_RANKS[normCont]!;
  return 6; // Default to Other
}

export function formatConnectedBarcode(registrationNo: string, specimenTypeCode?: string, containerCode?: string, existingBarcode?: string): string {
  if (existingBarcode) {
    const trimmed = existingBarcode.trim();
    if (/^\d{5,7}$/.test(trimmed) || trimmed.startsWith('OFF-')) {
      return trimmed;
    }
  }
  const digits = String(registrationNo).trim().replace(/\D+/g, '');
  const reg5 = (digits ? digits.slice(-5) : '00200').padStart(5, '0');
  const rank = getSpecimenRank(specimenTypeCode, containerCode);
  if (rank === 51 || (specimenTypeCode ?? '').trim().toUpperCase() === 'TRF') {
    return reg5;
  }
  return `${rank}${reg5}`;
}
