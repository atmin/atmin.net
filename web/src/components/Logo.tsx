interface Props {
    className?: string;
}

export default function Logo({ className }: Props) {
    return (
        <svg
            viewBox="6 12 92 77"
            fill="none"
            stroke="currentColor"
            className={className}
            xmlns="http://www.w3.org/2000/svg"
        >
            <title>atmin.net logo</title>
            <path
                strokeWidth="5"
                strokeLinejoin="round"
                d="m 44.344,17.038 c -18.404,0 -33.324,14.92 -33.324,33.324 -0.001,18.405 14.919,33.326 33.324,33.326 9.662,0 13.399,-1.549 22.348,-8.363 6.331,7.355 8.657,9.047 26.826,8.36 -11.684,-7.889 -19.089,-6.848 -16.429,-31.034 2.304,-20.953 -14.503,-35.614 -32.745,-35.613 z"
            />
            <circle
                cx="34.22"
                cy="61.12"
                r="4"
                fill="currentColor"
                stroke="none"
            />
            <circle
                cx="45.24"
                cy="61.12"
                r="4"
                fill="currentColor"
                stroke="none"
            />
            <circle
                cx="56.26"
                cy="61.12"
                r="4"
                fill="currentColor"
                stroke="none"
            />
        </svg>
    );
}
