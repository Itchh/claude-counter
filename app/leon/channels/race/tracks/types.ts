import type * as THREE from 'three'

// What the channel needs to know about a circuit.
//
// Split deliberately in two. The geometric half — control points, road width,
// bounds — is *derived* by `scripts/bakeTrack.mjs` from the model itself and
// arrives as generated JSON; nobody should be typing those numbers, and when
// the trace gets a corner wrong the fix is to edit the JSON, not the registry.
// The art-directed half — palette, fog, which shots suit the place — is
// judgement, and lives in `registry.ts` where it can be argued with.

/** The generated half. Written by the bake script; editable by hand after. */
export interface BakedTrack {
  readonly slug: string
  readonly source: string
  readonly roadMaterial: string
  /** Closed loop, in game units, already centred on the world origin. */
  readonly controlPoints: ReadonlyArray<ReadonlyArray<number>>
  readonly roadHalfWidth: number
  readonly bounds: {
    readonly minX: number
    readonly maxX: number
    readonly minZ: number
    readonly maxZ: number
  }
  /** Distance from the origin to the furthest geometry, on the XZ plane. */
  readonly modelRadius: number
  readonly materials: ReadonlyArray<string>
  readonly baked: {
    readonly triangles: number
    readonly sourceTriangles: number
    readonly scaleApplied: number
    readonly sourceRoadHalfWidth: number
  }
}

/**
 * How one of the model's own materials should be rebuilt as a PS1 surface.
 *
 * Keyed by the material name the source model shipped with, because that is
 * the only handle a downloaded asset gives you. A track whose author called
 * the road `Tarmac02` needs a line here saying so; there is no way around
 * that, and pretending otherwise would mean guessing.
 */
export interface TrackSurface {
  /** Flat colour, or the tint pulled over a texture. */
  readonly color?: string
  /** How far a textured surface is pulled towards `color`, 0..1. */
  readonly tint?: number
  /** 1 removes the surface from the lighting model entirely. */
  readonly ambient?: number
  /** Lifts a surface out of shading — lamps, kerbs, marker boards. */
  readonly emissive?: number
  /** Set for anything the camera can end up behind, like foliage cards. */
  readonly doubleSided?: boolean
  /**
   * Alpha below which a textured fragment is discarded, 0..1.
   *
   * Required for anything the source model drew as a cut-out card — foliage
   * atlases, chain-link fencing, signage. A glTF says so in `alphaMode: MASK`,
   * but that describes a blending model the PS1 shader does not implement, so
   * the threshold is restated here as a deliberate choice per surface.
   */
  readonly alphaTest?: number
  /**
   * Mipmap this surface's texture. Set for anything that runs away from the
   * camera — see `distant` in configurePs1Texture. Off by default, because on
   * a prop within a few metres of the lens it costs the hard texel edges and
   * fixes nothing.
   */
  readonly distant?: boolean
  /**
   * Vertical offset in game units, for surfaces the source model left lying
   * on top of each other.
   *
   * A downloaded circuit has its terrain and its tarmac at the same height,
   * and its painted lines at the same height again — which is correct in a
   * modelling package and unrenderable on a depth buffer. Whichever surface
   * wins is decided per pixel by rounding error, so the track strobes between
   * road and grass as the camera moves. Separating them by a few centimetres
   * costs nothing and is what every game of the era did.
   */
  readonly lift?: number
  /** Drop the surface entirely. For sky domes and other things we replace. */
  readonly hidden?: boolean
}

export interface TrackDefinition {
  readonly slug: string
  /** Shown on the HUD. The circuit's name, not the file's. */
  readonly title: string
  /** Baked model under `/ps1/tracks`, or null for the procedural circuit. */
  readonly model: string | null
  readonly controlPoints: ReadonlyArray<readonly [number, number, number]>
  readonly roadHalfWidth: number
  readonly laneCount: number
  /**
   * Catmull-Rom tension. 0.5 is the centripetal default and is right for a
   * traced line; lower it towards 0 if a tight hairpin overshoots the tarmac.
   */
  readonly curveTension: number
  /**
   * Scatter barriers and props from the spline. Off for imported circuits —
   * they arrive with their own trackside, and doubling it puts oil drums
   * through the grandstand.
   */
  readonly proceduralScenery: boolean
  /**
   * Where geometry starts dissolving into the sky, in game units. Scaled to
   * the circuit: 165 hides nothing on a 70-unit oval and hides the far half
   * of a 340-unit road course.
   */
  readonly fog: { readonly near: number; readonly far: number }
  /** Which console's picture this circuit is rendered as. */
  readonly render: RenderProfile
  /**
   * The painted backdrop, and with it the whole time of day.
   *
   * Four gradient stops, exactly the shape the original hard-coded dusk had.
   * The fog takes `mid` as its colour, which is the invariant that makes the
   * trick work at all: geometry dissolves *into the sky*, so the two must be
   * the same paint. A circuit is bright or moody by choosing its sky, not by
   * pushing its materials around — the reference racers of the era were
   * daylight games, and daylight is a sky colour before it is anything else.
   */
  readonly sky: TrackSky
  /** Per-material treatment, keyed by the model's own material names. */
  readonly surfaces: Readonly<Record<string, TrackSurface>>
  /**
   * Treatment for every material `surfaces` does not name.
   *
   * A marketplace model has five nameable materials; a game rip has a
   * hundred called `material_124_63`, chunked by world position rather than
   * by substance, and naming them one by one would be transcription, not art
   * direction. The rip keeps its own colours and pages — that is the whole
   * point of using it — and this default is the light glaze that sits all of
   * them in the channel's air. Anything not covered here is read off the
   * source material itself: its alpha mask, its sidedness, its base colour.
   */
  readonly surfaceDefaults?: TrackSurface
}

/**
 * A console's picture, as the four numbers that actually distinguish one from
 * the next.
 *
 * Worth being clear about what is *not* in here: Gouraud vertex lighting, flat
 * cut-out transparency and universal distance fog stay switched on for both,
 * because those are what make either of these a console racer rather than a
 * modern renderer with the saturation turned up. What changed between the two
 * machines is precision, and precision is all this describes.
 */
export interface RenderProfile {
  /**
   * How hard vertices snap to the framebuffer grid, 0..1.
   *
   * The wobble, and the single most recognisable thing about the earlier
   * hardware — its transform unit had no sub-pixel precision. The later one
   * did, so this is zero for it. It is also a *screen-space* effect of fixed
   * size, which is why even on the earlier profile a large circuit has to back
   * it off: a vertex 300 units away lurches as far across the picture as one
   * at 30, and most of the frame turns to noise.
   */
  readonly jitter: number
  /**
   * How much of the affine texture warp to keep, 0..1.
   *
   * The earlier console interpolated across a triangle in screen space with no
   * perspective divide, so a surface angled away from the camera visibly bends
   * along the diagonal it was split on. The later one interpolated correctly.
   */
  readonly affine: number
  /**
   * Levels per colour channel in the output. 31 is a 15-bit framebuffer and
   * the source of the era's banding; 255 is the later machine's full depth.
   */
  readonly colourLevels: number
  /**
   * Anisotropic samples on surfaces marked `distant`, 1 to disable.
   *
   * The one setting here that is not period-accurate, and it is here because
   * the alternative was worse. Mipmaps are what stopped the ground boiling as
   * the camera moved, but a road receding towards the horizon changes its UVs
   * far faster along one screen axis than the other, and an isotropic mip
   * level has to be chosen for the worse of the two — so the whole surface
   * drops to a level that has averaged the tarmac into a flat wash a few
   * metres from the bumper. Everything the texture said is gone, and the
   * circuit looks untextured rather than old.
   *
   * Anisotropy is the specific cure: it samples along the direction the
   * surface is actually stretched. Neither console had it. Set it to 1 and the
   * picture becomes strictly more faithful and considerably less legible; the
   * trade is stated here rather than buried so it can be taken back.
   */
  readonly anisotropy: number
  /**
   * Height of the framebuffer the scene is actually rendered into, in pixels,
   * before the browser scales it up. The pixel grid.
   *
   * 240 and 448 are the two machines' own progressive-scan heights, and the
   * difference is not only period detail: at 240 a kart on the far side of a
   * 450-unit circuit is two pixels and simply cannot be seen, which on a
   * leaderboard is the whole point of the channel failing.
   */
  readonly internalHeight: number
}

/** The two consoles, as the channel renders them. */
export const RENDER_PROFILES = {
  ps1: { jitter: 1, affine: 1, colourLevels: 31, anisotropy: 1, internalHeight: 288 },
  ps2: { jitter: 0, affine: 0, colourLevels: 255, anisotropy: 8, internalHeight: 448 },
} as const satisfies Record<string, RenderProfile>

export interface TrackSky {
  /** Top of frame. */
  readonly high: string
  /** Mid sky, and the fog colour — see the `sky` field's invariant. */
  readonly mid: string
  /** The band sitting on the horizon line. */
  readonly horizon: string
  /** Sun glow, painted as a radial splash at the horizon. */
  readonly glow: string
  /**
   * Strength of the scanline dither laid over the backdrop, 0..1.
   *
   * The dusk needs it — a 15-bit twilight gradient cannot hold together
   * without being broken up — but the same 22% black lines over a daylight
   * sky read as a failing monitor rather than as a console. Bright skies
   * carry a trace of it for texture and no more.
   */
  readonly dither: number
}

export interface TrackFrame {
  readonly position: THREE.Vector3
  readonly tangent: THREE.Vector3
  readonly normal: THREE.Vector3
}
