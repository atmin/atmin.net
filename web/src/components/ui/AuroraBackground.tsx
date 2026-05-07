import type { AuroraUniforms } from '@/hooks/useAuroraBackground';
import { useAuroraBackground } from '@/hooks/useAuroraBackground';

export interface AuroraBackgroundProps extends AuroraUniforms {
    children?: React.ReactNode;
    className?: string;
}

export default function AuroraBackground({
    bgColor = '#1a1a2e',
    blob1Color = '#e94560',
    blob2Color = '#0f3460',
    blobRadius = 0.6,
    blobRadiusSecondary = 0.6,
    blobStrength = 0.5,
    noiseStrength = 0.06,
    scrollScale = 800,
    velocityStrength = 0.03,
    velocityDecay = 0.94,
    children,
    className,
}: AuroraBackgroundProps) {
    const canvasRef = useAuroraBackground({
        bgColor,
        blob1Color,
        blob2Color,
        blobRadius,
        blobRadiusSecondary,
        blobStrength,
        noiseStrength,
        scrollScale,
        velocityStrength,
        velocityDecay,
    });

    return (
        <div
            style={{ position: 'relative', width: '100%', height: '100%' }}
            className={className}
        >
            <canvas
                ref={canvasRef}
                style={{
                    position: 'fixed',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    zIndex: -1,
                    display: 'block',
                }}
            />
            {children}
        </div>
    );
}
