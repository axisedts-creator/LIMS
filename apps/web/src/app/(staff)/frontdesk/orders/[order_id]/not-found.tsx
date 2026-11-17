// 03-APP-FLOW §4 404 state. Same text for an unknown order and an order of another centre.
import { EmptyState } from '@lims/ui/components/EmptyState';

export default function OrderNotFound() {
  return <EmptyState title="Order not found" body="Check the registration number, or search from the front-desk worklist." />;
}
