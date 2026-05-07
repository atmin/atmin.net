import { useEffect, useRef } from 'react';

const VERT = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying vec2 vUv;

uniform vec3 uBgColor;
uniform vec3 uBlob1Color;
uniform vec3 uBlob2Color;
uniform float uBlobRadius;
uniform float uBlobRadiusSecondary;
uniform float uBlobStrength;
uniform float uTime;
uniform float uVelocityIntensity;
uniform float uNoiseStrength;
uniform float uAspect;

float random(vec2 st) {
  return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
}

void main() {
  vec2 uv = vUv;
  uv.x *= uAspect;

  // swap orbit axes in portrait so blobs spread vertically instead of horizontally
  float hAmp1 = uAspect >= 1.0 ? 0.28 : 0.22;
  float vAmp1 = uAspect >= 1.0 ? 0.22 : 0.28;
  float hAmp2 = uAspect >= 1.0 ? 0.30 : 0.25;
  float vAmp2 = uAspect >= 1.0 ? 0.25 : 0.30;

  vec2 blob1Center = vec2(
    uAspect * (0.5 + hAmp1 * sin(uTime * 0.41)),
    0.5 + vAmp1 * cos(uTime * 0.31)
  );
  vec2 blob2Center = vec2(
    uAspect * (0.5 + hAmp2 * cos(uTime * 0.37)),
    0.5 + vAmp2 * sin(uTime * 0.53)
  );

  vec3 color = uBgColor;

  float blob1 = smoothstep(uBlobRadius, 0.0, distance(uv, blob1Center));
  float blob2 = smoothstep(uBlobRadiusSecondary, 0.0, distance(uv, blob2Center));

  vec3 blob1SoftColor = mix(uBlob1Color, uBgColor, 0.35);
  vec3 blob2SoftColor = mix(uBlob2Color, uBgColor, 0.35);
  color = mix(color, blob1SoftColor, blob1 * uBlobStrength);
  color = mix(color, blob2SoftColor, blob2 * uBlobStrength);

  color += uVelocityIntensity;

  float grain = random(vUv * vec2(1387.13, 947.91)) - 0.5;
  color += grain * uNoiseStrength;

  gl_FragColor = vec4(color, 1.0);
}
`;

interface GLState {
    gl: WebGLRenderingContext | null;
    uniforms: Record<string, WebGLUniformLocation>;
    time: number;
    velocity: number;
    rafId: number;
    running: boolean;
}

export interface AuroraUniforms {
    bgColor: string;
    blob1Color: string;
    blob2Color: string;
    blobRadius: number;
    blobRadiusSecondary: number;
    blobStrength: number;
    noiseStrength: number;
    scrollScale: number;
    velocityStrength: number;
    velocityDecay: number;
}

function hexToVec3(hex: string): [number, number, number] {
    const c = hex.replace('#', '');
    return [
        parseInt(c.substring(0, 2), 16) / 255,
        parseInt(c.substring(2, 4), 16) / 255,
        parseInt(c.substring(4, 6), 16) / 255,
    ];
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
    // biome-ignore lint/style/noNonNullAssertion: createShader only returns null for invalid type constants
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
}

function drawFrame(s: GLState, p: AuroraUniforms, canvas: HTMLCanvasElement) {
    const { gl, uniforms } = s;
    if (!gl) return;
    const aspect = canvas.width / canvas.height;
    const largerDim = Math.max(aspect, 1);
    gl.uniform3fv(uniforms.uBgColor, hexToVec3(p.bgColor));
    gl.uniform3fv(uniforms.uBlob1Color, hexToVec3(p.blob1Color));
    gl.uniform3fv(uniforms.uBlob2Color, hexToVec3(p.blob2Color));
    gl.uniform1f(uniforms.uBlobRadius, p.blobRadius * largerDim);
    gl.uniform1f(
        uniforms.uBlobRadiusSecondary,
        p.blobRadiusSecondary * largerDim,
    );
    gl.uniform1f(uniforms.uBlobStrength, p.blobStrength);
    gl.uniform1f(uniforms.uTime, s.time);
    gl.uniform1f(
        uniforms.uVelocityIntensity,
        Math.min(s.velocity, 1) * p.velocityStrength,
    );
    gl.uniform1f(uniforms.uNoiseStrength, p.noiseStrength);
    gl.uniform1f(uniforms.uAspect, aspect);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function startLoop(
    s: GLState,
    getProps: () => AuroraUniforms,
    canvas: HTMLCanvasElement,
) {
    s.running = true;
    const tick = () => {
        const p = getProps();
        s.velocity *= p.velocityDecay;
        drawFrame(s, p, canvas);
        if (s.velocity > 0.001) {
            s.rafId = requestAnimationFrame(tick);
        } else {
            s.velocity = 0;
            s.running = false;
        }
    };
    s.rafId = requestAnimationFrame(tick);
}

export function useAuroraBackground(props: AuroraUniforms) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const glState = useRef<GLState>({
        gl: null,
        uniforms: {},
        time: 0,
        velocity: 0,
        rafId: 0,
        running: false,
    });
    const propsRef = useRef<AuroraUniforms>(props);
    propsRef.current = props;

    // WebGL init
    useEffect(() => {
        // biome-ignore lint/style/noNonNullAssertion: ref is guaranteed set after mount
        const canvas = canvasRef.current!;
        const gl = canvas.getContext('webgl');
        if (!gl) return;
        const s = glState.current;

        // biome-ignore lint/style/noNonNullAssertion: createProgram only returns null when context is lost
        const prog = gl.createProgram()!;
        gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is a WebGL method, not a React hook
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
            gl.STATIC_DRAW,
        );
        const loc = gl.getAttribLocation(prog, 'aPosition');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        s.gl = gl;
        s.uniforms = Object.fromEntries(
            [
                'uBgColor',
                'uBlob1Color',
                'uBlob2Color',
                'uBlobRadius',
                'uBlobRadiusSecondary',
                'uBlobStrength',
                'uTime',
                'uVelocityIntensity',
                'uNoiseStrength',
                'uAspect',
                // biome-ignore lint/style/noNonNullAssertion: uniform names are validated at compile time
            ].map((name) => [name, gl.getUniformLocation(prog, name)!]),
        );

        const resize = () => {
            canvas.width = canvas.offsetWidth * devicePixelRatio;
            canvas.height = canvas.offsetHeight * devicePixelRatio;
            gl.viewport(0, 0, canvas.width, canvas.height);
            drawFrame(s, propsRef.current, canvas);
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        return () => {
            ro.disconnect();
            cancelAnimationFrame(s.rafId);
            s.running = false;
            gl.deleteProgram(prog);
        };
    }, []);

    // redraw immediately when any visual prop changes (e.g. Storybook controls)
    // biome-ignore lint/correctness/useExhaustiveDependencies: props are read via propsRef; listed here only as change triggers
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas) drawFrame(glState.current, propsRef.current, canvas);
    }, [
        props.bgColor,
        props.blob1Color,
        props.blob2Color,
        props.blobRadius,
        props.blobRadiusSecondary,
        props.blobStrength,
        props.noiseStrength,
        props.velocityStrength,
    ]);

    // scroll + wheel listeners
    useEffect(() => {
        const s = glState.current;
        // biome-ignore lint/style/noNonNullAssertion: ref is guaranteed set after mount
        const canvas = canvasRef.current!;
        let lastY = window.scrollY;
        let lastT = performance.now();

        const kick = (dy: number) => {
            const now = performance.now();
            const dt = Math.max(now - lastT, 1);
            lastT = now;
            s.velocity = Math.abs(dy) / dt;
            s.time += dy / propsRef.current.scrollScale;
            if (!s.running) startLoop(s, () => propsRef.current, canvas);
        };

        const onScroll = () => {
            const dy = window.scrollY - lastY;
            lastY = window.scrollY;
            kick(dy);
        };

        const onWheel = (e: WheelEvent) => kick(e.deltaY);

        window.addEventListener('scroll', onScroll, { passive: true });
        canvas.addEventListener('wheel', onWheel, { passive: true });
        return () => {
            window.removeEventListener('scroll', onScroll);
            canvas.removeEventListener('wheel', onWheel);
        };
    }, []);

    return canvasRef;
}
