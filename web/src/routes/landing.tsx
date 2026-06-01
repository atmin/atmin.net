import LandingPage from '@/components/LandingPage';
import { useAutoDismiss } from '@/hooks/useAutoDismiss';
import type { LoginNotice } from '@/hooks/useSession';

interface Props {
    notice?: LoginNotice;
    onDismissNotice?: () => void;
}

export default function LandingRoute({
    notice = null,
    onDismissNotice = () => {},
}: Props) {
    const accountDeleted = notice === 'account_deleted';
    // One-shot: auto-dismiss the confirmation after 5s so it never lingers
    // into a later visit (it lives in session state, not the URL).
    useAutoDismiss(accountDeleted, onDismissNotice, 5000);

    return (
        <LandingPage
            accountDeleted={accountDeleted}
            onDismiss={onDismissNotice}
        />
    );
}
