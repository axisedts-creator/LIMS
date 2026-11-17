// AU-7 Session expired (04-UI-UX §4). Reason-specific variants reuse the AU-1 copy for the same API codes.
export interface SessionExpiredCardProps {
  reason?: 'locked' | 'suspended' | 'role_changed' | undefined;
  minutes: number;
}

const REASON = {
  locked: 'Your account is locked. Contact your lab administrator.',
  suspended: 'Access for your lab is currently suspended. Contact your lab administrator.',
  role_changed: 'Your access was changed by an administrator. Log in again.',
} as const;

export function SessionExpiredCard({ reason, minutes }: SessionExpiredCardProps) {
  return (
    <div className="lims-auth-card">
      <h1>Session ended</h1>
      <p>
        {reason
          ? REASON[reason]
          : `For your security you were logged out after ${minutes} minutes without activity, or because your session ended.`}
      </p>
      <a href="/auth/login">Log in again</a>
    </div>
  );
}
