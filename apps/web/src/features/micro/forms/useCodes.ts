'use client';
// Lazy coded-set read for a dialog / tab through the server action (the JWT never reaches the client). A failed read leaves an empty list and the form usable.
import { listCultureCodesAction } from '../server/cultureActions';
import { useLoad } from '../components/settings/useLoad';

export function useCodes(set: string, enabled = true) {
  return useLoad(() => listCultureCodesAction(set), set, enabled);
}
