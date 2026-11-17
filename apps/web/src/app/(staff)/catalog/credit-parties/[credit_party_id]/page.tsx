// SCR-12 `/catalog/credit-parties/{id}`: the editor is a dialog on the list, so a direct link lands on the list.
import { redirect } from 'next/navigation';

export default function CreditPartyPage(): never {
  redirect('/catalog/credit-parties');
}
