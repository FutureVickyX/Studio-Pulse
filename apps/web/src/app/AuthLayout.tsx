/**
 * The pages outside a workspace (sign-in, onboarding, boot, missing configuration) share the Figma
 * "Sign in" frame: a blurred colour-band hero with the campaign line on the left, the content
 * centred on the right. Below 880 px
 * the hero shrinks to a band above the content.
 */

import type { ReactNode } from 'react';

/** The two blurred blocks of the Figma hero: each band's colour and height (px, of 466.69). */
const BLOCKS: ReadonlyArray<{ key: string; bands: ReadonlyArray<readonly [string, number]> }> = [
  { key: 'top', bands: [['#200925', 235.72], ['#ed0129', 114.53], ['#dfac7d', 114.53]] },
  { key: 'bottom', bands: [['#f6b89a', 150.18], ['#9c8cc9', 114.53], ['#1b1f4b', 201.98]] },
];

export function AuthLayout({ children, align = 'center' }: { children: ReactNode; align?: 'center' | 'top' }) {
  return (
    <div className="web-entry-page">
      <aside className="web-entry-hero">
        <div className="web-entry-hero__glow" aria-hidden="true">
          {BLOCKS.map((block) => (
            <div key={block.key} className={`web-entry-hero__block web-entry-hero__block--${block.key}`}>
              <div className="web-entry-hero__bands">
                {block.bands.map(([colour, height]) => (
                  <span key={colour} className="web-entry-hero__band" style={{ background: colour, flexGrow: height }} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="web-entry-hero__copy">
          Tracker fit for your <span className="web-entry-hero__serif">Workspace</span>
        </p>
      </aside>
      <main className={`web-entry-main web-entry-main--${align}`}>{children}</main>
    </div>
  );
}
