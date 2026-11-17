// AU-6 Log out (public). Logout is a POST (server action, CSRF-checked by core middleware), never a GET side effect.
import { logoutAction } from '@/features/admin/auth/actions';

export default function LogoutPage() {
  return (
    <main className="lims-auth-card">
      <h1>Log out</h1>
      <form action={logoutAction}>
        <button type="submit" className="lims-btn lims-btn-primary lims-btn-md">
          Log out
        </button>
      </form>
      <a href="/">Cancel</a>
    </main>
  );
}
