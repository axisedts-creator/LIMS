import { redirect } from 'next/navigation';

// WEB-STYLE-1 (LD-198): /auth/ had no page (404); land on the real login.
export default function AuthIndexPage(): never {
  redirect('/auth/login');
}
