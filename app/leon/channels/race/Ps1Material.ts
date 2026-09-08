import * as THREE from 'three'
import { PS1_SKY } from '../../ps1/theme'

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
//
// Three of those five are dials rather than constants now, because the channel
// runs circuits from two different eras. The hand-built oval is PS1 and takes
// all of it. An imported track is PS2: the same Gouraud lighting and the same
// distance fog — those are what make it a console racer rather than a modern
// one — but no vertex snapping, no affine warp and a full-depth framebuffer,
// because that is exactly what the later hardware fixed. See RENDER_PROFILES
// in tracks/types.ts; the numbers live with the tracks, not here.

const VERTEX_SHADER = /* glsl */ `
  // Half the framebuffer size in pixels: NDC spans -1..1, so multiplying by
  // half the resolution puts us in whole-pixel units and floor() lands the
  // vertex exactly on the pixel grid the scene is actually rasterised at.
  uniform vec2 uJitterGrid;
  uniform float uJitterStrength;
  uniform vec3 uLightDirection;
  uniform float uAmbient;

  // Two copies of everything that crosses a triangle: one premultiplied by w
  // so the hardware's perspective correction cancels out, one left alone. The
  // fragment shader blends between them, which is what lets one program serve
  // a console that had no perspective correction and one that did.
  varying vec3 vColor;
  varying float vFogDepth;
  varying vec2 vUv;
  varying float vAffineW;
  varying vec3 vColorLinear;
  varying float vFogDepthLinear;
  varying vec2 vUvLinear;

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

    vUvLinear = uv;
    vColorLinear = shade;
    vFogDepthLinear = -viewPosition.z;
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
  /** Below this texture alpha the fragment is thrown away. 0 disables it. */
  uniform float uAlphaTest;
  /** 1 undoes perspective correction entirely; 0 leaves it alone. */
  uniform float uAffine;
  /** Levels per channel in the output. 31 is a 15-bit framebuffer. */
  uniform float uColorLevels;

  varying vec3 vColor;
  varying float vFogDepth;
  varying vec2 vUv;
  varying float vAffineW;
  varying vec3 vColorLinear;
  varying float vFogDepthLinear;
  varying vec2 vUvLinear;

  vec3 quantizeOutput(vec3 color) {
    return floor(color * uColorLevels + 0.5) / uColorLevels;
  }

  void main() {
    // Undo the perspective correction the hardware applied on the way in —
    // see the vertex shader for why this is the whole trick — and then mix
    // back towards the correct version by however much of the artefact this
    // circuit's era actually had. Blending the two results rather than
    // switching between them keeps it a single program with no branch, and
    // lets a track sit part-way if that is what looks right.
    vec2 uv = mix(vUvLinear, vUv / vAffineW, uAffine);
    vec3 shade = mix(vColorLinear, vColor / vAffineW, uAffine);
    float fogDepth = mix(vFogDepthLinear, vFogDepth / vAffineW, uAffine);

    // A texture read has to happen unconditionally — sampling inside a branch
    // makes the derivative undefined, and half the fragments would pick the
    // wrong mip. The result is mixed out instead.
    vec4 texel = texture2D(uMap, uv);
    vec3 sampled = texel.rgb * mix(vec3(1.0), uColor, uTint);
    vec3 base = mix(uColor, sampled, uUseMap);

    // Cut-out transparency, which is the only kind the hardware had. Foliage,
    // fences and signage were all drawn as flat cards with a masked texture,
    // and without the mask a tree is an opaque white billboard standing in
    // front of the circuit — which is exactly what the first imported track
    // looked like. Discard rather than blend: sorting per-pixel transparency
    // was beyond the console and is unnecessary here.
    if (uAlphaTest > 0.0 && texel.a < uAlphaTest) discard;

    vec3 lit = base * (shade + uEmissive);
    float fogAmount = smoothstep(uFogNear, uFogFar, fogDepth);
    vec3 fogged = mix(lit, uFogColor, fogAmount);
    gl_FragColor = vec4(fogged, 1.0);

    // Convert from the renderer's linear working space to the display's.
    //
    // Everything upstream is linear whether we asked or not: an sRGB texture
    // is decoded by the sampler the moment colorSpace says SRGB, and
    // THREE.Color converts hex values on construction. This shader used to
    // write those linear values out raw, which showed every texture and every
    // tuned colour one gamma darker than its file — a tax the art direction
    // had been unknowingly paying back with brightness lifts at every stage.
    // The include is three's own output transform, the same one its built-in
    // materials end with.
    #include <colorspace_fragment>

    // Quantise *after* the transform, in display space, because that is the
    // space the console's framebuffer lived in — 31 levels of what you see,
    // not 31 levels of physics.
    gl_FragColor = vec4(quantizeOutput(gl_FragColor.rgb), gl_FragColor.a);
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
   * Alpha below which a textured fragment is discarded. Set it for anything
   * drawn as a cut-out card — foliage, chain-link, signage.
   */
  readonly alphaTest?: number
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

/**
 * The two remaining era artefacts, shared by every surface in the scene for
 * the same reason the jitter grid is: one write retunes the whole circuit, and
 * two surfaces can never end up in different decades.
 */
const sharedAffine = { value: 1 }
const sharedColorLevels = { value: 31 }

/**
 * Puts the whole scene in one console's register.
 *
 * These three move together or not at all. A picture with the wobble but
 * perspective-correct textures is not an earlier console and not a later one —
 * it is a mistake, and it reads as one. So the profile is applied in a single
 * call and the values live beside the tracks that choose them.
 */
export function setRenderProfile(profile: {
  readonly jitter: number
  readonly affine: number
  readonly colourLevels: number
}): void {
  setJitterStrength(profile.jitter)
  sharedAffine.value = Math.min(Math.max(profile.affine, 0), 1)
  sharedColorLevels.value = Math.max(1, profile.colourLevels)
}
// Tuned against the camera rig in CameraDirector: the chase cam sits ~9m back
// and the high-wide shot ~75m out, so fog has to stay clear well past that or
// the whole circuit greys out on the establishing shot. These are the opening
// values only — each circuit sets its own range through setFogRange, because a
// distance that dissolves the far side of a 70-unit oval leaves a 340-unit
// road course perfectly clear, and the dissolve is the point.
const DEFAULT_FOG_NEAR = 45
const DEFAULT_FOG_FAR = 165

/**
 * Fog, shared by every PS1 material in the scene for the same reason the
 * jitter grid is: three reads uniforms by reference, so one write here
 * retunes the whole circuit, and there is no way for two surfaces to end up
 * fogging at different distances and tearing against each other.
 */
const sharedFogNear = { value: DEFAULT_FOG_NEAR }
const sharedFogFar = { value: DEFAULT_FOG_FAR }

const sharedFogColor = { value: new THREE.Color(PS1_SKY.mid) }

/** Sets where geometry starts and finishes dissolving, in game units. */
export function setFogRange(near: number, far: number): void {
  sharedFogNear.value = near
  sharedFogFar.value = Math.max(near + 1, far)
}

/**
 * Sets what geometry dissolves *into*. Must be the sky's own mid stop — fog a
 * different colour from the backdrop reads as smoke, not distance.
 */
export function setFogColor(color: THREE.ColorRepresentation): void {
  sharedFogColor.value.set(color)
}

export function createPs1Material(options: Ps1MaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: options.side ?? THREE.FrontSide,
    uniforms: {
      uColor: { value: new THREE.Color(options.color) },
      // Fog matches the backdrop's middle stop, so geometry dissolves into
      // the painted sky rather than ending against it. Shared, because the
      // sky is per-track now: see TrackSky.
      uFogColor:
        options.fogColor === undefined
          ? sharedFogColor
          : { value: new THREE.Color(options.fogColor) },
      uFogNear: options.fogNear === undefined ? sharedFogNear : { value: options.fogNear },
      uFogFar: options.fogFar === undefined ? sharedFogFar : { value: options.fogFar },
      uEmissive: { value: options.emissive ?? 0 },
      uMap: { value: options.map ?? null },
      uUseMap: { value: options.map ? 1 : 0 },
      uTint: { value: options.tint ?? 0 },
      uAlphaTest: { value: options.alphaTest ?? 0 },
      uJitterGrid: sharedJitterGrid,
      uJitterStrength: sharedJitterStrength,
      uAffine: sharedAffine,
      uColorLevels: sharedColorLevels,
      uAmbient: { value: options.ambient ?? DEFAULT_AMBIENT },
      uLightDirection: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
    },
  })
}

/**
 * Loads a texture the way the console would have held it: nearest-neighbour
 * magnification, no colour management, no anisotropy.
 *
 * Every one of those is a modern kindness that erases the look. Nearest
 * magnification is the whole point — a texel up close has to be a hard square,
 * not a smear.
 *
 * Minification is the one place that argument does not hold, and `distant`
 * exists for it. The console had no mipmaps, which is exactly why its distant
 * textures shimmered — but it also drew almost nothing beyond fifty metres, so
 * the shimmer had nowhere to happen. An imported circuit is four hundred
 * metres across and rendered into 288 scanlines, which puts dozens of texels
 * inside a single screen pixel: nearest sampling then picks a different one of
 * them every frame, and the road boils. That is not the era's artefact, it is
 * a consequence of asking the era's sampling to cover a distance it never had
 * to. Mipmaps are switched on for those surfaces and stay off for anything
 * close to the camera, where they would cost the hard edges and buy nothing.
 */
export interface Ps1TextureOptions {
  /**
   * True for surfaces that recede into the distance — ground, road, anything
   * that spans the world. Turns on mipmaps, which stops the texture crawling
   * as the camera moves. Leave false for props and cars.
   */
  readonly distant?: boolean
  /**
   * Anisotropic samples, on `distant` surfaces only. See RenderProfile — this
   * is what keeps a mipmapped road from flattening into a wash a few metres
   * ahead of the camera.
   */
  readonly anisotropy?: number
}

export function configurePs1Texture(
  texture: THREE.Texture,
  options: Ps1TextureOptions = {},
): THREE.Texture {
  texture.magFilter = THREE.NearestFilter
  // Nearest *within* a mip level, linear *between* them: the texels stay hard
  // squares at every distance, and what changes smoothly is only which of the
  // pre-averaged levels is being read. Picking NearestMipmapNearest instead
  // trades the boiling for a visible seam where the level flips, which on a
  // road running away from the camera is a band that slides towards you.
  texture.minFilter = options.distant ? THREE.NearestMipmapLinearFilter : THREE.NearestFilter
  texture.generateMipmaps = options.distant === true
  // Only ever on a `distant` surface, and only as much as the circuit's era
  // profile allows. A prop two metres from the lens has nothing to gain from
  // it; a road running to the horizon has everything. See RenderProfile for
  // why this is the one knowingly anachronistic setting in the renderer.
  texture.anisotropy = options.distant ? (options.anisotropy ?? 1) : 1
  texture.colorSpace = THREE.SRGBColorSpace
  // flipY is deliberately left as the loader set it. TextureLoader hands PNGs
  // over with flipY on, which is what the karts' hand-loaded liveries need;
  // GLTFLoader hands textures over with flipY off, because glTF's UV origin
  // is top-left and the geometry is authored against it. This function used
  // to force it on for everyone, and on a tiling grass page nobody could
  // tell — but a game rip's atlases are islands, and flipping the page
  // sampled the dead space between them. Entire mountainsides rendered as
  // the atlas's flat padding colour.
  texture.needsUpdate = true
  return texture
}
