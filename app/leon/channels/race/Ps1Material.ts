import * as THREE from 'three'

// The PS1 look, reconstructed from what the hardware actually did rather than
// applied as a filter afterwards:
//
//   1. Vertex snapping. The GTE had no sub-pixel precision, so transformed
//      vertices were rounded to a low-resolution grid. This is the famous
//      wobble — geometry visibly jitters as it moves, worst at distance.
//   2. Affine texture mapping / no perspective correction. The GPU
//      interpolated across a triangle in screen space, so surfaces warp.
//      We approximate it by interpolating lighting affinely too.
//   3. Per-vertex (Gouraud) lighting only. No per-pixel anything.
//   4. Distance fog, used universally to hide an aggressively near far-plane.
//   5. 15-bit colour output — 5 bits per channel, hence the visible banding.
//
// theme.ts already does 1, 4 and 5 on the CPU for the 2D chrome; this is the
// GPU port so the 3D scenes sit in the same world.

const VERTEX_SHADER = /* glsl */ `
  // Half the framebuffer size in pixels: NDC spans -1..1, so multiplying by
  // half the resolution puts us in whole-pixel units and floor() lands the
  // vertex exactly on the pixel grid the scene is actually rasterised at.
  uniform vec2 uJitterGrid;
  uniform float uJitterStrength;
  uniform vec3 uLightDirection;
  uniform float uAmbient;

  varying vec3 vColor;
  varying float vFogDepth;
  varying vec2 vUv;
  varying float vAffineW;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vec4 clipPosition = projectionMatrix * viewPosition;

    // Snap in normalised device space, then restore w. Dividing and
    // re-multiplying is what ties the jitter to distance, exactly as the
    // hardware's fixed-point pipeline did.
    vec3 ndc = clipPosition.xyz / clipPosition.w;
    vec2 snapped = floor(ndc.xy * uJitterGrid) / uJitterGrid;
    ndc.xy = mix(ndc.xy, snapped, uJitterStrength);
    gl_Position = vec4(ndc * clipPosition.w, clipPosition.w);

    // Gouraud: one lighting evaluation per vertex, interpolated across the
    // face. No normal maps, no specular, no per-pixel work.
    vec3 worldNormal = normalize(normalMatrix * normal);
    float lambert = max(dot(worldNormal, normalize(uLightDirection)), 0.0);
    vec3 shade = vec3(uAmbient + lambert * (1.0 - uAmbient));

    // Affine interpolation — the warping texture, and the second most
    // recognisable artefact of the era after the wobble.
    //
    // The console interpolated across a triangle in screen space with no
    // perspective divide, so a texture on a surface angled away from the
    // camera visibly bends along the diagonal the triangle was split on.
    // Modern hardware always interpolates perspective-correctly, and GLSL ES
    // has no 'noperspective' qualifier to switch it off (that is desktop GL
    // only), so it has to be undone arithmetically.
    //
    // The GPU computes sum(l*a/w) / sum(l/w) for a varying 'a'. Feed it a*w
    // and it computes sum(l*a) / sum(l/w); feed it w and it computes
    // sum(l) / sum(l/w). Divide the first by the second and the 1/w terms
    // cancel, leaving sum(l*a) / sum(l) — plain linear interpolation.
    //
    // Lighting and fog depth go through the same premultiply, because the
    // hardware had no way to treat them differently either.
    vAffineW = clipPosition.w;
    vUv = uv * clipPosition.w;
    vColor = shade * clipPosition.w;
    vFogDepth = -viewPosition.z * clipPosition.w;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uEmissive;
  uniform sampler2D uMap;
  /** 1 when a texture is bound. Branchless: sampling an unbound unit is UB. */
  uniform float uUseMap;
  /** How far a textured surface is pulled towards uColor, 0..1. */
  uniform float uTint;

  varying vec3 vColor;
  varying float vFogDepth;
  varying vec2 vUv;
  varying float vAffineW;

  // 15-bit framebuffer: 32 levels per channel. The banding is the point.
  vec3 quantize15Bit(vec3 color) {
    return floor(color * 31.0 + 0.5) / 31.0;
  }

  void main() {
    // Undo the perspective correction the hardware applied on the way in.
    // See the vertex shader for why this is the whole trick.
    vec2 uv = vUv / vAffineW;
    vec3 shade = vColor / vAffineW;
    float fogDepth = vFogDepth / vAffineW;

    // A texture read has to happen unconditionally — sampling inside a branch
    // makes the derivative undefined, and half the fragments would pick the
    // wrong mip. The result is mixed out instead.
    vec3 sampled = texture2D(uMap, uv).rgb * mix(vec3(1.0), uColor, uTint);
    vec3 base = mix(uColor, sampled, uUseMap);

    vec3 lit = base * (shade + uEmissive);
    float fogAmount = smoothstep(uFogNear, uFogFar, fogDepth);
    vec3 fogged = mix(lit, uFogColor, fogAmount);
    gl_FragColor = vec4(quantize15Bit(fogged), 1.0);
  }
`

export interface Ps1MaterialOptions {
  readonly color: THREE.ColorRepresentation
  readonly fogColor?: THREE.ColorRepresentation
  readonly fogNear?: number
  readonly fogFar?: number
  /** Lifts a surface out of the lighting model — used for lamps and kerbs. */
  readonly emissive?: number
  /** Affinely mapped, nearest-sampled, unmipped — see loadPs1Texture. */
  readonly map?: THREE.Texture
  /**
   * How far a textured surface is pulled towards `color`, 0..1. The cars
   * carry their own liveries, so this stays low: enough that a driver's
   * colour is findable on the track, not so much that the paintwork goes.
   */
  readonly tint?: number
  readonly ambient?: number
  readonly side?: THREE.Side
}

const DEFAULT_AMBIENT = 0.35

/**
 * The virtual framebuffer the jitter is quantised against, in pixels. The
 * console composited at 320x240, and snapping to that grid rather than an
 * arbitrary constant is what makes the wobble read as hardware rather than as
 * noise: a vertex can only ever sit where a pixel could.
 *
 * Held as half-resolution because NDC spans -1..1 across the full width.
 */
const JITTER_FRAMEBUFFER = { width: 320, height: 240 } as const

/**
 * One uniform object shared by every PS1 material in the app. Three reads
 * uniforms by reference, so mutating `.value` here retunes the whole scene in
 * a single write — no registry, no per-material bookkeeping, and no chance of
 * two surfaces snapping to different grids and tearing against each other.
 */
const sharedJitterGrid = {
  value: new THREE.Vector2(JITTER_FRAMEBUFFER.width / 2, JITTER_FRAMEBUFFER.height / 2),
}

/** 0 disables the wobble entirely; 1 is full hardware-accurate snapping. */
const sharedJitterStrength = { value: 1 }

/**
 * Re-derives the jitter grid from the aspect ratio the scene is rendering at,
 * keeping pixels square. Call when the canvas resizes.
 */
export function setJitterAspect(aspect: number): void {
  const height = JITTER_FRAMEBUFFER.height
  sharedJitterGrid.value.set((height * aspect) / 2, height / 2)
}

export function setJitterStrength(strength: number): void {
  sharedJitterStrength.value = Math.min(Math.max(strength, 0), 1)
}
// Tuned against the camera rig in CameraDirector: the chase cam sits ~9m back
// and the high-wide shot ~75m out, so fog has to stay clear well past that or
// the whole circuit greys out on the establishing shot.
const DEFAULT_FOG_NEAR = 45
const DEFAULT_FOG_FAR = 165

export function createPs1Material(options: Ps1MaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: options.side ?? THREE.FrontSide,
    uniforms: {
      uColor: { value: new THREE.Color(options.color) },
      uFogColor: { value: new THREE.Color(options.fogColor ?? '#141430') },
      uFogNear: { value: options.fogNear ?? DEFAULT_FOG_NEAR },
      uFogFar: { value: options.fogFar ?? DEFAULT_FOG_FAR },
      uEmissive: { value: options.emissive ?? 0 },
      uMap: { value: options.map ?? null },
      uUseMap: { value: options.map ? 1 : 0 },
      uTint: { value: options.tint ?? 0 },
      uJitterGrid: sharedJitterGrid,
      uJitterStrength: sharedJitterStrength,
      uAmbient: { value: options.ambient ?? DEFAULT_AMBIENT },
      uLightDirection: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
    },
  })
}

/**
 * Loads a texture the way the console would have held it: nearest-neighbour
 * in both directions, no mipmaps, no anisotropy, no colour management.
 *
 * Every one of those is a modern kindness that erases the look. Mipmaps in
 * particular are the opposite of the artefact we want — the console had none,
 * which is exactly why distant textures shimmered.
 */
export function configurePs1Texture(texture: THREE.Texture): THREE.Texture {
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.anisotropy = 1
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = true
  texture.needsUpdate = true
  return texture
}
