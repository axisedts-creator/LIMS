import { PageNotice } from '../_components/shared';

export default function VersionNotFound() {
  return <PageNotice kind="missing" title="Auto-verification version" helpKey="quality.autoverify_version" message="This version doesn't exist or isn't in your lab." />;
}
