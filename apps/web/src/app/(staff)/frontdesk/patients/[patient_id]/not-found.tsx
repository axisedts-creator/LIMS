// 03-APP-FLOW §4 404 state for the patient page.
import { EmptyState } from '@lims/ui/components/EmptyState';

export default function PatientNotFound() {
  return <EmptyState title="Patient not found" body="Check the patient code, or search from the registration page." />;
}
