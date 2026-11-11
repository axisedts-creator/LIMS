// 02-CV §2.4: every page has loading.tsx.
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function NewRegistrationLoading() {
  return <LoadingSkeleton variant="form" />;
}
