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
  // Object space, untouched. The liveries are painted in the car's own
  // coordinates rather than in its UVs, so a pattern wraps the bodywork the
  // way paint does instead of following whatever seams the model was
  // unwrapped along.
  varying vec3 vLocal;

  void main() {
    vLocal = position;
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
  /** 1 lets the page's own alpha through to the framebuffer. */
  uniform float uBlend;
  /** 1 undoes perspective correction entirely; 0 leaves it alone. */
  uniform float uAffine;
  /** Levels per channel in the output. 31 is a 15-bit framebuffer. */
  uniform float uColorLevels;
  /** Which livery to paint on. 0 is bare paint. See lib/livery.ts. */
  uniform float uLivery;
  /** The driver's own colour, which every pattern's tones are mixed from. */
  uniform vec3 uPaint;
  /** The body's bounding box, so a pattern lands the same on every chassis. */
  uniform vec3 uBodyMin;
  uniform vec3 uBodySize;
  /** How far the page is repainted in uPaint, 0..1. */
  uniform float uPaintMix;

  varying vec3 vColor;
  varying float vFogDepth;
  varying vec2 vUv;
  varying float vAffineW;
  varying vec3 vColorLinear;
  varying float vFogDepthLinear;
  varying vec2 vUvLinear;
  varying vec3 vLocal;

  vec3 quantizeOutput(vec3 color) {
    return floor(color * uColorLevels + 0.5) / uColorLevels;
  }

  /**
   * The livery.
   *
   * Every pattern is a hard-edged mask over the car's own normalised box —
   * t runs tail to nose, h sits on the ground and rises to the roof, w
   * crosses it. Working in object space rather than UV space is what lets one
   * set of patterns serve eight different chassis with eight different
   * unwraps, and it is also why a stripe carries across the nose and over the
   * roof rather than stopping at a seam: a curtain through the solid cuts the
   * bodywork wherever the bodywork happens to be.
   *
   * Four tones only, mixed from the driver's paint so a pattern can never
   * fight the colour it is painted over. Nothing here is anti-aliased; the
   * console had no edge it could soften and neither has this.
   */
  vec4 liveryDecal() {
    if (uLivery < 0.5) return vec4(0.0);

    vec3 n = (vLocal - uBodyMin) / max(uBodySize, vec3(0.0001));
    float t = clamp(n.z, 0.0, 1.0);
    float h = clamp(n.y, 0.0, 1.0);
    float w = clamp(n.x, 0.0, 1.0);

    vec3 light = mix(uPaint, vec3(1.0), 0.62);
    vec3 dark = uPaint * 0.34;
    vec3 white = vec3(0.94);
    vec3 ink = vec3(0.05);

    if (uLivery < 1.5) {
      // Twin stripe: a thick band with a thin one riding above it.
      if (h > 0.30 && h < 0.385) return vec4(light, 1.0);
      if (h > 0.405 && h < 0.44) return vec4(light, 1.0);
      return vec4(0.0);
    }
    if (uLivery < 2.5) {
      // Bolt: a chevron that drops towards the nose, shadowed underneath.
      float edge = 0.46 - 0.26 * t;
      if (h > edge && h < edge + 0.11) return vec4(light, 1.0);
      if (h > edge - 0.055 && h <= edge) return vec4(dark, 1.0);
      return vec4(0.0);
    }
    if (uLivery < 3.5) {
      // Check: two rows of chequer through the waist.
      if (h < 0.26 || h > 0.44) return vec4(0.0);
      float cell = mod(floor(t * 18.0) + floor((h - 0.26) * 22.0), 2.0);
      return cell < 0.5 ? vec4(white, 1.0) : vec4(0.0);
    }
    if (uLivery < 4.5) {
      // Split: the nose taken in the light tone, on a hard diagonal.
      if (t > 0.58 + h * 0.16) return vec4(light, 1.0);
      if (t > 0.54 + h * 0.16) return vec4(ink, 1.0);
      return vec4(0.0);
    }
    if (uLivery < 5.5) {
      // Roundel: a door plate, with a rule running fore and aft of it.
      vec2 d = vec2((t - 0.46) * 1.6, h - 0.40);
      if (dot(d, d) < 0.0125) return vec4(white, 1.0);
      if (h > 0.30 && h < 0.325 && (t < 0.34 || t > 0.58)) return vec4(dark, 1.0);
      return vec4(0.0);
    }
    if (uLivery < 6.5) {
      // Pinstripe: two hairlines high on the flank, one light one below.
      if (h > 0.505 && h < 0.522) return vec4(ink, 1.0);
      if (h > 0.478 && h < 0.495) return vec4(ink, 1.0);
      if (h > 0.30 && h < 0.318) return vec4(light, 1.0);
      return vec4(0.0);
    }
    if (uLivery < 7.5) {
      // Blocks: six of them, stepping up towards the tail.
      float column = floor(t * 6.0);
      float base = 0.22 + column * 0.035;
      if (mod(t * 6.0, 1.0) > 0.72) return vec4(0.0);
      if (h > base && h < base + 0.075) {
        return mod(column, 2.0) < 0.5 ? vec4(light, 1.0) : vec4(ink, 1.0);
      }
      return vec4(0.0);
    }
    // Spine: over the roof, nose to tail. The pattern that only makes sense
    // in three dimensions, and the reason the paint shop turns the car.
    if (abs(w - 0.5) < 0.085 && h > 0.30) return vec4(light, 1.0);
    if (abs(w - 0.5) < 0.115 && h > 0.30) return vec4(dark, 1.0);
    return vec4(0.0);
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

    // Repainting, for a car whose driver has chosen a colour.
    //
    // A multiply tint was the first attempt and it does not work: multiplying
    // a dark blue page by cyan gives a darker blue-grey, so eight bright
    // paints arrived on screen as eight shades of the page. This keeps the
    // page's own luminance — every shut line, lamp and painted-in shadow
    // survives as a light or dark version of the new colour — and takes the
    // hue from the driver. Which is what a respray is.
    float luma = dot(sampled, vec3(0.299, 0.587, 0.114));
    vec3 repainted = uPaint * clamp(luma * 1.7, 0.0, 1.35);
    sampled = mix(sampled, repainted, uPaintMix);
    vec3 base = mix(uColor, sampled, uUseMap);

    // The livery goes on over the paint and under the lighting, which is
    // where paint sits on a real car: it takes the same shade, the same fog
    // and the same 15-bit quantisation as the panel beneath it.
    vec4 decal = liveryDecal();
    base = mix(base, decal.rgb, decal.a);

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
    // Opaque unless the surface asked otherwise. uBlend is the one concession
    // to a source asset that draws its foliage with real transparency: the
    // console's own answer was a dither mask, but a downloaded circuit's
    // pages are authored with soft edges and masking them alone leaves the
    // half-transparent parts of a leaf card standing as solid slabs.
    gl_FragColor = vec4(fogged, mix(1.0, texel.a, uBlend * uUseMap));

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
   * Let the page's own alpha reach the framebuffer, rather than cutting the
   * fragment out and drawing the rest solid.
   *
   * Reserved for surfaces a downloaded model declares as blended — modern
   * foliage is drawn with soft edges, and a threshold alone turns the soft
   * half of every leaf card into a slab. It costs depth writes, so the
   * surface no longer occludes correctly; that is why it is opt-in per
   * material rather than a mode the whole scene runs in.
   */
  readonly blend?: boolean
  /**
   * How far a textured surface is pulled towards `color`, 0..1. The cars
   * carry their own liveries, so this stays low: enough that a driver's
   * colour is findable on the track, not so much that the paintwork goes.
   */
  readonly tint?: number
  readonly ambient?: number
  readonly side?: THREE.Side
  /**
   * Paint a livery on this surface, in the car's own object space.
   *
   * Only the car bodies pass one. `bounds` is the body geometry's own
   * bounding box — passed in rather than assumed, because the pack's chassis
   * are different sizes and a pattern measured against the wrong box slides
   * off the back of the shorter ones.
   */
  readonly livery?: {
    readonly pattern: number
    readonly paint: THREE.ColorRepresentation
    readonly bounds: THREE.Box3
    /**
     * How far the page is repainted in `paint`, 0..1. Zero leaves the pack's
     * own paint job exactly as the artist mixed it, which is where every car
     * starts and where it stays until someone opens the paint shop.
     */
    readonly paintStrength?: number
  }
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
    transparent: options.blend === true,
    // A blended surface must not write depth, or the first card drawn paints
    // a hole in everything behind it. Three sorts these back to front for us,
    // which is as close to correct as an unsorted era ever got.
    depthWrite: options.blend !== true,
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
      uBlend: { value: options.blend ? 1 : 0 },
      uJitterGrid: sharedJitterGrid,
      uJitterStrength: sharedJitterStrength,
      uAffine: sharedAffine,
      uColorLevels: sharedColorLevels,
      uLivery: { value: options.livery?.pattern ?? 0 },
      uPaintMix: { value: options.livery?.paintStrength ?? 0 },
      uPaint: { value: new THREE.Color(options.livery?.paint ?? '#ffffff') },
      uBodyMin: {
        value: options.livery ? options.livery.bounds.min.clone() : new THREE.Vector3(0, 0, 0),
      },
      uBodySize: {
        value: options.livery
          ? options.livery.bounds.getSize(new THREE.Vector3())
          : new THREE.Vector3(1, 1, 1),
      },
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
