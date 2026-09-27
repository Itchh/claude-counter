'use client'

// The cobalt cross: four arrows around a steel hub, each a real button.
// Drawn by the .grg-* classes in styles.ts, so it is the same d-pad on
// every select screen the cabinet has.

const DPAD_PX = 100
const HUB_PX = 42
const ARROW_HIT_PX = 30

export interface DPadLabels {
  readonly left: string
  readonly right: string
  readonly up: string
  readonly down: string
}

interface DPadProps {
  readonly labels: DPadLabels
  readonly onLeft: () => void
  readonly onRight: () => void
  readonly onUp: () => void
  readonly onDown: () => void
}

export function DPad({ labels, onLeft, onRight, onUp, onDown }: DPadProps): React.ReactElement {
  const hit = { width: `${ARROW_HIT_PX}px`, height: `${ARROW_HIT_PX}px` } as const
  return (
    <div style={{ position: 'relative', width: `${DPAD_PX}px`, height: `${DPAD_PX}px`, flex: '0 0 auto' }}>
      <div
        className="grg-hub"
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: `${HUB_PX}px`,
          height: `${HUB_PX}px`,
          transform: 'translate(-50%, -50%)',
        }}
      />
      <button
        type="button"
        aria-label={labels.left}
        className="grg-arrow grg-arrow-left"
        style={{ ...hit, left: 0, top: '50%', transform: 'translateY(-50%)' }}
        onClick={onLeft}
      />
      <button
        type="button"
        aria-label={labels.right}
        className="grg-arrow grg-arrow-right"
        style={{ ...hit, right: 0, top: '50%', transform: 'translateY(-50%)' }}
        onClick={onRight}
      />
      <button
        type="button"
        aria-label={labels.up}
        className="grg-arrow grg-arrow-up"
        style={{ ...hit, top: 0, left: '50%', transform: 'translateX(-50%)' }}
        onClick={onUp}
      />
      <button
        type="button"
        aria-label={labels.down}
        className="grg-arrow grg-arrow-down"
        style={{ ...hit, bottom: 0, left: '50%', transform: 'translateX(-50%)' }}
        onClick={onDown}
      />
    </div>
  )
}
