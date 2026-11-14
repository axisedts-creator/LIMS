import { QualityNotice } from '@/features/quality/components/Shared';

// One page for "no such run" and "run of another lab": the API answers 404 for both (07-SECURITY).
export default function QcRunNotFound() {
  return <QualityNotice kind="missing" title="QC run" helpKey="quality.qc_run" message="This QC run doesn't exist or isn't in your lab." />;
}
