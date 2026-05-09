import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

interface Props {
    to?: string;
}

export default function BackButton({ to = '/' }: Props) {
    return (
        <Link to={to} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-5 w-5" />
        </Link>
    );
}
