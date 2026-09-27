'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuthActions } from '@convex-dev/auth/react'
import { normaliseLoginCode } from '@/lib/loginCode'
import { ARCADE, FONTS, UI_TYPE } from '../leon/ps1/theme'

// The link the reporter opens. One job: turn the code in the address into a
// session, then go to the cabinet. If the code is stale it says so and
// offers the way to a fresh one, which is the same command that made this.

type Stage = 'signing' | 'done' | 'failed' | 'missing'

const REDIRECT_DELAY_MS = 600

function LoginBody(): React.ReactElement {
  const params = useSearchParams()
  const router = useRouter()
  const { signIn } = useAuthActions()
  const [stage, setStage] = useState<Stage>('signing')
  const code = normaliseLoginCode(params.get('code') ?? '')

  useEffect(() => {
    if (!code) {
      setStage('missing')
      return
    }
    let cancelled = false
    signIn('device-link', { code })
      // A refused code does NOT reject: Convex Auth resolves with
      // `signingIn: false` and leaves the session alone. Reading only the
      // rejection would call every expired code a success and drop the
      // person at the cabinet, signed out, with nothing said.
      .then((result) => {
        if (cancelled) return
        if (!result.signingIn) {
          setStage('failed')
          return
        }
        setStage('done')
        setTimeout(() => router.replace('/'), REDIRECT_DELAY_MS)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        console.error('Device link sign-in failed', cause)
        setStage('failed')
      })
    return () => {
      cancelled = true
    }
  }, [code, signIn, router])

  const copy: Readonly<Record<Stage, { title: string; detail: string }>> = {
    signing: { title: 'Signing you in', detail: 'One moment.' },
    done: { title: 'Signed in', detail: 'Taking you to the cabinet.' },
    failed: {
      title: 'That code has expired',
      detail: 'Codes last ten minutes and work once. Run `bun login` from the reporter folder for a fresh one.',
    },
    missing: { title: 'No code', detail: 'Run `bun login` from the reporter folder; it opens this page with one.' },
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: ARCADE.ground,
        color: ARCADE.value,
        fontFamily: FONTS.body,
        padding: '24px',
      }}
    >
      <div style={{ maxWidth: '520px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: `inset 0 0 0 2px ${ARCADE.rule}`, padding: '28px 32px' }}>
        <span className="gt-label" style={{ fontSize: `${UI_TYPE.title}px`, letterSpacing: '0.12em', color: stage === 'failed' ? ARCADE.label : ARCADE.amber }}>
          {copy[stage].title}
        </span>
        <span style={{ fontSize: `${UI_TYPE.prose}px`, lineHeight: 1.6, color: ARCADE.silver }}>{copy[stage].detail}</span>
        {stage !== 'signing' && (
          <a href="/" style={{ fontSize: `${UI_TYPE.body}px`, color: ARCADE.value, textDecoration: 'underline', textUnderlineOffset: '4px' }}>
            Back to the cabinet
          </a>
        )}
      </div>
    </main>
  )
}

export default function LoginPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <LoginBody />
    </Suspense>
  )
}
