import { List, ListButton } from 'konsta/react';

interface Props {
    onLogout: () => void;
}

// Sign out — moved off the chats screen during the Konsta migration (T1), now a
// proper destructive list-button in Settings (T2).
export default function SignOutPanel({ onLogout }: Props) {
    return (
        <List strong inset>
            <ListButton onClick={onLogout}>
                <span className="text-red-500">Sign out</span>
            </ListButton>
        </List>
    );
}
