// Sign out (PX-1). A POST via server action (CSRF-checked inside logoutAction), never a GET side effect.
import { Button } from '@lims/ui/components/Button';
import { logoutAction } from '../actions';

export default function LogoutPage() {
  async function signOut() {
    'use server';
    await logoutAction();
  }
  return (
    <div className="lims-auth-card">
      <h1>Sign out</h1>
      <form action={signOut}>
        <Button type="submit" variant="primary">
          Sign out
        </Button>
      </form>
      <a href="/">Cancel</a>
    </div>
  );
}
